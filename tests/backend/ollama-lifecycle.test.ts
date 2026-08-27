import { describe, expect, it, vi } from "vitest";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BackendError, ValidationError } from "../../src/errors.js";
import {
  OllamaAdapter,
  type FetchFn,
  type FetchResponseLike,
  type KillFn,
  type SleepFn,
  type SpawnFn,
  type SpawnedProcess,
} from "../../src/backend/ollama.js";

const ENDPOINT = "http://127.0.0.1:11434";
const ok: FetchResponseLike = { ok: true, status: 200 };
const notFound: FetchResponseLike = { ok: false, status: 404 };

/** A sleep that resolves immediately (no real waiting in tests). */
const immediateSleep: SleepFn = () => Promise.resolve();
function testExecutable(binary: string): string {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, binary);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return `/nonexistent/${binary}`;
}
const ollamaListener =
  (pid = 9001) =>
  async () => ({
    pid,
    process: "ollama",
    executable: testExecutable("ollama"),
    started: "2026-08-07T00:00:00Z",
    localAddress: "127.0.0.1",
  });

interface RecordedSpawn {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Build a {@link SpawnFn} for a long-running `serve` process: it records each
 * invocation, hands back a child with the configured pid, and counts `kill`s.
 * Optionally emits an async `error` or early `close` (as the real child_process
 * does) on the next tick, after the adapter has attached its listeners.
 */
function fakeServeSpawn(
  config: {
    pid?: number;
    noPid?: boolean;
    error?: Error;
    exitCode?: number;
    exitOnSignal?: NodeJS.Signals | null;
  } = {},
): {
  spawn: SpawnFn;
  recorded: RecordedSpawn[];
  state: { kills: number; killSignals: Array<NodeJS.Signals | undefined> };
} {
  const recorded: RecordedSpawn[] = [];
  const state = { kills: 0, killSignals: [] as Array<NodeJS.Signals | undefined> };
  const spawn: SpawnFn = (command, args, options) => {
    recorded.push({ command, args, env: options.env, signal: options.signal });
    const errorListeners: ((error: Error) => void)[] = [];
    const closeListeners: ((code: number | null) => void)[] = [];
    let closed = false;
    const emitClose = (code: number | null): void => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener(code);
    };
    if (config.error !== undefined || config.exitCode !== undefined) {
      setTimeout(() => {
        if (config.error !== undefined) {
          for (const listener of errorListeners) listener(config.error);
        } else {
          emitClose(config.exitCode ?? 0);
        }
      }, 0);
    }
    const child: SpawnedProcess = {
      pid: config.noPid ? undefined : (config.pid ?? 4242),
      stdout: { onData: () => {} },
      stderr: { onData: () => {} },
      onClose: (listener) => closeListeners.push(listener),
      onError: (listener) => errorListeners.push(listener),
      kill: (signal) => {
        if (closed) return;
        state.kills += 1;
        state.killSignals.push(signal);
        const exitOnSignal = config.exitOnSignal ?? "SIGTERM";
        if (exitOnSignal !== null && signal === exitOnSignal) {
          setTimeout(() => emitClose(null), 0);
        }
      },
    };
    return child;
  };
  return { spawn, recorded, state };
}

/**
 * A fetch that reports "not reachable" until the daemon has been spawned, then
 * hangs — so the pre-spawn attach probe returns quickly while the post-spawn
 * readiness wait stays pending (letting an async error/exit win the race).
 */
function notReachableThenHanging(recorded: readonly unknown[]): FetchFn {
  return () =>
    recorded.length > 0 ? new Promise<FetchResponseLike>(() => {}) : Promise.resolve(notFound);
}

function trustedOllamaFetch(): FetchFn {
  return vi.fn((url: string) =>
    Promise.resolve(
      url.endsWith("/api/version")
        ? { ok: true, status: 200, json: () => Promise.resolve({ version: "0.5.0" }) }
        : ok,
    ),
  );
}

