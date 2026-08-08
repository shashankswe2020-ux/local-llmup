import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { BackendError, ModelResolutionError, ValidationError } from "../../src/errors.js";
import { readState, STATE_SCHEMA_VERSION, withLock, writeState } from "../../src/state/state.js";
import { runUp, type UpDeps } from "../../src/commands/up.js";
import { captureLiveProcessIdentity } from "../../src/tui/snapshots.js";
import { createRegistry } from "../../src/backend/registry.js";
import type {
  BackendAdapter,
  PullOptions,
  PullResult,
  ReadinessOptions,
  ServeHandle,
  ServeOptions,
} from "../../src/backend/adapter.js";
import type {
  BackendName,
  Catalog,
  CatalogModel,
  HardwareProfile,
  ModelFormat,
  Quantization,
} from "../../src/types.js";
import {
  expectNoninteractiveGolden,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";

const GIB = 1024 ** 3;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectFn: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (reason) => rejectFn?.(reason),
  };
}

function quant(
  name: string,
  diskBytes: number,
  overrides: Partial<Quantization> = {},
): Quantization {
  return {
    name,
    diskBytes,
    minRamBytes: diskBytes + 1_000_000_000,
    minVramBytes: diskBytes + 1_000_000_000,
    ...overrides,
  };
}

