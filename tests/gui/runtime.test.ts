import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { GuiServer } from "../../src/gui/server.js";
import { createRuntimeController, type RuntimeController } from "../../src/gui/runtime.js";
import type { BackendAdapter, ServeHandle } from "../../src/backend/adapter.js";
import type { BackendRegistry } from "../../src/backend/registry.js";
import type { BackendName } from "../../src/types.js";

interface FakeState {
  running: boolean;
  installed: boolean;
}

function fakeAdapter(
  name: BackendName,
  state: FakeState,
  overrides: Partial<BackendAdapter> = {},
): BackendAdapter {
  const port = name === "ollama" ? 11434 : 8080;
  const handle: ServeHandle = {
    endpoint: `http://127.0.0.1:${port}`,
    pid: 4242,
    port,
    ownedByUs: true,
  };
  const base = {
    name,
    capabilities: {
      canPull: name === "ollama",
      canEmbed: false,
      embeddingOffload: "unknown",
      openAiCompatible: true,
      formats: [],
      defaultPort: port,
    },
    isInstalled: vi.fn(async () => state.installed),
    installHint: () => "install it",
    pull: vi.fn(async () => ({ modelId: name, digestVerified: true })),
    serve: vi.fn(async () => {
      state.running = true;
      return handle;
    }),
    waitUntilReady: vi.fn(async () => {
      if (!state.running) {
        throw new Error("not ready");
      }
    }),
    stop: vi.fn(async () => {
      state.running = false;
    }),
    chat: vi.fn(async () => ({ content: "" })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    ...overrides,
  };
  return base as unknown as BackendAdapter;
}

function fakeRegistry(adapters: readonly BackendAdapter[]): BackendRegistry {
  const byName = new Map(adapters.map((a) => [a.name, a]));
  return {
    all: () => adapters,
    get: (name: string) => {
      const adapter = byName.get(name as BackendName);
      if (!adapter) {
        throw new ValidationError(`unknown backend: ${name}`);
      }
      return adapter;
    },
    available: async () => adapters,
  };
}

describe("createRuntimeController", () => {
  it("reports a stopped, installed daemon as startable but not running", async () => {
    const state: FakeState = { running: false, installed: true };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("ollama", state)]));
    const [ollama] = await controller.list();
    expect(ollama?.name).toBe("ollama");
    expect(ollama?.installed).toBe(true);
    expect(ollama?.running).toBe(false);
    expect(ollama?.canStart).toBe(true);
  });

  it("reports a not-installed runtime with no endpoint and no start", async () => {
    const state: FakeState = { running: false, installed: false };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("ollama", state)]));
    const [ollama] = await controller.list();
    expect(ollama?.installed).toBe(false);
    expect(ollama?.running).toBe(false);
    expect(ollama?.canStart).toBe(false);
    expect(ollama?.endpoint).toBeNull();
  });

  it("marks a per-model runtime as not startable with an explanatory detail", async () => {
    const state: FakeState = { running: false, installed: true };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("llamacpp", state)]));
    const [llamacpp] = await controller.list();
    expect(llamacpp?.installed).toBe(true);
    expect(llamacpp?.canStart).toBe(false);
    expect(llamacpp?.detail).toContain("per model");
  });

  it("reports an externally running daemon as running but not owned", async () => {
    const state: FakeState = { running: true, installed: true };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("ollama", state)]));
    const [ollama] = await controller.list();
    expect(ollama?.running).toBe(true);
    expect(ollama?.ownedByUs).toBe(false);
    expect(ollama?.canStop).toBe(true);
    expect(ollama?.detail).toContain("outside");
  });

  it("starts a daemon runtime and tracks the owned handle", async () => {
    const state: FakeState = { running: false, installed: true };
    const adapter = fakeAdapter("ollama", state);
    const controller = createRuntimeController(fakeRegistry([adapter]));

    const view = await controller.start("ollama");
    expect(adapter.serve).toHaveBeenCalledOnce();
    expect(adapter.waitUntilReady).toHaveBeenCalled();
    expect(view.running).toBe(true);
    expect(view.ownedByUs).toBe(true);
  });

  it("refuses to start a per-model runtime", async () => {
    const state: FakeState = { running: false, installed: true };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("mlx", state)]));
    await expect(controller.start("mlx")).rejects.toThrow(ValidationError);
  });

  it("refuses to start an unknown runtime", async () => {
    const state: FakeState = { running: false, installed: true };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("ollama", state)]));
    await expect(controller.start("bogus")).rejects.toThrow(ValidationError);
  });

  it("refuses to start a runtime that is not installed", async () => {
    const state: FakeState = { running: false, installed: false };
    const controller = createRuntimeController(fakeRegistry([fakeAdapter("ollama", state)]));
    await expect(controller.start("ollama")).rejects.toThrow(ValidationError);
  });

  it("stops a daemon it started and reports it stopped afterwards", async () => {
    const state: FakeState = { running: false, installed: true };
    const adapter = fakeAdapter("ollama", state);
    const controller = createRuntimeController(fakeRegistry([adapter]));

    await controller.start("ollama");
    const view = await controller.stop("ollama");
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(view.running).toBe(false);
    expect(view.ownedByUs).toBe(false);
  });

  it("stops an externally started daemon by attaching then stopping it", async () => {
    const state: FakeState = { running: true, installed: true };
    const foreignHandle: ServeHandle = {
      endpoint: "http://127.0.0.1:11434",
      pid: 999,
      port: 11434,
      ownedByUs: false,
    };
    const serve = vi.fn(async () => foreignHandle);
    const stop = vi.fn(async () => {
      state.running = false;
    });
    const adapter = fakeAdapter("ollama", state, { serve, stop });
    const controller = createRuntimeController(fakeRegistry([adapter]));

    const view = await controller.stop("ollama");
    expect(serve).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(foreignHandle, { allowForeign: true });
    expect(view.running).toBe(false);
  });

  it("does not attach to or signal a per-model runtime on stop", async () => {
    const state: FakeState = { running: true, installed: true };
    const adapter = fakeAdapter("llamacpp", state);
    const controller = createRuntimeController(fakeRegistry([adapter]));

    await controller.stop("llamacpp");
    expect(adapter.serve).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it("tears down owned daemons on shutdown", async () => {
    const state: FakeState = { running: false, installed: true };
    const adapter = fakeAdapter("ollama", state);
    const controller = createRuntimeController(fakeRegistry([adapter]));

    await controller.start("ollama");
    await controller.shutdown();
    expect(adapter.stop).toHaveBeenCalledOnce();
  });
});