function spawnedOllamaFetch(recorded: readonly unknown[]): FetchFn {
  return vi.fn((url: string) => {
    if (recorded.length === 0) return Promise.resolve(notFound);
    return Promise.resolve(
      url.endsWith("/api/version")
        ? { ok: true, status: 200, json: () => Promise.resolve({ version: "0.5.0" }) }
        : ok,
    );
  });
}

function spawnedOllamaListener(recorded: readonly unknown[], pid = 4242) {
  return async () => (recorded.length === 0 ? null : await ollamaListener(pid)());
}

function ownedOllamaAdapter(fetch: FetchFn, kill: KillFn): OllamaAdapter {
  const executable = testExecutable("ollama");
  return new OllamaAdapter({
    fetch,
    kill,
    sleep: immediateSleep,
    listenerProbe: ollamaListener(),
    processProbe: async (pid) => ({
      pid,
      process: "ollama",
      executable,
      started: "2026-08-07T00:00:00Z",
    }),
  });
}

describe("OllamaAdapter.serve", () => {
  it("attaches to an already-running daemon without spawning", async () => {
    const fetch = vi.fn<FetchFn>((url) => {
      if (url.endsWith("/api/version")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ version: "0.4.0" }),
        });
      }
      return Promise.resolve(ok);
    });
    const { spawn, recorded } = fakeServeSpawn();
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: ollamaListener(5151),
    });

    const handle = await adapter.serve();

    expect(handle.ownedByUs).toBe(false);
    expect(handle.endpoint).toBe(ENDPOINT);
    expect(handle.port).toBe(11434);
    expect(handle.pid).toBe(5151);
    expect(fetch).toHaveBeenCalledWith(`${ENDPOINT}/api/version`, expect.any(Object));
    expect(recorded).toHaveLength(0);
  });

  it("refuses to attach to a reachable listener that fails identity checks", async () => {
    const fetch = vi.fn<FetchFn>((url) => {
      if (url.endsWith("/api/version")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }
      return Promise.resolve(ok);
    });
    const { spawn, recorded } = fakeServeSpawn();
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    expect(recorded).toHaveLength(0);
  });

  it("spawns a loopback-bound daemon when none is running", async () => {
    const { spawn, recorded } = fakeServeSpawn({ pid: 9001 });
    // Only reachable once we have started our own daemon.
    const fetch = spawnedOllamaFetch(recorded);
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: spawnedOllamaListener(recorded, 9001),
    });

    const handle = await adapter.serve();

    expect(handle.ownedByUs).toBe(true);
    expect(handle.pid).toBe(9001);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.command).toBe("ollama");
    expect(recorded[0]?.args).toEqual(["serve"]);
    expect(recorded[0]?.env?.["OLLAMA_HOST"]).toBe("127.0.0.1:11434");
  });

  it("binds the requested host and port", async () => {
    const { spawn, recorded } = fakeServeSpawn();
    const fetch = spawnedOllamaFetch(recorded);
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: spawnedOllamaListener(recorded),
    });

    const handle = await adapter.serve({ host: "127.0.0.1", port: 12000 });

    expect(handle.endpoint).toBe("http://127.0.0.1:12000");
    expect(recorded[0]?.env?.["OLLAMA_HOST"]).toBe("127.0.0.1:12000");
  });

  it("does not inherit ambient OLLAMA security-sensitive env vars into spawned daemon", async () => {
    const previousOrigins = process.env["OLLAMA_ORIGINS"];
    const previousModels = process.env["OLLAMA_MODELS"];
    process.env["OLLAMA_ORIGINS"] = "*";
    process.env["OLLAMA_MODELS"] = "/tmp/insecure-model-root";

    try {
      const { spawn, recorded } = fakeServeSpawn();
      const fetch = spawnedOllamaFetch(recorded);
      const adapter = new OllamaAdapter({
        fetch,
        spawn,
        sleep: immediateSleep,
        listenerProbe: spawnedOllamaListener(recorded),
      });

      await adapter.serve({ host: "127.0.0.1", port: 12003 });

      expect(recorded[0]?.env?.["OLLAMA_HOST"]).toBe("127.0.0.1:12003");
      expect(recorded[0]?.env?.["OLLAMA_ORIGINS"]).toBeUndefined();
      expect(recorded[0]?.env?.["OLLAMA_MODELS"]).toBeUndefined();
    } finally {
      if (previousOrigins === undefined) delete process.env["OLLAMA_ORIGINS"];
      else process.env["OLLAMA_ORIGINS"] = previousOrigins;

      if (previousModels === undefined) delete process.env["OLLAMA_MODELS"];
      else process.env["OLLAMA_MODELS"] = previousModels;
    }
  });

  it("kills the spawned daemon when it never becomes ready (no orphan)", async () => {
    const { spawn, recorded, state } = fakeServeSpawn();
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    await expect(adapter.serve({ port: 12001 })).rejects.toBeInstanceOf(BackendError);
    expect(recorded).toHaveLength(1);
    expect(state.kills).toBe(1);
    expect(state.killSignals).toEqual(["SIGTERM"]);
  });

  it("escalates cleanup to SIGKILL when SIGTERM does not stop the spawned daemon", async () => {
    const { spawn, state } = fakeServeSpawn({ exitOnSignal: "SIGKILL" });
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: async () => null,
    });

    await expect(adapter.serve({ port: 12011 })).rejects.toBeInstanceOf(BackendError);
    expect(state.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("kills and fails when the spawned daemon reports no pid", async () => {
    const { spawn, state } = fakeServeSpawn({ noPid: true });
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: async () => null,
    });

    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    expect(state.kills).toBe(1);
  });

  it("aborts before spawning when the signal is already aborted", async () => {
    const { spawn, recorded } = fakeServeSpawn();
    const fetch = trustedOllamaFetch();
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.serve({ signal: controller.signal })).rejects.toBeInstanceOf(BackendError);
    expect(recorded).toHaveLength(0);
  });

  it("refuses to bind a non-loopback host without an explicit opt-in", async () => {
    const { spawn, recorded } = fakeServeSpawn();
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    await expect(adapter.serve({ host: "0.0.0.0" })).rejects.toBeInstanceOf(ValidationError);
    expect(recorded).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds a non-loopback host only when explicitly opted in", async () => {
    const { spawn, recorded } = fakeServeSpawn();
    const fetch = spawnedOllamaFetch(recorded);
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: spawnedOllamaListener(recorded),
    });

    const handle = await adapter.serve({ host: "0.0.0.0", port: 12002, allowNonLoopback: true });

    expect(handle.endpoint).toBe("http://0.0.0.0:12002");
    expect(recorded[0]?.env?.["OLLAMA_HOST"]).toBe("0.0.0.0:12002");
  });

  it("kills and fails when the spawned daemon reports a non-positive pid", async () => {
    const { spawn, state } = fakeServeSpawn({ pid: 0 });
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({
      fetch,
      spawn,
      sleep: immediateSleep,
      listenerProbe: async () => null,
    });

    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    expect(state.kills).toBe(1);
  });

  it("fails fast and cleans up when the daemon errors asynchronously (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn ollama ENOENT"), { code: "ENOENT" });
    const { spawn, recorded, state } = fakeServeSpawn({ error: enoent });
    const adapter = new OllamaAdapter({
      fetch: notReachableThenHanging(recorded),
      spawn,
      sleep: immediateSleep,
      listenerProbe: async () => null,
    });

    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    expect(state.kills).toBe(1);
  });

  it("fails fast and cleans up when the daemon exits before becoming ready", async () => {
    const { spawn, recorded, state } = fakeServeSpawn({ exitCode: 1 });
    const adapter = new OllamaAdapter({
      fetch: notReachableThenHanging(recorded),
      spawn,
      sleep: immediateSleep,
    });

    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    // Child already exited; no additional signal is needed.
    expect(state.kills).toBe(0);
  });
});

