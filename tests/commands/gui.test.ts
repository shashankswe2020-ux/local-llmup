import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { runGui, type GuiDeps } from "../../src/commands/gui.js";
import { createDefaultRegistry } from "../../src/harness/registry.js";

interface FakeServer {
  readonly url: string;
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  once(event: string, listener: (error?: Error) => void): void;
  removeListener(event: string, listener: (error?: Error) => void): void;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: () => void): void;
}

function createDeps(): GuiDeps {
  const output: string[] = [];
  const server: FakeServer = {
    url: "http://127.0.0.1:4000",
    async start(port: number): Promise<number> {
      return port;
    },
    async stop(): Promise<void> {
      return;
    },
    once: vi.fn(),
    removeListener: vi.fn(),
    listen: vi.fn((_port, _host, callback) => callback()),
    close: vi.fn((callback) => callback()),
  };

  return {
    registry: createDefaultRegistry(),
    createServer: () => server,
    openUrl: vi.fn(),
    waitForShutdown: vi.fn(async () => undefined),
    write: (text) => output.push(text),
    log: vi.fn(),
    env: { LOCAL_LLMUP_HARNESS: "local" },
  };
}

describe("runGui", () => {
  it("starts the browser GUI and prints JSON metadata", async () => {
    const output: string[] = [];
    const server: FakeServer = {
      url: "http://127.0.0.1:4000",
      async start(port: number): Promise<number> {
        return port;
      },
      async stop(): Promise<void> {
        return;
      },
      once: vi.fn(),
      removeListener: vi.fn(),
      listen: vi.fn((_port, _host, callback) => callback()),
      close: vi.fn((callback) => callback()),
    };
    const deps: GuiDeps = {
      registry: createDefaultRegistry(),
      createServer: () => server,
      openUrl: vi.fn(),
      waitForShutdown: vi.fn(async () => undefined),
      write: (text) => output.push(text),
      log: vi.fn(),
      env: { LOCAL_LLMUP_HARNESS: "local" },
    };

    const outcome = await runGui({ port: 4000, harness: "local", noOpen: true, json: true }, deps);

    expect(outcome).toMatchObject({ url: "http://127.0.0.1:4000", harness: "local", port: 4000 });
    expect(JSON.parse(output[0] ?? "").url).toBe("http://127.0.0.1:4000");
  });

  it("rejects invalid ports and unknown harness names", async () => {
    const deps = createDeps();

    await expect(runGui({ port: 0, harness: "local", noOpen: true }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(runGui({ port: 4000, harness: "missing", noOpen: true }, deps)).rejects.toBeInstanceOf(ValidationError);
  });

  it("passes a model manager to the GUI server", async () => {
    const deps = createDeps();
    const modelManager = {
      recommended: vi.fn(async () => []),
      runtimes: vi.fn(() => ["ollama", "llamacpp", "mlx", "lmstudio"]),
      active: vi.fn(() => null),
      up: vi.fn(async () => {
        throw new Error("unused");
      }),
    };
    let receivedManager: unknown = "unset";
    const createGuiServer: NonNullable<GuiDeps["createGuiServer"]> = (opts) => {
      receivedManager = opts.modelManager;
      return {
        session: { activeHarnessName: "local" },
        url: "http://127.0.0.1:4000",
        port: 4000,
        start: vi.fn(async () => 4000),
        stop: vi.fn(async () => undefined),
      };
    };

    await runGui({ port: 4000, harness: "local", noOpen: true, json: true }, { ...deps, modelManager, createGuiServer });

    expect(receivedManager).toBe(modelManager);
  });
});