async function call(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Host: `127.0.0.1:${port}` },
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

describe("GuiServer hardware + runtime routes", () => {
  const servers: GuiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  });

  function fakeController(overrides: Partial<RuntimeController> = {}): RuntimeController {
    return {
      list: vi.fn(async () => [
        {
          name: "ollama" as BackendName,
          installed: true,
          running: false,
          ownedByUs: false,
          endpoint: "http://127.0.0.1:11434",
          canStart: true,
          canStop: false,
        },
      ]),
      start: vi.fn(async () => ({
        name: "ollama" as BackendName,
        installed: true,
        running: true,
        ownedByUs: true,
        endpoint: "http://127.0.0.1:11434",
        canStart: true,
        canStop: true,
      })),
      stop: vi.fn(async () => ({
        name: "ollama" as BackendName,
        installed: true,
        running: false,
        ownedByUs: false,
        endpoint: "http://127.0.0.1:11434",
        canStart: true,
        canStop: false,
      })),
      shutdown: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  async function startWith(options: {
    runtimeController?: RuntimeController;
    hardwareProvider?: () => Promise<import("../../src/types.js").HardwareProfile>;
  }): Promise<number> {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      ...options,
    });
    servers.push(server);
    return server.start(0);
  }

  it("returns a hardware summary", async () => {
    const port = await startWith({
      hardwareProvider: async () => ({
        arch: "arm64",
        platform: "darwin",
        totalRamBytes: 32 * 1024 ** 3,
        freeRamBytes: 12 * 1024 ** 3,
        gpu: [{ vendor: "apple", vramBytes: 0 }],
        freeDiskBytes: 200 * 1024 ** 3,
      }),
    });
    const { status, json } = await call(port, "GET", "/api/hardware");
    expect(status).toBe(200);
    const hardware = json.hardware as Record<string, unknown>;
    expect(hardware.platform).toBe("darwin");
    expect(hardware.arch).toBe("arm64");
    expect(hardware.totalRamBytes).toBe(32 * 1024 ** 3);
  });

  it("lists runtime status", async () => {
    const controller = fakeController();
    const port = await startWith({ runtimeController: controller });
    const { status, json } = await call(port, "GET", "/api/runtimes/status");
    expect(status).toBe(200);
    expect(Array.isArray(json.runtimes)).toBe(true);
    expect(controller.list).toHaveBeenCalledOnce();
  });

  it("starts and stops a runtime by name", async () => {
    const controller = fakeController();
    const port = await startWith({ runtimeController: controller });

    const started = await call(port, "POST", "/api/runtimes/ollama/start");
    expect(started.status).toBe(200);
    expect(controller.start).toHaveBeenCalledWith("ollama");

    const stopped = await call(port, "POST", "/api/runtimes/ollama/stop");
    expect(stopped.status).toBe(200);
    expect(controller.stop).toHaveBeenCalledWith("ollama");
  });

  it("maps a runtime start ValidationError to 400", async () => {
    const controller = fakeController({
      start: vi.fn(async () => {
        throw new ValidationError("mlx runs per model");
      }),
    });
    const port = await startWith({ runtimeController: controller });
    const { status, json } = await call(port, "POST", "/api/runtimes/mlx/start");
    expect(status).toBe(400);
    expect(String(json.error)).toContain("per model");
  });

  it("rejects a non-POST on the start route with 404", async () => {
    const controller = fakeController();
    const port = await startWith({ runtimeController: controller });
    const { status } = await call(port, "GET", "/api/runtimes/ollama/start");
    expect(status).toBe(404);
  });

  it("rejects a non-GET on the status route with 405", async () => {
    const controller = fakeController();
    const port = await startWith({ runtimeController: controller });
    const { status } = await call(port, "POST", "/api/runtimes/status");
    expect(status).toBe(405);
  });

  it("returns 400 when no runtime controller is configured", async () => {
    const port = await startWith({});
    const { status } = await call(port, "GET", "/api/runtimes/status");
    expect(status).toBe(400);
  });
});
