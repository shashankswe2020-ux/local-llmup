import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { BackendError, ValidationError } from "../../src/errors.js";
import { readState, STATE_SCHEMA_VERSION, withLock, writeState } from "../../src/state/state.js";
import {
  executePreparedSwitch,
  prepareSwitch,
  runSwitch,
  type SwitchDeps,
} from "../../src/commands/switch.js";
import {
  captureLiveProcessIdentity,
  ConfirmationDriftError,
} from "../../src/tui/snapshots.js";
import { createRegistry } from "../../src/backend/registry.js";
import type {
  BackendAdapter,
  PullOptions,
  PullResult,
  ReadinessOptions,
} from "../../src/backend/adapter.js";
import type { Catalog, CatalogModel, Quantization } from "../../src/types.js";
import {
  expectNoninteractiveGolden,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";

function quant(name: string, overrides: Partial<Quantization> = {}): Quantization {
  return {
    name,
    diskBytes: 5_000_000_000,
    minRamBytes: 6_000_000_000,
    minVramBytes: 6_000_000_000,
    ...overrides,
  };
}

function model(id: string, quants: readonly Quantization[] = [quant("Q4_K_M")]): CatalogModel {
  return {
    id,
    family: id.split(":")[0]!,
    params: "8B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 8192,
    capabilities: ["chat"],
    releaseDate: "2025-06-01",
    source: { ollama: id },
    quantizations: quants,
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

interface FakeAdapter extends BackendAdapter {
  readonly pullArgs: PullOptions[];
  readonly readyArgs: ReadinessOptions[];
  pullError?: Error;
  readyError?: Error;
}

function fakeAdapter(
  options: {
    name?: "ollama" | "llamacpp" | "mlx" | "lmstudio";
    formats?: readonly ("ollama" | "gguf" | "mlx")[];
    canPull?: boolean;
  } = {},
): FakeAdapter {
  const pullArgs: PullOptions[] = [];
  const readyArgs: ReadinessOptions[] = [];
  const adapter: FakeAdapter = {
    pullArgs,
    readyArgs,
    name: options.name ?? "ollama",
    capabilities: {
      canPull: options.canPull ?? true,
      canEmbed: true,
      embeddingOffload: "unknown",
      openAiCompatible: true,
      formats: options.formats ?? ["ollama"],
      defaultPort: 11434,
    },
    isInstalled: () => Promise.resolve(true),
    installHint: () => "brew install ollama",
    pull: (opts: PullOptions): Promise<PullResult> => {
      pullArgs.push(opts);
      return adapter.pullError
        ? Promise.reject(adapter.pullError)
        : Promise.resolve({ modelId: opts.modelId, digestVerified: true });
    },
    serve: () => Promise.reject(new Error("unused")),
    waitUntilReady: (opts: ReadinessOptions): Promise<void> => {
      readyArgs.push(opts);
      return adapter.readyError ? Promise.reject(adapter.readyError) : Promise.resolve();
    },
    stop: () => Promise.reject(new Error("unused")),
    chat: () => Promise.reject(new Error("unused")),
    embed: () => Promise.reject(new Error("unused")),
  };
  return adapter;
}

let home: string;
let config: Config;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-switch-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const CAT = catalog([
  model("llama3.1:8b"),
  model("qwen2.5:7b", [quant("Q4_K_M", { sha256: "b".repeat(64) })]),
]);

function deps(adapter: FakeAdapter, cat: Catalog = CAT): SwitchDeps {
  return {
    config,
    loadCatalog: () => cat,
    readState,
    writeState,
    withLock,
    captureLiveProcessIdentity: (active) =>
      captureLiveProcessIdentity(active, {
        isBackendExecutable: () => true,
        probeListenerIdentity: async () => ({
          pid: active.pid ?? 9999,
          process: active.backend,
          executable: active.processExecutable ?? `/fake/${active.backend}`,
          started: active.processStartedAt ?? "test-start",
          localAddress: "127.0.0.1",
        }),
      }),
    registry: createRegistry([adapter]),
    write: (t) => stdout.push(t),
    log: (t) => stderr.push(t),
  };
}

function seedActive(modelId: string, backend: "ollama" | "llamacpp" | "mlx" = "ollama"): void {
  writeState(config, {
    schemaVersion: STATE_SCHEMA_VERSION,
    active: {
      backend,
      modelId,
      endpoint: "http://127.0.0.1:11434",
      pid: 9001,
      port: 11434,
      ownedByUs: true,
      ...(backend === "mlx"
        ? {
            processExecutable: "/usr/bin/python3",
            processStartedAt: "2026-08-08T00:00:00Z",
            authToken: "a".repeat(64),
          }
        : {}),
    },
  });
}

describe("runSwitch", () => {
  it("executes one immutable prepared switch and returns a typed result", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();
    const dependencies = deps(adapter);
    const prepared = await prepareSwitch({ model: "qwen2.5:7b" }, dependencies);
    const events: string[] = [];

    const result = await executePreparedSwitch(prepared, dependencies, (event) => {
      events.push(`${event.status}:${event.phase}`);
      throw new Error("renderer failed");
    });

    expect(result).toEqual({
      type: "switched",
      modelId: "qwen2.5:7b",
      endpoint: "http://127.0.0.1:11434",
    });
    expect(stdout).toEqual([]);
    expect(events).toEqual([
      "started:prepare",
      "completed:prepare",
      "started:readiness",
      "completed:readiness",
      "started:locked-revalidate",
      "completed:locked-revalidate",
      "started:state-commit",
      "completed:state-commit",
    ]);
  });

  it("rejects when no server is active", async () => {
    const adapter = fakeAdapter();

    await expect(runSwitch({ model: "qwen2.5" }, deps(adapter))).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(adapter.pullArgs).toHaveLength(0);
    expect(readState(config).active).toBeNull();
  });

  it("is a defined no-op when the target is already active", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();

    await runSwitch({ model: "llama3.1:8b" }, deps(adapter));

    expect(adapter.pullArgs).toHaveLength(0);
    expect(stdout.join("")).toMatch(/already active/i);
    expect(readState(config).active).toMatchObject({ modelId: "llama3.1:8b" });
  });

  it("repoints the active model, preserving the daemon handle", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();

    await withGoldenEnvironment(() => runSwitch({ model: "qwen2.5" }, deps(adapter)));

    expect(adapter.pullArgs[0]?.modelId).toBe("qwen2.5:7b");
    expect(adapter.readyArgs[0]?.endpoint).toBe("http://127.0.0.1:11434");
    expect(readState(config).active).toEqual({
      backend: "ollama",
      modelId: "qwen2.5:7b",
      endpoint: "http://127.0.0.1:11434",
      pid: 9001,
      port: 11434,
      ownedByUs: true,
    });
    expectNoninteractiveGolden(plainGoldenName("switch"), stdout.join(""));
  });

  it("preserves the prior active model when the pull fails", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();
    adapter.pullError = new BackendError("pull failed");

    await expect(runSwitch({ model: "qwen2.5" }, deps(adapter))).rejects.toBeInstanceOf(
      BackendError,
    );

    expect(readState(config).active).toMatchObject({ modelId: "llama3.1:8b" });
  });

  it("preserves the prior active model when the health check fails", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();
    adapter.readyError = new BackendError("not ready");

    await expect(runSwitch({ model: "qwen2.5" }, deps(adapter))).rejects.toBeInstanceOf(
      BackendError,
    );

    expect(readState(config).active).toMatchObject({ modelId: "llama3.1:8b" });
  });

  it("forwards the catalog digest to pull when an explicit quant is requested", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();

    await runSwitch({ model: "qwen2.5:7b-Q4_K_M" }, deps(adapter));

    expect(adapter.pullArgs[0]).toMatchObject({
      modelId: "qwen2.5:7b",
      expectedSha256: "b".repeat(64),
    });
  });

  it("always supplies the catalog size floor when switching without a quant suffix", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();

    await runSwitch({ model: "qwen2.5:7b" }, deps(adapter));

    expect(adapter.pullArgs[0]?.expectedSizeBytes).toBe(5_000_000_000);
  });

  it("rejects switch on a single-model llama.cpp server without pulling or rewriting state", async () => {
    seedActive("llama3.1:8b", "llamacpp");
    const adapter = fakeAdapter({ name: "llamacpp", formats: ["gguf"] });

    await expect(runSwitch({ model: "qwen2.5:7b" }, deps(adapter))).rejects.toThrow(
      /single-model|local-llmup up/i,
    );

    expect(adapter.pullArgs).toHaveLength(0);
    expect(readState(config).active).toMatchObject({ modelId: "llama3.1:8b" });
  });

  it("rejects switch on a single-model MLX server without pulling or rewriting state", async () => {
    seedActive("llama3.1:8b", "mlx");
    const adapter = fakeAdapter({ name: "mlx", formats: ["mlx"] });

    await expect(runSwitch({ model: "qwen2.5:7b" }, deps(adapter))).rejects.toThrow(
      /single-model|local-llmup up/i,
    );

    expect(adapter.pullArgs).toHaveLength(0);
    expect(readState(config).active).toMatchObject({ modelId: "llama3.1:8b" });
  });

  it("rejects switch for runtime-managed LM Studio models", async () => {
    writeState(config, {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "lmstudio",
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:1234",
        port: 1234,
        ownedByUs: false,
        pid: 7001,
        processExecutable: "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
        processStartedAt: "2026-08-08T00:00:00Z",
        modelPath: "Qwen/model.gguf",
      },
    });
    const adapter = fakeAdapter({
      name: "lmstudio",
      formats: ["gguf", "mlx"],
      canPull: false,
    });

    await expect(runSwitch({ model: "qwen2.5:7b" }, deps(adapter))).rejects.toThrow(
      /runtime-managed|local-llmup up/i,
    );
    expect(adapter.pullArgs).toHaveLength(0);
  });

  it("aborts commit when the active server changes during preparation", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();
    const d = deps(adapter);
    const racing: SwitchDeps = {
      ...d,
      withLock: async (_config, fn) => {
        writeState(config, {
          schemaVersion: STATE_SCHEMA_VERSION,
          active: {
            backend: "ollama",
            modelId: "other:1b",
            endpoint: "http://127.0.0.1:12000",
            pid: 9999,
            port: 12000,
            ownedByUs: true,
          },
        });
        return fn();
      },
    };

    await expect(runSwitch({ model: "qwen2.5:7b" }, racing)).rejects.toThrow(
      /changed during switch/i,
    );
    expect(readState(config).active).toMatchObject({ endpoint: "http://127.0.0.1:12000" });
  });

  it("returns typed confirmation drift when the active server disappears", async () => {
    seedActive("llama3.1:8b");
    const adapter = fakeAdapter();
    const d = deps(adapter);
    const writeStateSpy = vi.fn(d.writeState);
    const racing: SwitchDeps = {
      ...d,
      writeState: writeStateSpy,
      withLock: async (_config, fn) => {
        writeState(config, { schemaVersion: STATE_SCHEMA_VERSION, active: null });
        return fn();
      },
    };

    await expect(runSwitch({ model: "qwen2.5:7b" }, racing)).rejects.toBeInstanceOf(
      ConfirmationDriftError,
    );
    expect(writeStateSpy).not.toHaveBeenCalled();
  });
});
