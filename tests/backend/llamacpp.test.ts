import { describe, expect, it, vi } from "vitest";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BackendError, ValidationError } from "../../src/errors.js";
import { LlamaCppAdapter } from "../../src/backend/llamacpp.js";
import { createDefaultRegistry } from "../../src/backend/registry.js";
import type { AcquireRequest, AcquireResult } from "../../src/backend/acquire.js";
import type {
  FetchFn,
  FetchResponseLike,
  KillFn,
  SleepFn,
  SpawnFn,
  SpawnedProcess,
} from "../../src/backend/ollama.js";

interface FakeSpawnConfig {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly throwError?: Error;
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Build a {@link SpawnFn} that records its invocations and, on the next tick,
 * emits the configured stdout/stderr then closes with the configured exit code.
 * A `throwError` makes the spawn throw synchronously (models ENOENT etc.).
 */
function fakeSpawn(config: FakeSpawnConfig = {}): {
  spawn: SpawnFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args: [...args] });
    if (config.throwError !== undefined) {
      throw config.throwError;
    }
    let onOut: ((chunk: string) => void) | null = null;
    let onErr: ((chunk: string) => void) | null = null;
    const child: SpawnedProcess = {
      pid: 4321,
      stdout: {
        onData: (listener) => {
          onOut = listener;
        },
      },
      stderr: {
        onData: (listener) => {
          onErr = listener;
        },
      },
      onClose: (listener) => {
        setTimeout(() => {
          if (config.stdout !== undefined && onOut !== null) onOut(config.stdout);
          if (config.stderr !== undefined && onErr !== null) onErr(config.stderr);
          listener(config.code ?? 0);
        }, 0);
      },
      onError: () => {},
      kill: () => {},
    };
    return child;
  };
  return { spawn, calls };
}

describe("LlamaCppAdapter — capabilities", () => {
  it("advertises the llama.cpp descriptor", () => {
    const adapter = new LlamaCppAdapter();
    expect(adapter.name).toBe("llamacpp");
    expect(adapter.capabilities).toEqual({
      canPull: true,
      canEmbed: false,
      openAiCompatible: true,
      formats: ["gguf"],
      defaultPort: 8080,
    });
  });
});

describe("LlamaCppAdapter — isInstalled", () => {
  it("returns true when `llama-server --version` exits zero", async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.isInstalled()).resolves.toBe(true);
    expect(calls[0]).toEqual({ command: "llama-server", args: ["--version"] });
  });

  it("returns false on a non-zero exit", async () => {
    const { spawn } = fakeSpawn({ code: 1 });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.isInstalled()).resolves.toBe(false);
  });

  it("returns false when the binary is missing (spawn throws)", async () => {
    const enoent = Object.assign(new Error("spawn llama-server ENOENT"), { code: "ENOENT" });
    const { spawn } = fakeSpawn({ throwError: enoent });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.isInstalled()).resolves.toBe(false);
  });
});

describe("LlamaCppAdapter — installHint", () => {
  it("gives a macOS hint mentioning llama.cpp", () => {
    const adapter = new LlamaCppAdapter({ platform: "darwin" });
    expect(adapter.installHint().toLowerCase()).toContain("llama.cpp");
  });

  it("gives a non-empty hint for every platform", () => {
    for (const platform of ["darwin", "linux", "win32", "freebsd"] as NodeJS.Platform[]) {
      const hint = new LlamaCppAdapter({ platform }).installHint();
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.toLowerCase()).toContain("llama");
    }
  });
});

describe("LlamaCppAdapter — version", () => {
  it("extracts the llama.cpp build number from `version:` output", async () => {
    const { spawn } = fakeSpawn({ code: 0, stderr: "version: 3860 (a1b2c3d)\nbuilt with clang\n" });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.version?.()).resolves.toBe("3860");
  });

  it("prefers the build number over a compiler semver banner", async () => {
    const { spawn } = fakeSpawn({
      code: 0,
      stderr:
        "version: 3860 (a1b2c3d)\nbuilt with Apple clang version 15.0.0 (clang-1500.0.40.1)\n",
    });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.version?.()).resolves.toBe("3860");
  });

  it("returns null on a non-zero exit", async () => {
    const { spawn } = fakeSpawn({ code: 1, stderr: "boom" });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.version?.()).resolves.toBeNull();
  });

  it("strips control characters from the reported version", async () => {
    const { spawn } = fakeSpawn({ code: 0, stdout: "version: 3\u001b[31m860\n" });
    const adapter = new LlamaCppAdapter({ spawn });
    const reported = await adapter.version?.();
    expect(reported).not.toBeNull();
    // eslint-disable-next-line no-control-regex
    expect(reported).not.toMatch(/\u001b/);
  });

  it("returns null when the spawn fails", async () => {
    const { spawn } = fakeSpawn({ throwError: new Error("nope") });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.version?.()).resolves.toBeNull();
  });
});

