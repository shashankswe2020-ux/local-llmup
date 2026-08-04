import { describe, expect, it, vi } from "vitest";
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
function fakeServeSpawn(config: {
  pid?: number;
  noPid?: boolean;
  error?: Error;
  exitCode?: number;
} = {}): {
  spawn: SpawnFn;
  recorded: RecordedSpawn[];
  state: { kills: number };
} {
  const recorded: RecordedSpawn[] = [];
  const state = { kills: 0 };
  const spawn: SpawnFn = (command, args, options) => {
    recorded.push({ command, args, env: options.env, signal: options.signal });
    const errorListeners: ((error: Error) => void)[] = [];
    const closeListeners: ((code: number | null) => void)[] = [];
    if (config.error !== undefined || config.exitCode !== undefined) {
      setTimeout(() => {
        if (config.error !== undefined) {
          for (const listener of errorListeners) listener(config.error);
        } else {
          for (const listener of closeListeners) listener(config.exitCode ?? 0);
        }
      }, 0);
    }
    const child: SpawnedProcess = {
      pid: config.noPid ? undefined : (config.pid ?? 4242),
      stdout: { onData: () => {} },
      stderr: { onData: () => {} },
      onClose: (listener) => closeListeners.push(listener),
      onError: (listener) => errorListeners.push(listener),
      kill: () => {
        state.kills += 1;
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

describe("OllamaAdapter.serve", () => {
  it("attaches to an already-running daemon without spawning", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(ok));
    const { spawn, recorded } = fakeServeSpawn();
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    const handle = await adapter.serve();

    expect(handle.ownedByUs).toBe(false);
    expect(handle.endpoint).toBe(ENDPOINT);
    expect(handle.port).toBe(11434);
    expect(recorded).toHaveLength(0);
  });

  it("spawns a loopback-bound daemon when none is running", async () => {
    const { spawn, recorded } = fakeServeSpawn({ pid: 9001 });
    // Only reachable once we have started our own daemon.
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(recorded.length > 0 ? ok : notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

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
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(recorded.length > 0 ? ok : notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    const handle = await adapter.serve({ host: "127.0.0.1", port: 12000 });

    expect(handle.endpoint).toBe("http://127.0.0.1:12000");
    expect(recorded[0]?.env?.["OLLAMA_HOST"]).toBe("127.0.0.1:12000");
  });

  it("kills the spawned daemon when it never becomes ready (no orphan)", async () => {
    const { spawn, recorded, state } = fakeServeSpawn();
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    await expect(adapter.serve({ port: 12001 })).rejects.toBeInstanceOf(BackendError);
    expect(recorded).toHaveLength(1);
    expect(state.kills).toBe(1);
  });

  it("kills and fails when the spawned daemon reports no pid", async () => {
    const { spawn, state } = fakeServeSpawn({ noPid: true });
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    expect(state.kills).toBe(1);
  });

  it("aborts before spawning when the signal is already aborted", async () => {
    const { spawn, recorded } = fakeServeSpawn();
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(ok));
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
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(recorded.length > 0 ? ok : notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

    const handle = await adapter.serve({ host: "0.0.0.0", port: 12002, allowNonLoopback: true });

    expect(handle.endpoint).toBe("http://0.0.0.0:12002");
    expect(recorded[0]?.env?.["OLLAMA_HOST"]).toBe("0.0.0.0:12002");
  });

  it("kills and fails when the spawned daemon reports a non-positive pid", async () => {
    const { spawn, state } = fakeServeSpawn({ pid: 0 });
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const adapter = new OllamaAdapter({ fetch, spawn, sleep: immediateSleep });

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
    expect(state.kills).toBe(1);
  });
});

describe("OllamaAdapter.stop", () => {
  it("never kills an attached (foreign) daemon", async () => {
    const killed: number[] = [];
    const kill: KillFn = (pid) => killed.push(pid);
    const adapter = new OllamaAdapter({ kill });

    await adapter.stop({ endpoint: ENDPOINT, pid: 0, port: 11434, ownedByUs: false });

    expect(killed).toHaveLength(0);
  });

  it("signals the pid of a daemon we own", async () => {
    const killed: number[] = [];
    const kill: KillFn = (pid) => killed.push(pid);
    const adapter = new OllamaAdapter({ kill });

    await adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true });

    expect(killed).toEqual([9001]);
  });

  it("treats an already-dead process (ESRCH) as a successful stop", async () => {
    const kill: KillFn = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    const adapter = new OllamaAdapter({ kill });

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).resolves.toBeUndefined();
  });

  it("wraps an unexpected kill failure in a BackendError", async () => {
    const kill: KillFn = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    const adapter = new OllamaAdapter({ kill });

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 9001, port: 11434, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("refuses to signal a non-positive pid on an owned handle", async () => {
    const killed: number[] = [];
    const kill: KillFn = (pid) => killed.push(pid);
    const adapter = new OllamaAdapter({ kill });

    await expect(
      adapter.stop({ endpoint: ENDPOINT, pid: 0, port: 11434, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(killed).toHaveLength(0);
  });
});
