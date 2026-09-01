import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { BackendError, ValidationError } from "../../src/errors.js";
import { readState, STATE_SCHEMA_VERSION, withLock, writeState } from "../../src/state/state.js";
import {
  executePreparedDown,
  prepareDownConfirmation,
  runDown,
  type DownDeps,
} from "../../src/commands/down.js";
import { createRegistry } from "../../src/backend/registry.js";
import type { BackendAdapter, ServeHandle } from "../../src/backend/adapter.js";
import type { Catalog, CatalogModel } from "../../src/types.js";
import {
  expectNoninteractiveGolden,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";
import {
  ConfirmationDriftError,
  captureLiveProcessIdentity,
} from "../../src/tui/snapshots.js";

function model(id: string): CatalogModel {
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
    quantizations: [
      {
        name: "Q4_K_M",
        diskBytes: 5_000_000_000,
        minRamBytes: 6_000_000_000,
        minVramBytes: 6_000_000_000,
      },
    ],
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

interface FakeAdapter extends BackendAdapter {
  readonly stopped: ServeHandle[];
  stopError?: Error;
}

function fakeAdapter(): FakeAdapter {
  const stopped: ServeHandle[] = [];
  const adapter: FakeAdapter = {
    stopped,
    name: "ollama",
    capabilities: {
      canPull: true,
      canEmbed: true,
      embeddingOffload: "unknown",
      openAiCompatible: true,
      formats: ["ollama"],
      defaultPort: 11434,
    },
    isInstalled: () => Promise.resolve(true),
    installHint: () => "brew install ollama",
    pull: () => Promise.reject(new Error("unused")),
    serve: () => Promise.reject(new Error("unused")),
    waitUntilReady: () => Promise.reject(new Error("unused")),
    stop: (handle: ServeHandle): Promise<void> => {
      stopped.push(handle);
      return adapter.stopError ? Promise.reject(adapter.stopError) : Promise.resolve();
    },
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
  home = mkdtempSync(join(tmpdir(), "llmup-down-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function deps(adapter: FakeAdapter, cat: Catalog = catalog([model("llama3.1:8b")])): DownDeps {
  return {
    config,
    loadCatalog: () => cat,
    readState,
    writeState,
    withLock,
    registry: createRegistry([adapter]),
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

function seedOwned(): void {
  writeState(config, {
    schemaVersion: STATE_SCHEMA_VERSION,
    active: {
      backend: "ollama",
      modelId: "llama3.1:8b",
      endpoint: "http://127.0.0.1:11434",
      pid: 9001,
      port: 11434,
      ownedByUs: true,
    },
  });
}

function seedAttached(): void {
  writeState(config, {
    schemaVersion: STATE_SCHEMA_VERSION,
    active: {
      backend: "ollama",
      modelId: "llama3.1:8b",
      endpoint: "http://127.0.0.1:11434",
      port: 11434,
      ownedByUs: false,
    },
  });
}

describe("runDown", () => {
  it("executes the exact reviewed snapshot and returns a typed stopped result", async () => {
    seedOwned();
    const adapter = fakeAdapter();
    const dependencies = deps(adapter);
    const prepared = await prepareDownConfirmation({}, dependencies);
    const events: string[] = [];

    const result = await executePreparedDown(prepared, dependencies, (event) => {
      events.push(`${event.status}:${event.phase}`);
      throw new Error("renderer failed");
    });

    expect(result).toEqual({
      type: "stopped",
      modelId: "llama3.1:8b",
      endpoint: "http://127.0.0.1:11434",
    });
    expect(stdout).toEqual([]);
    expect(events).toEqual([
      "started:locked-revalidate",
      "completed:locked-revalidate",
      "started:state-clear",
      "completed:state-clear",
      "started:stop-detach",
      "completed:stop-detach",
    ]);
  });

  it("is a no-op when no server is active", async () => {
    const adapter = fakeAdapter();

    await withGoldenEnvironment(() => runDown({}, deps(adapter)));

    expect(adapter.stopped).toHaveLength(0);
    expect(readState(config).active).toBeNull();
    expect(stdout.join("")).toMatch(/no active server/i);
  });

  it("stops an owned daemon and clears state", async () => {
    seedOwned();
    const adapter = fakeAdapter();

    await withGoldenEnvironment(() => runDown({}, deps(adapter)));

    expect(adapter.stopped).toHaveLength(1);
    expect(adapter.stopped[0]).toMatchObject({ pid: 9001, port: 11434, ownedByUs: true });
    expect(readState(config).active).toBeNull();
    expectNoninteractiveGolden(plainGoldenName("down"), stdout.join(""));
  });

  it("detaches from an attached daemon without stopping it", async () => {
    seedAttached();
    const adapter = fakeAdapter();

    await runDown({}, deps(adapter));

    expect(adapter.stopped).toHaveLength(0);
    expect(readState(config).active).toBeNull();
    expect(stdout.join("")).toMatch(/not started by local-llmup/i);
  });

  it("stops when the model argument matches the active model", async () => {
    seedOwned();
    const adapter = fakeAdapter();

    await runDown({ model: "llama3.1" }, deps(adapter));

    expect(adapter.stopped).toHaveLength(1);
    expect(readState(config).active).toBeNull();
  });

  it("refuses and preserves state when the model argument does not match", async () => {
    seedOwned();
    const adapter = fakeAdapter();
    const cat = catalog([model("llama3.1:8b"), model("qwen2.5:7b")]);

    await expect(runDown({ model: "qwen2.5" }, deps(adapter, cat))).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(adapter.stopped).toHaveLength(0);
    expect(readState(config).active).not.toBeNull();
  });

  it("preserves state when stopping the daemon fails", async () => {
    seedOwned();
    const adapter = fakeAdapter();
    adapter.stopError = new BackendError("permission denied");

    await expect(runDown({}, deps(adapter))).rejects.toBeInstanceOf(BackendError);

    expect(readState(config).active).not.toBeNull();
  });

  it("does not stop when clearing state fails before stop", async () => {
    seedOwned();
    const adapter = fakeAdapter();

    await expect(
      runDown(
        {},
        {
          ...deps(adapter),
          writeState: () => {
            throw new Error("disk full");
          },
        },
      ),
    ).rejects.toThrow("disk full");

    expect(adapter.stopped).toHaveLength(0);
    expect(readState(config).active).not.toBeNull();
  });

  it("does not clear or signal when state drifts before lock acquisition", async () => {
    seedOwned();
    const adapter = fakeAdapter();
    const base = deps(adapter);

    await expect(
      runDown(
        {},
        {
          ...base,
          withLock: async (_config, fn) => {
            writeState(config, {
              schemaVersion: STATE_SCHEMA_VERSION,
              active: {
                backend: "ollama",
                modelId: "qwen2.5:7b",
                endpoint: "http://127.0.0.1:11434",
                pid: 9002,
                port: 11434,
                ownedByUs: true,
              },
            });
            return await fn();
          },
        },
      ),
    ).rejects.toBeInstanceOf(ConfirmationDriftError);

    expect(adapter.stopped).toEqual([]);
    expect(readState(config).active?.modelId).toBe("qwen2.5:7b");
  });

  it("is idempotent across repeated invocations", async () => {
    seedOwned();
    const adapter = fakeAdapter();

    await runDown({}, deps(adapter));
    await runDown({}, deps(adapter));

    expect(adapter.stopped).toHaveLength(1);
    expect(readState(config).active).toBeNull();
  });
});
