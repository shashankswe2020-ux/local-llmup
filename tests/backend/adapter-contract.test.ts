import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import { assertExactFileMatch, type AcquireRequest } from "../../src/backend/acquire.js";
import type { BackendAdapter, PullOptions, ServeOptions } from "../../src/backend/adapter.js";
import { LlamaCppAdapter } from "../../src/backend/llamacpp.js";
import { createDefaultRegistry } from "../../src/backend/registry.js";
import {
  OllamaAdapter,
  type DigestProbe,
  type FetchFn,
  type FetchResponseLike,
  type SleepFn,
  type SpawnFn,
  type SpawnedProcess,
} from "../../src/backend/ollama.js";
import type { BackendName } from "../../src/types.js";

const noSleep = vi.fn<SleepFn>(() => Promise.resolve());

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
}

interface FakeListener {
  listening: boolean;
  identity: "trusted" | "foreign";
  ready: boolean;
}

interface SpawnHarness {
  readonly spawn: SpawnFn;
  readonly records: SpawnRecord[];
  readonly killed: NodeJS.Signals[];
}

function response(ok: boolean, status: number, body?: unknown): FetchResponseLike {
  return {
    ok,
    status,
    ...(body !== undefined ? { json: () => Promise.resolve(body) } : {}),
  };
}

/** Long-running child-process fake used by every adapter contract registration. */
function makeSpawnHarness(listener: FakeListener, startsListener = true): SpawnHarness {
  const records: SpawnRecord[] = [];
  const killed: NodeJS.Signals[] = [];
  const spawn = vi.fn<SpawnFn>((command, args, options) => {
    records.push({
      command,
      args: [...args],
      shell: (options as { readonly shell?: false }).shell,
      env: options.env,
    });
    if (startsListener) listener.listening = true;

    const closeListeners: Array<(code: number | null) => void> = [];
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      listener.listening = false;
      queueMicrotask(() => {
        for (const onClose of closeListeners) onClose(null);
      });
    };
    const child: SpawnedProcess = {
      pid: 4242,
      stdout: { onData: () => {} },
      stderr: { onData: () => {} },
      onClose: (onClose) => closeListeners.push(onClose),
      onError: () => {},
      kill: (signal = "SIGTERM") => {
        killed.push(signal);
        close();
      },
    };
    return child;
  });
  return { spawn, records, killed };
}

/** Short-lived successful process fake for Ollama pull contract cases. */
function successfulProcessSpawn(records: SpawnRecord[]): SpawnFn {
  return vi.fn<SpawnFn>((command, args, options) => {
    records.push({
      command,
      args: [...args],
      shell: (options as { readonly shell?: false }).shell,
      env: options.env,
    });
    const closeListeners: Array<(code: number | null) => void> = [];
    const child: SpawnedProcess = {
      pid: 4343,
      stdout: { onData: () => {} },
      stderr: { onData: () => {} },
      onClose: (onClose) => closeListeners.push(onClose),
      onError: () => {},
      kill: () => {},
    };
    setTimeout(() => {
      for (const onClose of closeListeners) onClose(0);
    }, 0);
    return child;
  });
}

interface ServeContractInstance {
  readonly adapter: BackendAdapter;
  readonly listener: FakeListener;
  readonly spawn: SpawnHarness;
  readonly options: ServeOptions;
  assertExplicitLoopback(record: SpawnRecord): void;
}

interface IntegrityCase {
  readonly name: string;
  run(): Promise<void>;
}

interface AdapterContract {
  readonly name: BackendName;
  createServe(listener?: Partial<FakeListener>, startsListener?: boolean): ServeContractInstance;
  readonly integrityCases: readonly IntegrityCase[];
}

function ollamaFetch(listener: FakeListener): FetchFn {
  return vi.fn<FetchFn>((url) => {
    if (!listener.listening) return Promise.resolve(response(false, 404));
    const path = new URL(url).pathname;
    if (path === "/api/version") {
      return Promise.resolve(
        listener.identity === "trusted"
          ? response(true, 200, { version: "0.5.0" })
          : response(true, 200, {}),
      );
    }
    if (path === "/v1/models" || path === "/api/tags") {
      return Promise.resolve(response(listener.ready, listener.ready ? 200 : 503));
    }
    return Promise.resolve(response(false, 404));
  });
}