function model(id: string, quants: readonly Quantization[]): CatalogModel {
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

function ggufModel(id: string, quants: readonly Quantization[]): CatalogModel {
  return {
    ...model(id, quants),
    source: {
      gguf: {
        repo: "Qwen/Qwen3-14B-GGUF",
        revision: "a".repeat(40),
        file: "qwen3-14b-q4.gguf",
        sha256: "b".repeat(64),
      },
    },
  };
}

function mlxModel(id: string, quants: readonly Quantization[]): CatalogModel {
  const repositoryBytes = quants[0]?.diskBytes ?? 1_300;
  return {
    ...model(id, quants),
    source: {
      mlx: {
        repo: "mlx-community/Qwen3-14B-4bit",
        revision: "c".repeat(40),
        files: [
          { file: "config.json", sha256: "d".repeat(64), bytes: 100 },
          { file: "tokenizer_config.json", sha256: "e".repeat(64), bytes: 200 },
          { file: "model.safetensors", sha256: "f".repeat(64), bytes: repositoryBytes - 300 },
        ],
      },
    },
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

function hardware(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    arch: "arm64",
    platform: "darwin",
    totalRamBytes: 64 * GIB,
    freeRamBytes: 64 * GIB,
    gpu: [{ vendor: "apple", vramBytes: 0 }],
    freeDiskBytes: 500 * GIB,
    ...overrides,
  };
}

interface FakeAdapterOptions {
  readonly installed?: boolean;
  readonly handle?: ServeHandle;
  readonly readyBehavior?: "resolve" | "reject";
  readonly name?: BackendName;
  readonly formats?: readonly ModelFormat[];
  readonly pullModelPath?: string;
  readonly pullDigestVerified?: boolean;
  readonly stopBehavior?: "resolve" | "reject";
  readonly canPull?: boolean;
}

interface FakeAdapter extends BackendAdapter {
  readonly calls: string[];
  readonly pullArgs: PullOptions[];
  readonly serveArgs: ServeOptions[];
  readonly readyArgs: ReadinessOptions[];
  readonly stopped: ServeHandle[];
}

function fakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const calls: string[] = [];
  const pullArgs: PullOptions[] = [];
  const serveArgs: ServeOptions[] = [];
  const readyArgs: ReadinessOptions[] = [];
  const stopped: ServeHandle[] = [];
  const backendName: BackendName = options.name ?? "ollama";
  const formats = options.formats ?? (["ollama"] as const);
  const defaultPort =
    backendName === "lmstudio"
      ? 1234
      : backendName === "llamacpp" || backendName === "mlx"
        ? 8080
        : 11434;
  const handle: ServeHandle = options.handle ?? {
    endpoint: `http://127.0.0.1:${defaultPort}`,
    pid: 9001,
    port: defaultPort,
    ownedByUs: true,
  };

  return {
    calls,
    pullArgs,
    serveArgs,
    readyArgs,
    stopped,
    name: backendName,
    capabilities: {
      canPull: options.canPull ?? true,
      canEmbed: backendName !== "llamacpp" && backendName !== "mlx",
      openAiCompatible: true,
      formats: [...formats],
      defaultPort,
    },
    isInstalled(): Promise<boolean> {
      calls.push("isInstalled");
      return Promise.resolve(options.installed ?? true);
    },
    installHint(): string {
      return "brew install ollama";
    },
    pull(opts: PullOptions): Promise<PullResult> {
      calls.push("pull");
      pullArgs.push(opts);
      return Promise.resolve({
        modelId: opts.modelId,
        digestVerified: options.pullDigestVerified ?? true,
        ...(options.pullModelPath !== undefined ? { modelPath: options.pullModelPath } : {}),
      });
    },
    serve(opts?: ServeOptions): Promise<ServeHandle> {
      calls.push("serve");
      serveArgs.push(opts ?? {});
      return Promise.resolve(handle);
    },
    waitUntilReady(opts: ReadinessOptions): Promise<void> {
      calls.push("health");
      readyArgs.push(opts);
      return options.readyBehavior === "reject"
        ? Promise.reject(new BackendError("not ready"))
        : Promise.resolve();
    },
    stop(h: ServeHandle): Promise<void> {
      calls.push("stop");
      stopped.push(h);
      return options.stopBehavior === "reject"
        ? Promise.reject(new BackendError("stop failed"))
        : Promise.resolve();
    },
    chat(): Promise<never> {
      return Promise.reject(new Error("unused"));
    },
    embed(): Promise<never> {
      return Promise.reject(new Error("unused"));
    },
  };
}

let home: string;
let config: Config;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-up-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function deps(adapter: FakeAdapter, cat: Catalog, hw: HardwareProfile = hardware()): UpDeps {
  return {
    config,
    loadCatalog: () => cat,
    detectHardware: () => {
      adapter.calls.push("detect");
      return Promise.resolve(hw);
    },
    registry: createRegistry([adapter]),
    env: {},
    writeState: (c, s) => {
      adapter.calls.push("state");
      writeState(c, s);
    },
    readState,
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
    write: (t) => stdout.push(t),
    log: (t) => stderr.push(t),
  };
}

describe("runUp", () => {
  it("resolves, preflights disk, ensures backend, pulls, serves, health-checks, then writes state in order", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([
      model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB, { sha256: "a".repeat(64) })]),
    ]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(adapter.calls).toEqual(["detect", "isInstalled", "pull", "serve", "health", "state"]);
    expect(adapter.pullArgs[0]).toMatchObject({
      modelId: "llama3.1:8b",
      expectedSha256: "a".repeat(64),
      expectedSizeBytes: 5 * GIB,
    });
    expect(adapter.readyArgs[0]).toMatchObject({
      endpoint: "http://127.0.0.1:11434",
      requireOpenAiCompatibility: true,
    });
    expect(readState(config).active).toEqual({
      backend: "ollama",
      modelId: "llama3.1:8b",
      endpoint: "http://127.0.0.1:11434",
      pid: 9001,
      port: 11434,
      ownedByUs: true,
    });
    expect(stdout.join("")).toContain("http://127.0.0.1:11434");
  });

  it("binds loopback (127.0.0.1), never 0.0.0.0", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(adapter.serveArgs[0]?.host).toBe("127.0.0.1");
    expect(adapter.serveArgs[0]?.host).not.toBe("0.0.0.0");
  });

  it("up --backend llamacpp pulls a pinned gguf, serves with the weight path, and records backend:llamacpp", async () => {
    const adapter = fakeAdapter({
      name: "llamacpp",
      formats: ["gguf"],
      pullModelPath: "/cache/qwen3-14b-q4.gguf",
      handle: {
        endpoint: "http://127.0.0.1:8080",
        pid: 7070,
        port: 8080,
        ownedByUs: true,
      },
    });
    const cat = catalog([
      ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB, { sha256: "b".repeat(64) })]),
    ]);

    await runUp({ model: "qwen3:14b", backend: "llamacpp" }, deps(adapter, cat));

    expect(adapter.calls).toEqual(["detect", "isInstalled", "pull", "serve", "health", "state"]);
    expect(adapter.pullArgs[0]).toMatchObject({
      modelId: "qwen3:14b",
      source: {
        repo: "Qwen/Qwen3-14B-GGUF",
        revision: "a".repeat(40),
        file: "qwen3-14b-q4.gguf",
        sha256: "b".repeat(64),
      },
    });
    expect(adapter.serveArgs[0]?.modelPath).toBe("/cache/qwen3-14b-q4.gguf");
    expect(adapter.serveArgs[0]?.modelId).toBe("qwen3:14b");
    expect(adapter.serveArgs[0]?.host).toBe("127.0.0.1");
    expect(readState(config).active).toEqual({
      backend: "llamacpp",
      modelId: "qwen3:14b",
      endpoint: "http://127.0.0.1:8080",
      pid: 7070,
      port: 8080,
      ownedByUs: true,
    });
  });

  it("up --backend mlx pulls a pinned repository, serves its local directory, and records backend:mlx", async () => {
    const adapter = fakeAdapter({
      name: "mlx",
      formats: ["mlx"],
      pullModelPath: "/cache/mlx/qwen3-14b",
      handle: {
        endpoint: "http://127.0.0.1:8080",
        pid: 7002,
        port: 8080,
        ownedByUs: true,
        processExecutable: "/usr/bin/python3",
        processStartedAt: "2026-08-08T00:00:00Z",
        authToken: "a".repeat(64),
      },
    });
    const cat = catalog([mlxModel("qwen3:14b", [quant("4bit", 9 * GIB)])]);

    await runUp({ model: "qwen3:14b", backend: "mlx" }, deps(adapter, cat));

    expect(adapter.pullArgs[0]).toMatchObject({
      modelId: "qwen3:14b",
      repository: cat.models[0]!.source.mlx,
    });
    expect(adapter.serveArgs[0]).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      modelPath: "/cache/mlx/qwen3-14b",
      modelId: "qwen3:14b",
    });
    expect(readState(config).active).toMatchObject({
      backend: "mlx",
      processExecutable: "/usr/bin/python3",
      processStartedAt: "2026-08-08T00:00:00Z",
      authToken: "a".repeat(64),
    });
    expect(adapter.readyArgs[0]?.authToken).toBe("a".repeat(64));
  });

  it("up --backend lmstudio delegates integrity and records an attached server", async () => {
    const adapter = fakeAdapter({
      name: "lmstudio",
      formats: ["gguf", "mlx"],
      canPull: false,
      pullModelPath: "Qwen/Qwen3-14B-GGUF/qwen3-14b-q4.gguf",
      pullDigestVerified: false,
      handle: {
        endpoint: "http://127.0.0.1:1234",
        pid: 7003,
        port: 1234,
        ownedByUs: false,
        processExecutable: "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
        processStartedAt: "2026-08-08T00:00:00Z",
        modelPath: "Qwen/Qwen3-14B-GGUF/qwen3-14b-q4.gguf",
      },
    });
    const cat = catalog([ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB)])]);

    await runUp(
      { model: "qwen3:14b-Q4_K_M", backend: "lmstudio" },
      deps(adapter, cat, hardware({ freeDiskBytes: 1 })),
    );

    expect(adapter.pullArgs).toHaveLength(1);
    expect(adapter.serveArgs[0]).toMatchObject({
      host: "127.0.0.1",
      port: 1234,
      modelId: "qwen3:14b",
      modelPath: "Qwen/Qwen3-14B-GGUF/qwen3-14b-q4.gguf",
    });
    expect(stderr.join("")).toContain("delegated to lmstudio");
    expect(readState(config).active).toEqual({
      backend: "lmstudio",
      modelId: "qwen3:14b",
      endpoint: "http://127.0.0.1:1234",
      port: 1234,
      ownedByUs: false,
      pid: 7003,
      processExecutable: "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
      processStartedAt: "2026-08-08T00:00:00Z",
      modelPath: "Qwen/Qwen3-14B-GGUF/qwen3-14b-q4.gguf",
    });
  });

  it("rejects LM Studio MLX sources off Apple Silicon before delegated lookup", async () => {
    const adapter = fakeAdapter({
      name: "lmstudio",
      formats: ["gguf", "mlx"],
      canPull: false,
    });
    const cat = catalog([mlxModel("qwen3:14b", [quant("4bit", 9 * GIB)])]);
    const linux = hardware({ platform: "linux", arch: "x64", gpu: [] });

    await expect(
      runUp({ model: "qwen3:14b", backend: "lmstudio" }, deps(adapter, cat, linux)),
    ).rejects.toThrow(/not supported.*linux\/x64/i);
    expect(adapter.pullArgs).toHaveLength(0);
  });

  it("does not pull when an explicitly selected backend is unavailable", async () => {
    const adapter = fakeAdapter({ name: "mlx", formats: ["mlx"], installed: false });
    const cat = catalog([mlxModel("qwen3:14b", [quant("4bit", 9 * GIB)])]);

    await expect(
      runUp({ model: "qwen3:14b", backend: "mlx" }, deps(adapter, cat)),
    ).rejects.toBeInstanceOf(BackendError);
    expect(adapter.pullArgs).toHaveLength(0);
  });

  it("rejects ambiguous or size-mismatched MLX quantization manifests before pull", async () => {
    const adapter = fakeAdapter({ name: "mlx", formats: ["mlx"] });
    const ambiguous = mlxModel("qwen3:14b", [quant("4bit", 9 * GIB), quant("8bit", 17 * GIB)]);
    await expect(
      runUp({ model: "qwen3:14b", backend: "mlx" }, deps(adapter, catalog([ambiguous]))),
    ).rejects.toBeInstanceOf(ValidationError);
    const exact = mlxModel("qwen3:14b", [quant("4bit", 9 * GIB)]);
    const mismatched: CatalogModel = {
      ...exact,
      source: {
        mlx: {
          ...exact.source.mlx!,
          files: exact.source.mlx!.files.map((file, index) =>
            index === 2 ? { ...file, bytes: file.bytes - 1 } : file,
          ),
        },
      },
    };
    await expect(
      runUp({ model: "qwen3:14b", backend: "mlx" }, deps(adapter, catalog([mismatched]))),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(adapter.pullArgs).toHaveLength(0);
  });

  it("honors LOCAL_LLMUP_BACKEND when no flag is provided", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({
      name: "llamacpp",
      formats: ["gguf"],
      pullModelPath: "/cache/qwen.gguf",
      handle: {
        endpoint: "http://127.0.0.1:8080",
        pid: 8081,
        port: 8080,
        ownedByUs: true,
      },
    });
    const both = ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB)]);
    const cat = catalog([{ ...both, source: { ...both.source, ollama: "qwen3:14b" } }]);
    const d: UpDeps = {
      ...deps(llamacpp, cat),
      registry: createRegistry([ollama, llamacpp]),
      env: { LOCAL_LLMUP_BACKEND: "llamacpp" },
    };

    await runUp({ model: "qwen3:14b" }, d);

    expect(readState(config).active?.backend).toBe("llamacpp");
  });

  it("honors the user-config backend when flag and env are absent", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({
      name: "llamacpp",
      formats: ["gguf"],
      pullModelPath: "/cache/qwen.gguf",
    });
    const both = ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB)]);
    const cat = catalog([{ ...both, source: { ...both.source, ollama: "qwen3:14b" } }]);
    const d: UpDeps = {
      ...deps(llamacpp, cat),
      registry: createRegistry([ollama, llamacpp]),
      configBackend: "llamacpp",
    };

    await runUp({ model: "qwen3:14b" }, d);

    expect(readState(config).active?.backend).toBe("llamacpp");
  });

  it("warns when the pulled weights could not be digest-verified", async () => {
    const adapter = fakeAdapter({ pullDigestVerified: false });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(stderr.join("")).toContain("could not be digest-verified");
    expect(readState(config).active).not.toBeNull();
  });

  it("refuses to serve digest-unverified self-managed weights", async () => {
    const adapter = fakeAdapter({
      name: "llamacpp",
      formats: ["gguf"],
      pullModelPath: "/cache/qwen3-14b-q4.gguf",
      pullDigestVerified: false,
    });
    const cat = catalog([
      ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB, { sha256: "b".repeat(64) })]),
    ]);

    await expect(
      runUp({ model: "qwen3:14b", backend: "llamacpp" }, deps(adapter, cat)),
    ).rejects.toThrow("digest verification");

    expect(adapter.calls).not.toContain("serve");
    expect(readState(config).active).toBeNull();
  });

  it("rejects when the selected backend cannot serve any of the model's sources", async () => {
    const adapter = fakeAdapter({ name: "llamacpp", formats: ["gguf"] });
    // Ollama-only source, but llamacpp only serves gguf → no servable source.
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await expect(
      runUp({ model: "llama3.1:8b", backend: "llamacpp" }, deps(adapter, cat)),
    ).rejects.toThrow("has no source that backend llamacpp can serve");
  });

  it("aborts before pull/serve when free disk is insufficient", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    const hw = hardware({ freeDiskBytes: 1 * GIB });

    await expect(runUp({ model: "llama3.1:8b-Q4_K_M" }, deps(adapter, cat, hw))).rejects.toThrow(
      "insufficient disk for llama3.1:8b (Q4_K_M): need 5.0 GiB, 1.0 GiB free",
    );

    expect(adapter.calls).not.toContain("pull");
    expect(adapter.calls).not.toContain("serve");
    expect(readState(config).active).toBeNull();
  });

  it("auto-selects an installed backend that can serve the model instead of MLX-first blindly", async () => {
    const ollama = fakeAdapter({ name: "ollama", formats: ["ollama"] });
    const mlx = fakeAdapter({ name: "mlx", formats: ["mlx"] });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    const d: UpDeps = {
      ...deps(ollama, cat),
      registry: createRegistry([ollama, mlx]),
    };

    await runUp({ model: "llama3.1:8b" }, d);

    expect(ollama.pullArgs).toHaveLength(1);
    expect(mlx.pullArgs).toHaveLength(0);
    expect(readState(config).active?.backend).toBe("ollama");
  });

  it("auto-selects MLX only on Apple Silicon for an MLX-source model", async () => {
    const mlx = fakeAdapter({
      name: "mlx",
      formats: ["mlx"],
      pullModelPath: "/cache/mlx/qwen3-14b",
      handle: {
        endpoint: "http://127.0.0.1:8080",
        pid: 7018,
        port: 8080,
        ownedByUs: true,
        processExecutable: "/usr/bin/python3",
        processStartedAt: "2026-08-08T00:00:00Z",
        authToken: "a".repeat(64),
      },
    });
    const cat = catalog([mlxModel("qwen3:14b", [quant("4bit", 9 * GIB)])]);

    await runUp({ model: "qwen3:14b" }, deps(mlx, cat));
    expect(mlx.pullArgs).toHaveLength(1);
    expect(readState(config).active?.backend).toBe("mlx");

    writeState(config, { schemaVersion: STATE_SCHEMA_VERSION, active: null });
    const nonApple = hardware({ platform: "linux", arch: "x64", gpu: [] });
    await expect(runUp({ model: "qwen3:14b" }, deps(mlx, cat, nonApple))).rejects.toBeInstanceOf(
      BackendError,
    );
    expect(mlx.pullArgs).toHaveLength(1);
  });

  it("uses the same insufficient-disk message for auto and explicit quant selection", async () => {
    const autoAdapter = fakeAdapter();
    const explicitAdapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB), quant("Q8_0", 8 * GIB)])]);
    const hw = hardware({ freeDiskBytes: 1 * GIB });

    const autoError = await runUp({ model: "llama3.1:8b" }, deps(autoAdapter, cat, hw)).then(
      () => new Error("expected runUp to fail"),
      (error: unknown) => error,
    );
    const explicitError = await runUp(
      { model: "llama3.1:8b-Q4_K_M" },
      deps(explicitAdapter, cat, hw),
    ).then(
      () => new Error("expected runUp to fail"),
      (error: unknown) => error,
    );

    expect(autoError).toBeInstanceOf(ValidationError);
    expect(explicitError).toBeInstanceOf(ValidationError);
    expect((autoError as ValidationError).message).toBe((explicitError as ValidationError).message);
    expect((autoError as ValidationError).message).toBe(
      "insufficient disk for llama3.1:8b (Q4_K_M): need 5.0 GiB, 1.0 GiB free",
    );
    expect(autoAdapter.calls).not.toContain("pull");
    expect(explicitAdapter.calls).not.toContain("pull");
  });

  it("warns when an explicitly requested quant fails memory fit", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    const hw = hardware({ totalRamBytes: 8 * GIB });

    await runUp({ model: "llama3.1:8b-Q4_K_M" }, deps(adapter, cat, hw));

    expect(stderr.join("")).toContain("may not fit this hardware (ram-bound)");
    expect(stdout.join("")).toContain("ready at");
  });

  it("does not warn when an explicitly requested quant fits memory", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await runUp({ model: "llama3.1:8b-Q4_K_M" }, deps(adapter, cat));

    expect(stderr.join("")).not.toContain("may not fit this hardware");
  });

  it("aborts with the install hint when the backend is missing", async () => {
    const adapter = fakeAdapter({ installed: false });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await expect(runUp({ model: "llama3.1:8b" }, deps(adapter, cat))).rejects.toThrow(
      /brew install ollama/,
    );

    expect(adapter.calls).not.toContain("pull");
    expect(adapter.calls).not.toContain("serve");
    expect(readState(config).active).toBeNull();
  });

  it("stops the spawned daemon and does not write state when health fails", async () => {
    const adapter = fakeAdapter({ readyBehavior: "reject" });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await expect(runUp({ model: "llama3.1:8b" }, deps(adapter, cat))).rejects.toBeInstanceOf(
      BackendError,
    );

    expect(adapter.stopped).toHaveLength(1);
    expect(adapter.calls).not.toContain("state");
    expect(readState(config).active).toBeNull();
  });

  it("persists complete process identity for an attached daemon", async () => {
    const adapter = fakeAdapter({
      handle: {
        endpoint: "http://127.0.0.1:11434",
        pid: 4242,
        port: 11434,
        ownedByUs: false,
        processExecutable: "/fake/ollama",
        processStartedAt: "test-start",
      },
    });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(readState(config).active).toEqual({
      backend: "ollama",
      modelId: "llama3.1:8b",
      endpoint: "http://127.0.0.1:11434",
      pid: 4242,
      port: 11434,
      ownedByUs: false,
      processExecutable: "/fake/ollama",
      processStartedAt: "test-start",
    });
  });

  it("stops a previously-owned daemon before recording the new one", async () => {
    const adapter = fakeAdapter({
      handle: { endpoint: "http://127.0.0.1:11434", pid: 9001, port: 11434, ownedByUs: true },
    });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    // Seed state with a different owned daemon already recorded.
    writeState(config, {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "phi3:mini",
        endpoint: "http://127.0.0.1:11500",
        pid: 4242,
        port: 11500,
        ownedByUs: true,
      },
    });

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(adapter.stopped).toHaveLength(1);
    expect(adapter.stopped[0]).toMatchObject({ pid: 4242, port: 11500, ownedByUs: true });
    expect(readState(config).active).toMatchObject({ modelId: "llama3.1:8b", pid: 9001 });
  });

  it("replaces a prior owned server instead of resurrecting ownership from state", async () => {
    const adapter = fakeAdapter({
      handle: {
        endpoint: "http://127.0.0.1:11434",
        pid: 9002,
        port: 11434,
        ownedByUs: true,
      },
    });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    writeState(config, {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 4242,
        port: 11434,
        ownedByUs: true,
      },
    });

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(adapter.stopped).toHaveLength(1);
    expect(adapter.stopped[0]).toMatchObject({ pid: 4242 });
    expect(readState(config).active).toMatchObject({ ownedByUs: true, pid: 9002 });
  });

  it("stops a prior owned server through its own backend adapter", async () => {
    const prior = fakeAdapter({ name: "ollama" });
    const next = fakeAdapter({
      name: "llamacpp",
      formats: ["gguf"],
      pullModelPath: "/cache/qwen.gguf",
      handle: {
        endpoint: "http://127.0.0.1:18080",
        pid: 8081,
        port: 18080,
        ownedByUs: true,
      },
    });
    const cat = catalog([ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB)])]);
    writeState(config, {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 4242,
        port: 11434,
        ownedByUs: true,
      },
    });
    const d = { ...deps(next, cat), registry: createRegistry([prior, next]) };

    await runUp({ model: "qwen3:14b", backend: "llamacpp", port: 18080 }, d);

    expect(prior.stopped).toHaveLength(1);
    expect(next.stopped).toHaveLength(0);
  });

  it("keeps prior state and does not start a new server when prior stop fails", async () => {
    const prior = fakeAdapter({ name: "ollama", stopBehavior: "reject" });
    const next = fakeAdapter({
      name: "llamacpp",
      formats: ["gguf"],
      pullModelPath: "/cache/qwen.gguf",
      handle: {
        endpoint: "http://127.0.0.1:18080",
        pid: 8081,
        port: 18080,
        ownedByUs: true,
      },
    });
    const cat = catalog([ggufModel("qwen3:14b", [quant("Q4_K_M", 9 * GIB)])]);
    const oldState: RuntimeState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 4242,
        port: 11434,
        ownedByUs: true,
      },
    };
    writeState(config, oldState);
    const d = { ...deps(next, cat), registry: createRegistry([prior, next]) };

    await expect(
      runUp({ model: "qwen3:14b", backend: "llamacpp", port: 18080 }, d),
    ).rejects.toThrow("stop failed");

    expect(next.stopped).toHaveLength(0);
    expect(readState(config)).toEqual(oldState);
  });

  it("stops the owned daemon when persisting state fails", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    const base = deps(adapter, cat);
    const failing: UpDeps = {
      ...base,
      writeState: () => {
        throw new Error("disk full");
      },
    };

    await expect(runUp({ model: "llama3.1:8b" }, failing)).rejects.toThrow(/disk full/);

    expect(adapter.stopped).toHaveLength(1);
    expect(readState(config).active).toBeNull();
  });

  it("does not stop or serve when active state drifts before replacement lock", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    const base = deps(adapter, cat);

    await expect(
      runUp(
        { model: "llama3.1:8b" },
        {
          ...base,
          withLock: async (_config, fn) => {
            writeState(config, {
              schemaVersion: STATE_SCHEMA_VERSION,
              active: {
                backend: "ollama",
                modelId: "qwen2.5:7b",
                endpoint: "http://127.0.0.1:11434",
                pid: 7001,
                port: 11434,
                ownedByUs: true,
              },
            });
            return await fn();
          },
        },
      ),
    ).rejects.toThrow("changed during up");

    expect(adapter.serveArgs).toEqual([]);
    expect(adapter.stopped).toEqual([]);
    expect(readState(config).active?.modelId).toBe("qwen2.5:7b");
  });

  it("serializes concurrent up runs so only one serve can happen at a time", async () => {
    const handles: ServeHandle[] = [
      { endpoint: "http://127.0.0.1:11434", pid: 1111, port: 11434, ownedByUs: true },
      { endpoint: "http://127.0.0.1:11435", pid: 2222, port: 11435, ownedByUs: true },
    ];
    const serveEntered = deferred<void>();
    const releaseFirstHealth = deferred<void>();
    let serveCalls = 0;
    const adapter = fakeAdapter();
    adapter.serve = (opts?: ServeOptions): Promise<ServeHandle> => {
      adapter.calls.push("serve");
      adapter.serveArgs.push(opts ?? {});
      const handle = handles[serveCalls] ?? handles[1]!;
      serveCalls += 1;
      if (serveCalls === 1) {
        serveEntered.resolve();
      }
      return Promise.resolve(handle);
    };
    adapter.waitUntilReady = async (opts: ReadinessOptions): Promise<void> => {
      adapter.calls.push("health");
      adapter.readyArgs.push(opts);
      if (opts.endpoint === handles[0]!.endpoint) {
        await releaseFirstHealth.promise;
      }
    };

    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    const firstRun = runUp({ model: "llama3.1:8b", port: 11434 }, deps(adapter, cat));
    await serveEntered.promise;

    const secondRun = runUp({ model: "llama3.1:8b", port: 11435 }, deps(adapter, cat));
    await Promise.resolve();
    await Promise.resolve();

    expect(serveCalls).toBe(1);

    releaseFirstHealth.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(serveCalls).toBe(2);
    expect(adapter.stopped).toHaveLength(1);
    expect(adapter.stopped[0]).toMatchObject({ pid: 1111, port: 11434, ownedByUs: true });
    expect(readState(config).active).toMatchObject({ pid: 2222, port: 11435, ownedByUs: true });
  });

  it("rejects an unknown model before touching the backend", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await expect(runUp({ model: "nonexistent-model" }, deps(adapter, cat))).rejects.toBeInstanceOf(
      ModelResolutionError,
    );

    expect(adapter.calls).toEqual([]);
  });

  it("streams pull progress to the diagnostics channel", async () => {
    const adapter = fakeAdapter();
    adapter.pull = (opts: PullOptions): Promise<PullResult> => {
      adapter.calls.push("pull");
      opts.onProgress?.({ status: "downloading" });
      return Promise.resolve({ modelId: opts.modelId, digestVerified: true });
    };
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(stderr.join("")).toContain("downloading");
  });

  it("sanitizes control characters in the final success line", async () => {
    const adapter = fakeAdapter({
      handle: {
        endpoint: "http://127.0.0.1:11434\u0007",
        pid: 9001,
        port: 11434,
        ownedByUs: true,
      },
    });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await withGoldenEnvironment(() => runUp({ model: "llama3.1:8b" }, deps(adapter, cat)));

    expectNoninteractiveGolden(plainGoldenName("up"), stdout.join(""));
    expect(stdout.join("")).not.toContain("\u0007");
  });
});