describe("LlamaCppAdapter — chat", () => {
  it("round-trips against the OpenAI-compatible /v1/chat/completions endpoint", async () => {
    const seen: { url: string; init: unknown } = { url: "", init: undefined };
    const fetch: FetchFn = (url, init) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(
        jsonResponse(true, 200, { choices: [{ message: { content: "hi there" } }] }),
      );
    };
    const listener = {
      pid: 42,
      process: "llama-server",
      executable: "/nonexistent/llama-server",
      started: "2026-08-08 00:00:00",
      localAddress: "127.0.0.1",
    };
    const adapter = new LlamaCppAdapter({
      fetch,
      binary: "/nonexistent/llama-server",
      listenerProbe: async () => listener,
    });
    const result = await adapter.chat({
      endpoint: "http://127.0.0.1:18080",
      model: "Qwen3-14B",
      messages: [{ role: "user", content: "hello" }],
      expectedProcess: {
        pid: listener.pid,
        executable: listener.executable,
        started: listener.started,
      },
    });
    expect(result).toEqual({ content: "hi there" });
    expect(seen.url).toBe("http://127.0.0.1:18080/v1/chat/completions");
    const init = seen.init as { method?: string; body?: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({
      model: "Qwen3-14B",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
  });

  it("rejects a substituted listener before sending chat content", async () => {
    const fetch = vi.fn<FetchFn>(() =>
      Promise.resolve(
        jsonResponse(true, 200, { choices: [{ message: { content: "unsafe" } }] }),
      ),
    );
    const adapter = new LlamaCppAdapter({
      fetch,
      binary: "/nonexistent/llama-server",
      listenerProbe: async () => ({
        pid: 42,
        process: "llama-server",
        executable: "/nonexistent/llama-server",
        started: "2026-08-08 00:00:00",
        localAddress: "127.0.0.1",
      }),
    });
    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18080",
        model: "Qwen3-14B",
        messages: [{ role: "user", content: "secret history" }],
        expectedProcess: {
          pid: 99,
          executable: "/replacement/process",
          started: "later",
        },
      }),
    ).rejects.toThrow("does not match expected process identity");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws BackendError on a non-2xx status", async () => {
    const fetch: FetchFn = () => Promise.resolve(jsonResponse(false, 500, {}));
    const adapter = new LlamaCppAdapter({ fetch });
    await expect(adapter.chat({ model: "m", messages: [] })).rejects.toBeInstanceOf(BackendError);
  });

  it("refuses a non-loopback chat endpoint", async () => {
    const fetch = vi.fn<FetchFn>();
    const adapter = new LlamaCppAdapter({ fetch });
    await expect(
      adapter.chat({ endpoint: "http://example.com", model: "m", messages: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws BackendError when the transport fails", async () => {
    const fetch: FetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
    const adapter = new LlamaCppAdapter({ fetch });
    await expect(adapter.chat({ model: "m", messages: [] })).rejects.toBeInstanceOf(BackendError);
  });

  it("throws BackendError on a malformed body (no choices)", async () => {
    const fetch: FetchFn = () => Promise.resolve(jsonResponse(true, 200, { choices: [] }));
    const adapter = new LlamaCppAdapter({ fetch });
    await expect(adapter.chat({ model: "m", messages: [] })).rejects.toBeInstanceOf(BackendError);
  });
});

describe("LlamaCppAdapter — embed (fail-closed)", () => {
  it("rejects with BackendError because canEmbed is false", async () => {
    const adapter = new LlamaCppAdapter();
    await expect(adapter.embed({ model: "m", input: [] })).rejects.toBeInstanceOf(BackendError);
  });
});

describe("LlamaCppAdapter — pull", () => {
  it("acquires a pinned gguf and returns the on-disk path + digest status", async () => {
    const requests: AcquireRequest[] = [];
    const acquire = (request: AcquireRequest): Promise<AcquireResult> => {
      requests.push(request);
      return Promise.resolve({
        path: "/cache/qwen3-14b-q4.gguf",
        bytes: 9_000_000,
        digestVerified: true,
        cached: false,
      });
    };
    const events: string[] = [];
    const adapter = new LlamaCppAdapter({ acquire });
    const result = await adapter.pull({
      modelId: "qwen3-14b",
      source: {
        repo: "Qwen/Qwen3-14B-GGUF",
        revision: "a".repeat(40),
        file: "qwen3-14b-q4.gguf",
        sha256: "b".repeat(64),
      },
      onProgress: (event) => events.push(event.status),
    });
    expect(result).toEqual({
      modelId: "qwen3-14b",
      digestVerified: true,
      modelPath: "/cache/qwen3-14b-q4.gguf",
    });
    expect(requests[0]).toEqual({
      backend: "llamacpp",
      repo: "Qwen/Qwen3-14B-GGUF",
      revision: "a".repeat(40),
      file: "qwen3-14b-q4.gguf",
      sha256: "b".repeat(64),
    });
    expect(events).toContain("downloaded qwen3-14b-q4.gguf");
  });

  it("reports a cache hit in progress without changing the result path", async () => {
    const acquire = (): Promise<AcquireResult> =>
      Promise.resolve({ path: "/cache/x.gguf", bytes: 10, digestVerified: true, cached: true });
    const events: string[] = [];
    const adapter = new LlamaCppAdapter({ acquire });
    const result = await adapter.pull({
      modelId: "x",
      source: {
        repo: "o/r",
        revision: "c".repeat(40),
        file: "x.gguf",
        sha256: "d".repeat(64),
      },
      onProgress: (event) => events.push(event.status),
    });
    expect(result.modelPath).toBe("/cache/x.gguf");
    expect(result.digestVerified).toBe(true);
    expect(events).toContain("cached x.gguf");
  });

  it("refuses a pinned source without a catalog digest", async () => {
    const acquire = vi.fn(() => Promise.reject(new Error("must not acquire")));
    const adapter = new LlamaCppAdapter({ acquire });
    await expect(
      adapter.pull({
        modelId: "x",
        source: { repo: "o/r", revision: "c".repeat(40), file: "x.gguf" },
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("refuses to pull without a pinned weight source", async () => {
    const adapter = new LlamaCppAdapter({
      acquire: () => Promise.reject(new Error("acquire must not be called")),
    });
    await expect(adapter.pull({ modelId: "m" })).rejects.toBeInstanceOf(BackendError);
  });

  it("propagates a fail-closed acquire error (digest/revision/file mismatch)", async () => {
    const adapter = new LlamaCppAdapter({
      acquire: () => Promise.reject(new BackendError("sha256 mismatch")),
    });
    await expect(
      adapter.pull({
        modelId: "m",
        source: { repo: "o/r", revision: "d".repeat(40), file: "m.gguf" },
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

// ── serve/ready/stop lifecycle fakes (B14b) ────────────────────────────────

interface FakeServer {
  listening: boolean;
  identity: "llama" | "foreign";
  healthy: boolean;
}

function jsonResponse(ok: boolean, status: number, body: unknown): FetchResponseLike {
  return { ok, status, json: () => Promise.resolve(body) };
}

/**
 * A coordinated fake `fetch` over an in-memory {@link FakeServer}: when not
 * listening every request rejects (connection refused); when listening it
 * answers `/health`, `/v1/models`, and the llama.cpp-specific `/props` identity
 * endpoint (which a `foreign` server fails).
 */
function makeFetch(server: FakeServer): FetchFn {
  return (url) => {
    if (!server.listening) {
      return Promise.reject(new Error("ECONNREFUSED"));
    }
    const path = new URL(url).pathname;
    if (path === "/props") {
      return Promise.resolve(
        server.identity === "llama"
          ? jsonResponse(true, 200, {
              total_slots: 1,
              model_path: "/tmp/m.gguf",
              model_alias: "qwen3:14b",
            })
          : jsonResponse(false, 404, {}),
      );
    }
    if (path === "/health") {
      return Promise.resolve(
        jsonResponse(server.healthy, server.healthy ? 200 : 503, {
          status: server.healthy ? "ok" : "loading model",
        }),
      );
    }
    if (path === "/v1/models") {
      return Promise.resolve(jsonResponse(true, 200, { object: "list", data: [] }));
    }
    return Promise.resolve(jsonResponse(false, 404, {}));
  };
}

interface ServeSpawnConfig {
  readonly pid?: number | undefined;
  readonly throwError?: Error | undefined;
  /** Server the child "brings up" on spawn (flips `listening` true). */
  readonly server?: FakeServer | undefined;
  /** When set, the child closes with this code on the next tick (early exit). */
  readonly exitCode?: number | null | undefined;
}

function makeServeSpawn(config: ServeSpawnConfig = {}): {
  spawn: SpawnFn;
  calls: { command: string; args: readonly string[] }[];
  closeChild: (code: number | null) => void;
} {
  const calls: { command: string; args: readonly string[] }[] = [];
  let closeListener: ((code: number | null) => void) | null = null;
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args: [...args] });
    if (config.throwError !== undefined) {
      throw config.throwError;
    }
    if (config.server !== undefined) {
      config.server.listening = true;
    }
    const child: SpawnedProcess = {
      pid: config.pid ?? 9876,
      stdout: { onData: () => {} },
      stderr: { onData: () => {} },
      onClose: (listener) => {
        closeListener = listener;
        if (config.exitCode !== undefined) {
          setTimeout(() => listener(config.exitCode ?? null), 0);
        }
      },
      onError: () => {},
      // A real child exits on SIGTERM/SIGKILL; emit close so teardown is prompt.
      kill: () => {
        closeListener?.(null);
      },
    };
    return child;
  };
  return {
    spawn,
    calls,
    closeChild: (code) => closeListener?.(code),
  };
}

const noSleep: SleepFn = () => Promise.resolve();
function testExecutable(binary: string): string {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, binary);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return `/nonexistent/${binary}`;
}
const llamaListener =
  (pid = 4242, server?: FakeServer) =>
  async () =>
    server !== undefined && !server.listening
      ? null
      : {
          pid,
          process: "llama-server",
          executable: testExecutable("llama-server"),
          started: "2026-08-07T00:00:00Z",
          localAddress: "127.0.0.1",
        };

describe("LlamaCppAdapter — serve (loopback + port preflight)", () => {
  it("refuses a non-loopback bind without an explicit opt-in and spawns nothing", async () => {
    const { spawn, calls } = makeServeSpawn();
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const adapter = new LlamaCppAdapter({
      spawn,
      fetch: makeFetch(server),
      sleep: noSleep,
      listenerProbe: llamaListener(),
    });
    await expect(
      adapter.serve({ host: "0.0.0.0", port: 8080, modelPath: "/tmp/m.gguf" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("attaches to a running llama-server without claiming ownership", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: true };
    const { spawn, calls } = makeServeSpawn();
    const adapter = new LlamaCppAdapter({
      spawn,
      fetch: makeFetch(server),
      sleep: noSleep,
      listenerProbe: llamaListener(),
    });
    const handle = await adapter.serve({
      port: 8080,
      modelPath: "/tmp/m.gguf",
      modelId: "qwen3:14b",
    });
    expect(handle.ownedByUs).toBe(false);
    expect(handle.pid).toBe(4242);
    expect(handle.endpoint).toBe("http://127.0.0.1:8080");
    expect(calls).toHaveLength(0);
  });

  it("does not attach while /health reports the model is still loading", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: false };
    const { spawn, calls } = makeServeSpawn();
    const adapter = new LlamaCppAdapter({
      spawn,
      fetch: makeFetch(server),
      sleep: noSleep,
      listenerProbe: llamaListener(4242, server),
    });
    await expect(adapter.serve({ port: 8080, modelPath: "/tmp/m.gguf" })).rejects.toBeInstanceOf(
      BackendError,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses to attach to a foreign listener on the port", async () => {
    const server: FakeServer = { listening: true, identity: "foreign", healthy: true };
    const { spawn, calls } = makeServeSpawn();
    const adapter = new LlamaCppAdapter({ spawn, fetch: makeFetch(server), sleep: noSleep });
    await expect(adapter.serve({ port: 8080, modelPath: "/tmp/m.gguf" })).rejects.toBeInstanceOf(
      BackendError,
    );
    expect(calls).toHaveLength(0);
  });

  it("spawns an owned llama-server with an arg-array, shell:false, loopback bind", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const { spawn, calls } = makeServeSpawn({ pid: 4242, server });
    const adapter = new LlamaCppAdapter({
      spawn,
      fetch: makeFetch(server),
      sleep: noSleep,
      listenerProbe: llamaListener(4242, server),
    });
    const handle = await adapter.serve({
      port: 8080,
      modelPath: "/tmp/m.gguf",
      modelId: "qwen3:14b",
    });
    expect(handle.ownedByUs).toBe(true);
    expect(handle.pid).toBe(4242);
    expect(handle.endpoint).toBe("http://127.0.0.1:8080");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("llama-server");
    expect(calls[0]?.args).toEqual([
      "-m",
      "/tmp/m.gguf",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "--alias",
      "qwen3:14b",
    ]);
  });

  it("refuses to attach when /props reports different model weights", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: true };
    const fetch = vi.fn<FetchFn>((url) => {
      if (new URL(url).pathname === "/props") {
        return Promise.resolve(jsonResponse(true, 200, { model_path: "/tmp/other.gguf" }));
      }
      return makeFetch(server)(url);
    });
    const { spawn, calls } = makeServeSpawn();
    const adapter = new LlamaCppAdapter({ spawn, fetch, sleep: noSleep });
    await expect(
      adapter.serve({ port: 8080, modelPath: "/tmp/requested.gguf" }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(calls).toHaveLength(0);
  });

  it("refuses to attach when /props reports a different model alias", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: true };
    const fetch = vi.fn<FetchFn>((url) => {
      if (new URL(url).pathname === "/props") {
        return Promise.resolve(
          jsonResponse(true, 200, {
            model_path: "/tmp/m.gguf",
            model_alias: "other:model",
          }),
        );
      }
      return makeFetch(server)(url);
    });
    const { spawn, calls } = makeServeSpawn();
    const adapter = new LlamaCppAdapter({
      spawn,
      fetch,
      sleep: noSleep,
      listenerProbe: llamaListener(),
    });
    await expect(
      adapter.serve({
        port: 8080,
        modelPath: "/tmp/m.gguf",
        modelId: "qwen3:14b",
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(calls).toHaveLength(0);
  });

  it("requires a model path before spawning its own server", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const { spawn, calls } = makeServeSpawn({ server });
    const adapter = new LlamaCppAdapter({ spawn, fetch: makeFetch(server), sleep: noSleep });
    await expect(adapter.serve({ port: 8080 })).rejects.toBeInstanceOf(BackendError);
    expect(calls).toHaveLength(0);
  });

  it("stops the child and throws when readiness never passes", async () => {
    // Server stays down even after spawn → readiness never succeeds.
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const { spawn } = makeServeSpawn({ pid: 4242 }); // does NOT flip listening
    const killed = vi.fn<KillFn>();
    const adapter = new LlamaCppAdapter({
      spawn,
      fetch: makeFetch(server),
      sleep: noSleep,
      kill: killed,
    });
    await expect(adapter.serve({ port: 8080, modelPath: "/tmp/m.gguf" })).rejects.toBeInstanceOf(
      BackendError,
    );
  });

  it("fails when the spawned server exits before becoming ready", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const { spawn } = makeServeSpawn({ pid: 4242, exitCode: 1 }); // never listens; exits
    const adapter = new LlamaCppAdapter({ spawn, fetch: makeFetch(server), sleep: noSleep });
    await expect(adapter.serve({ port: 8080, modelPath: "/tmp/m.gguf" })).rejects.toBeInstanceOf(
      BackendError,
    );
  });

  it("does not report an owned server ready while the model is still loading (/health 503)", async () => {
    // Server comes up on spawn but /health stays 503 (loading); /v1/models is
    // 200. Readiness must gate on /health and never mask the load via /v1/models.
    const server: FakeServer = { listening: false, identity: "llama", healthy: false };
    const { spawn } = makeServeSpawn({ pid: 4242, server });
    const adapter = new LlamaCppAdapter({ spawn, fetch: makeFetch(server), sleep: noSleep });
    await expect(adapter.serve({ port: 8080, modelPath: "/tmp/m.gguf" })).rejects.toBeInstanceOf(
      BackendError,
    );
  });

  it("refuses a model path that starts with a dash and spawns nothing", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const { spawn, calls } = makeServeSpawn({ server });
    const adapter = new LlamaCppAdapter({ spawn, fetch: makeFetch(server), sleep: noSleep });
    await expect(adapter.serve({ port: 8080, modelPath: "--n-gpu-layers" })).rejects.toBeInstanceOf(
      BackendError,
    );
    expect(calls).toHaveLength(0);
  });

  it("aborts before spawning when the caller's signal is already aborted", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const { spawn, calls } = makeServeSpawn({ server });
    const adapter = new LlamaCppAdapter({ spawn, fetch: makeFetch(server), sleep: noSleep });
    await expect(
      adapter.serve({ port: 8080, modelPath: "/tmp/m.gguf", signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(calls).toHaveLength(0);
  });
});

describe("LlamaCppAdapter — waitUntilReady", () => {
  it("resolves once /v1/models responds", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: true };
    const adapter = new LlamaCppAdapter({ fetch: makeFetch(server), sleep: noSleep });
    await expect(
      adapter.waitUntilReady({ endpoint: "http://127.0.0.1:8080" }),
    ).resolves.toBeUndefined();
  });

  it("throws after exhausting retries when never ready", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const adapter = new LlamaCppAdapter({ fetch: makeFetch(server), sleep: noSleep });
    await expect(
      adapter.waitUntilReady({ endpoint: "http://127.0.0.1:8080", retries: 3, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

describe("LlamaCppAdapter — stop (ownership)", () => {
  it("is a no-op for an attached (foreign) server", async () => {
    const killed = vi.fn<KillFn>();
    const adapter = new LlamaCppAdapter({ kill: killed });
    await adapter.stop({
      endpoint: "http://127.0.0.1:8080",
      pid: 0,
      port: 8080,
      ownedByUs: false,
    });
    expect(killed).not.toHaveBeenCalled();
  });

  it("refuses to signal an owned pid when the endpoint fails llama-server identity", async () => {
    const server: FakeServer = { listening: true, identity: "foreign", healthy: true };
    const killed = vi.fn<KillFn>();
    const adapter = new LlamaCppAdapter({
      fetch: makeFetch(server),
      sleep: noSleep,
      kill: killed,
      listenerProbe: llamaListener(),
    });

    await expect(
      adapter.stop({
        endpoint: "http://127.0.0.1:8080",
        pid: 4242,
        port: 8080,
        ownedByUs: true,
      }),
    ).rejects.toBeInstanceOf(BackendError);

    expect(killed).not.toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("refuses to stop an owned server with a non-positive pid", async () => {
    const killed = vi.fn<KillFn>();
    const adapter = new LlamaCppAdapter({ kill: killed });
    await expect(
      adapter.stop({ endpoint: "http://127.0.0.1:8080", pid: 0, port: 8080, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(killed).not.toHaveBeenCalled();
  });

  it("terminates an owned, reachable server", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: true };
    const signals: (NodeJS.Signals | 0)[] = [];
    const kill: KillFn = (_pid, signal) => {
      signals.push(signal ?? "SIGTERM");
      if (signal === 0 && signals.filter((s) => s === 0).length > 1) {
        const err = Object.assign(new Error("no such process"), { code: "ESRCH" });
        throw err;
      }
    };
    const adapter = new LlamaCppAdapter({
      fetch: makeFetch(server),
      sleep: noSleep,
      kill,
      listenerProbe: llamaListener(),
    });
    await adapter.stop({
      endpoint: "http://127.0.0.1:8080",
      pid: 4242,
      port: 8080,
      ownedByUs: true,
    });
    expect(signals).toContain("SIGTERM");
  });

  it("refuses SIGKILL when process identity changes during shutdown polling", async () => {
    const server: FakeServer = { listening: true, identity: "llama", healthy: true };
    const signals: (NodeJS.Signals | 0)[] = [];
    const adapter = new LlamaCppAdapter({
      fetch: makeFetch(server),
      sleep: noSleep,
      kill: (_pid, signal) => signals.push(signal ?? "SIGTERM"),
      listenerProbe: llamaListener(),
      processProbe: async (pid) => ({
        pid,
        process: "replacement",
        executable: "/replacement/process",
        started: "later",
      }),
    });

    await expect(
      adapter.stop({
        endpoint: "http://127.0.0.1:8080",
        pid: 4242,
        port: 8080,
        ownedByUs: true,
      }),
    ).rejects.toThrow("process identity changed");
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
  });

  it("refuses to stop when the endpoint is unreachable (possible pid reuse)", async () => {
    const server: FakeServer = { listening: false, identity: "llama", healthy: true };
    const kill: KillFn = () => {
      /* pid 0-probe succeeds → process still alive */
    };
    const adapter = new LlamaCppAdapter({ fetch: makeFetch(server), sleep: noSleep, kill });
    await expect(
      adapter.stop({ endpoint: "http://127.0.0.1:8080", pid: 4242, port: 8080, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

describe("createDefaultRegistry — llama.cpp registration", () => {
  it("registers llama.cpp alongside ollama", () => {
    const registry = createDefaultRegistry();
    expect(registry.all().map((a) => a.name)).toEqual(["ollama", "llamacpp", "mlx", "lmstudio"]);
    expect(registry.get("llamacpp")).toBeInstanceOf(LlamaCppAdapter);
  });
});