function llamaCppFetch(listener: FakeListener): FetchFn {
  return vi.fn<FetchFn>((url) => {
    if (!listener.listening) return Promise.reject(new Error("ECONNREFUSED"));
    const path = new URL(url).pathname;
    if (path === "/props") {
      return Promise.resolve(
        listener.identity === "trusted"
          ? response(true, 200, { total_slots: 1, model_path: "/cache/model.gguf" })
          : response(false, 404, {}),
      );
    }
    if (path === "/health") {
      return Promise.resolve(
        response(listener.ready, listener.ready ? 200 : 503, {
          status: listener.ready ? "ok" : "loading model",
        }),
      );
    }
    if (path === "/v1/models") return Promise.resolve(response(true, 200, { data: [] }));
    return Promise.resolve(response(false, 404));
  });
}

function ollamaIntegrityCase(
  name: string,
  probe: DigestProbe,
  options: PullOptions,
): IntegrityCase {
  return {
    name,
    async run(): Promise<void> {
      const records: SpawnRecord[] = [];
      const adapter = new OllamaAdapter({ spawn: successfulProcessSpawn(records), probe });
      await expect(adapter.pull(options)).rejects.toBeInstanceOf(BackendError);
      expect(records[0]?.args).toEqual(["pull", "--", options.modelId]);
      expect(records[0]?.shell).toBe(false);
    },
  };
}

function expectedLlamaCppRequest(): AcquireRequest {
  return {
    backend: "llamacpp",
    repo: "Qwen/Qwen3-14B-GGUF",
    revision: "a".repeat(40),
    file: "Qwen3-14B-Q4_K_M.gguf",
    sha256: "b".repeat(64),
  };
}

function llamaCppIntegrityCase(
  name: string,
  failAcquire: (request: AcquireRequest) => Promise<never>,
): IntegrityCase {
  return {
    name,
    async run(): Promise<void> {
      const requests: AcquireRequest[] = [];
      const adapter = new LlamaCppAdapter({
        acquire: vi.fn((request: AcquireRequest) => {
          requests.push(request);
          return failAcquire(request);
        }),
      });
      await expect(
        adapter.pull({
          modelId: "qwen3:14b",
          source: {
            repo: "Qwen/Qwen3-14B-GGUF",
            revision: "a".repeat(40),
            file: "Qwen3-14B-Q4_K_M.gguf",
            sha256: "b".repeat(64),
          },
        }),
      ).rejects.toBeInstanceOf(BackendError);
      expect(requests).toEqual([expectedLlamaCppRequest()]);
    },
  };
}

const CONTRACTS: readonly AdapterContract[] = [
  {
    name: "ollama",
    createServe(overrides = {}, startsListener = true): ServeContractInstance {
      const listener: FakeListener = {
        listening: false,
        identity: "trusted",
        ready: true,
        ...overrides,
      };
      const spawn = makeSpawnHarness(listener, startsListener);
      return {
        adapter: new OllamaAdapter({
          spawn: spawn.spawn,
          fetch: ollamaFetch(listener),
          sleep: noSleep,
        }),
        listener,
        spawn,
        options: { host: "127.0.0.1", port: 11434 },
        assertExplicitLoopback(record): void {
          expect(record.command).toBe("ollama");
          expect(record.args).toEqual(["serve"]);
          expect(record.env?.["OLLAMA_HOST"]).toBe("127.0.0.1:11434");
        },
      };
    },
    integrityCases: [
      ollamaIntegrityCase(
        "fails closed on digest mismatch",
        vi.fn(() => Promise.resolve({ sha256: "a".repeat(64), sizeBytes: 100 })),
        { modelId: "llama3.1:8b", expectedSha256: "b".repeat(64) },
      ),
      ollamaIntegrityCase(
        "fails closed when size-only verification detects a truncated pull",
        vi.fn(() => Promise.resolve({ sizeBytes: 100 })),
        { modelId: "llama3.1:8b", expectedSizeBytes: 4_900_000_000 },
      ),
    ],
  },
  {
    name: "llamacpp",
    createServe(overrides = {}, startsListener = true): ServeContractInstance {
      const listener: FakeListener = {
        listening: false,
        identity: "trusted",
        ready: true,
        ...overrides,
      };
      const spawn = makeSpawnHarness(listener, startsListener);
      return {
        adapter: new LlamaCppAdapter({
          spawn: spawn.spawn,
          fetch: llamaCppFetch(listener),
          sleep: noSleep,
        }),
        listener,
        spawn,
        options: { host: "127.0.0.1", port: 8080, modelPath: "/cache/model.gguf" },
        assertExplicitLoopback(record): void {
          expect(record.command).toBe("llama-server");
          expect(record.args).toEqual([
            "-m",
            "/cache/model.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "8080",
          ]);
          expect(record.env).toBeUndefined();
        },
      };
    },
    integrityCases: [
      llamaCppIntegrityCase("fails closed on digest mismatch", (request) => {
        expect(request.sha256).toBe("b".repeat(64));
        return Promise.reject(new BackendError(`digest mismatch for ${request.file}`));
      }),
      llamaCppIntegrityCase("fails closed on revision mismatch", (request) => {
        expect(request.revision).toBe("a".repeat(40));
        return Promise.reject(
          new BackendError(`resolved commit does not match pinned revision ${request.revision}`),
        );
      }),
      llamaCppIntegrityCase("fails closed on zero exact-file matches", (request) => {
        expect(() => assertExactFileMatch([], request.file)).toThrow(BackendError);
        return Promise.reject(new BackendError(`weight download failed (HTTP 404) for ${request.file}`));
      }),
      llamaCppIntegrityCase("fails closed on multiple exact-file matches", (request) => {
        expect(() => assertExactFileMatch([request.file, request.file], request.file)).toThrow(
          BackendError,
        );
        return Promise.reject(new BackendError(`ambiguous weight file: ${request.file}`));
      }),
    ],
  },
];