describe("OllamaAdapter.stop", () => {
  it("never kills an attached (foreign) daemon", async () => {
    const killed: number[] = [];
    const kill: KillFn = (pid) => killed.push(pid);
    const fetch = trustedOllamaFetch();
    const adapter = ownedOllamaAdapter(fetch, kill);

    await adapter.stop({ endpoint: ENDPOINT, pid: 0, port: 11434, ownedByUs: false });

    expect(killed).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops an attached (foreign) daemon when allowForeign is set", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const kill: KillFn = (pid, signal) => {
      killed.push({ pid, signal });
      if (signal === 0) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
    };
    const fetch = trustedOllamaFetch();
    const adapter = ownedOllamaAdapter(fetch, kill);

    await adapter.stop(
      { endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: false },
      { allowForeign: true },
    );

    expect(killed).toEqual([
      { pid: 9001, signal: "SIGTERM" },
      { pid: 9001, signal: 0 },
    ]);
  });

  it("signals SIGTERM and waits for process exit for a daemon we own", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const kill: KillFn = (pid, signal) => {
      killed.push({ pid, signal });
      if (signal === 0) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
    };
    const fetch = trustedOllamaFetch();
    const adapter = ownedOllamaAdapter(fetch, kill);

    await adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true });

    expect(killed).toEqual([
      { pid: 9001, signal: "SIGTERM" },
      { pid: 9001, signal: 0 },
    ]);
  });

  it("escalates to SIGKILL when SIGTERM does not stop an owned daemon", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    let probesAfterSigkill = 0;
    const kill: KillFn = (pid, signal) => {
      killed.push({ pid, signal });
      if (signal === 0 && killed.some((call) => call.signal === "SIGKILL")) {
        probesAfterSigkill += 1;
        if (probesAfterSigkill >= 1) {
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        }
      }
    };
    const fetch = trustedOllamaFetch();
    const adapter = ownedOllamaAdapter(fetch, kill);

    await adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true });

    expect(killed[0]).toEqual({ pid: 9001, signal: "SIGTERM" });
    expect(killed).toContainEqual({ pid: 9001, signal: "SIGKILL" });
  });

  it("refuses SIGKILL when process identity changes during shutdown polling", async () => {
    const killed: Array<NodeJS.Signals | 0 | undefined> = [];
    const adapter = new OllamaAdapter({
      fetch: trustedOllamaFetch(),
      kill: (_pid, signal) => killed.push(signal),
      sleep: immediateSleep,
      listenerProbe: ollamaListener(),
      processProbe: async (pid) => ({
        pid,
        process: "replacement",
        executable: "/replacement/process",
        started: "later",
      }),
    });

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).rejects.toThrow("process identity changed");
    expect(killed).toContain("SIGTERM");
    expect(killed).not.toContain("SIGKILL");
  });

  it("treats an already-dead process (ESRCH) as a successful stop", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const kill: KillFn = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    const adapter = ownedOllamaAdapter(fetch, kill);

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).resolves.toBeUndefined();
  });

  it("wraps an unexpected kill failure in a BackendError", async () => {
    const fetch = trustedOllamaFetch();
    const kill: KillFn = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    const adapter = ownedOllamaAdapter(fetch, kill);

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("refuses to signal a non-positive pid on an owned handle", async () => {
    const killed: number[] = [];
    const kill: KillFn = (pid) => killed.push(pid);
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(ok));
    const adapter = ownedOllamaAdapter(fetch, kill);

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 0, port: 11434, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(killed).toHaveLength(0);
  });

  it("refuses to signal a live pid when the recorded endpoint is unreachable", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const kill: KillFn = (pid, signal) => killed.push({ pid, signal });
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = ownedOllamaAdapter(fetch, kill);

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);

    // A liveness probe (`signal: 0`) is allowed; termination is refused.
    expect(killed).toEqual([{ pid: 9001, signal: 0 }]);
  });

  it("refuses to signal an owned pid when the endpoint fails Ollama identity", async () => {
    const killed = vi.fn<KillFn>();
    const fetch = vi.fn<FetchFn>((url) =>
      Promise.resolve(
        url.endsWith("/api/version")
          ? { ok: true, status: 200, json: () => Promise.resolve({}) }
          : ok,
      ),
    );
    const adapter = ownedOllamaAdapter(fetch, killed);

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(killed).not.toHaveBeenCalledWith(9001, "SIGTERM");
  });
});
