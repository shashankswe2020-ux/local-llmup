import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { BackendError, ModelResolutionError, ValidationError } from "../../src/errors.js";
import { readState, withLock, writeState } from "../../src/state/state.js";
import { runUp, type UpDeps } from "../../src/commands/up.js";
import type {
  BackendAdapter,
  PullOptions,
  PullResult,
  ReadinessOptions,
  ServeHandle,
  ServeOptions,
} from "../../src/backend/adapter.js";
import type { Catalog, CatalogModel, HardwareProfile, Quantization } from "../../src/types.js";

const GIB = 1024 ** 3;

function quant(name: string, diskBytes: number, overrides: Partial<Quantization> = {}): Quantization {
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
  const handle: ServeHandle = options.handle ?? {
    endpoint: "http://127.0.0.1:11434",
    pid: 9001,
    port: 11434,
    ownedByUs: true,
  };

  return {
    calls,
    pullArgs,
    serveArgs,
    readyArgs,
    stopped,
    name: "ollama",
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
      return Promise.resolve({ modelId: opts.modelId, digestVerified: true });
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
      return Promise.resolve();
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

function deps(
  adapter: FakeAdapter,
  cat: Catalog,
  hw: HardwareProfile = hardware(),
): UpDeps {
  return {
    config,
    loadCatalog: () => cat,
    detectHardware: () => {
      adapter.calls.push("detect");
      return Promise.resolve(hw);
    },
    adapter,
    writeState: (c, s) => {
      adapter.calls.push("state");
      writeState(c, s);
    },
    readState,
    withLock,
    write: (t) => stdout.push(t),
    log: (t) => stderr.push(t),
  };
}

describe("runUp", () => {
  it("resolves, preflights disk, ensures backend, pulls, serves, health-checks, then writes state in order", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB, { sha256: "a".repeat(64) })])]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(adapter.calls).toEqual(["detect", "isInstalled", "pull", "serve", "health", "state"]);
    expect(adapter.pullArgs[0]).toMatchObject({
      modelId: "llama3.1:8b",
      expectedSha256: "a".repeat(64),
      expectedSizeBytes: 5 * GIB,
    });
    expect(readState(config).active).toEqual({
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

  it("aborts before pull/serve when free disk is insufficient", async () => {
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    const hw = hardware({ freeDiskBytes: 1 * GIB });

    await expect(runUp({ model: "llama3.1:8b-Q4_K_M" }, deps(adapter, cat, hw))).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(adapter.calls).not.toContain("pull");
    expect(adapter.calls).not.toContain("serve");
    expect(readState(config).active).toBeNull();
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

  it("persists an attached daemon with pid 0 and ownedByUs false", async () => {
    const adapter = fakeAdapter({
      handle: {
        endpoint: "http://127.0.0.1:11434",
        pid: 0,
        port: 11434,
        ownedByUs: false,
      },
    });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);

    await runUp({ model: "llama3.1:8b" }, deps(adapter, cat));

    expect(readState(config).active).toEqual({
      modelId: "llama3.1:8b",
      endpoint: "http://127.0.0.1:11434",
      pid: 0,
      port: 11434,
      ownedByUs: false,
    });
  });

  it("stops a previously-owned daemon before recording the new one", async () => {
    const adapter = fakeAdapter({
      handle: { endpoint: "http://127.0.0.1:11434", pid: 9001, port: 11434, ownedByUs: true },
    });
    const cat = catalog([model("llama3.1:8b", [quant("Q4_K_M", 5 * GIB)])]);
    // Seed state with a different owned daemon already recorded.
    writeState(config, {
      schemaVersion: 1,
      active: {
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
});