describe("BackendAdapter contract registration", () => {
  it("covers every adapter in the default registry", () => {
    expect(CONTRACTS.map((contract) => contract.name)).toEqual(
      createDefaultRegistry()
        .all()
        .map((adapter) => adapter.name),
    );
  });
});

describe.each(CONTRACTS)("BackendAdapter contract — $name", (contract) => {
  it("spawns with an explicit loopback bind, discrete argv, and shell:false", async () => {
    const instance = contract.createServe();

    const handle = await instance.adapter.serve(instance.options);

    expect(handle.ownedByUs).toBe(true);
    expect(handle.endpoint).toContain("127.0.0.1");
    expect(instance.spawn.records).toHaveLength(1);
    const record = instance.spawn.records[0];
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("expected one spawn record");
    expect(Array.isArray(record.args)).toBe(true);
    expect(record.shell).toBe(false);
    instance.assertExplicitLoopback(record);
  });

  it("refuses non-loopback without probing, spawning, or claiming ownership", async () => {
    const instance = contract.createServe();

    await expect(
      instance.adapter.serve({ ...instance.options, host: "0.0.0.0" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(instance.spawn.records).toHaveLength(0);
    expect(instance.listener.listening).toBe(false);
  });

  it("refuses a foreign listener during port-ownership preflight", async () => {
    const instance = contract.createServe({ listening: true, identity: "foreign" });

    await expect(instance.adapter.serve(instance.options)).rejects.toBeInstanceOf(BackendError);

    expect(instance.spawn.records).toHaveLength(0);
  });

  it("attaches to a trusted listener without claiming ownership", async () => {
    const instance = contract.createServe({ listening: true, identity: "trusted", ready: true });

    const handle = await instance.adapter.serve(instance.options);

    expect(handle.ownedByUs).toBe(false);
    expect(handle.pid).toBe(0);
    expect(instance.spawn.records).toHaveLength(0);
  });

  it("stops an owned child when readiness never succeeds", async () => {
    const instance = contract.createServe({ ready: false }, false);

    await expect(instance.adapter.serve(instance.options)).rejects.toBeInstanceOf(BackendError);

    expect(instance.spawn.records).toHaveLength(1);
    expect(instance.spawn.killed).toEqual(["SIGTERM"]);
  });

  it("times out readiness with a typed backend error", async () => {
    const instance = contract.createServe({ listening: false }, false);
    const host = instance.options.host;
    const port = instance.options.port;
    if (host === undefined || port === undefined) {
      throw new Error("contract serve options must define host and port");
    }

    await expect(
      instance.adapter.waitUntilReady({
        endpoint: `http://${host}:${port}`,
        retries: 2,
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  for (const integrityCase of contract.integrityCases) {
    it(integrityCase.name, async () => {
      await integrityCase.run();
    });
  }
});
