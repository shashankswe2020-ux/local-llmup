import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import { assertSafeMlxModelDirectory, MlxAdapter } from "../../src/backend/mlx.js";
import type {
  AcquireRepositoryRequest,
  AcquireRepositoryResult,
} from "../../src/backend/acquire.js";
import type { SpawnFn, SpawnedProcess } from "../../src/backend/ollama.js";
import type { FetchFn, FetchResponseLike, KillFn, SleepFn } from "../../src/backend/ollama.js";
import type { ListenerIdentity, ProcessIdentity } from "../../src/backend/listener.js";

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

function successfulSpawn(output = "0.31.3\n"): {
  readonly spawn: SpawnFn;
  readonly records: SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    records.push({ command, args: [...args], shell: options.shell, env: options.env });
    const closeListeners: Array<(code: number | null) => void> = [];
    const child: SpawnedProcess = {
      pid: 1234,
      stdout: { onData: (listener) => listener(output) },
      stderr: { onData: () => {} },
      onClose: (listener) => closeListeners.push(listener),
      onError: () => {},
      kill: () => {},
    };
    queueMicrotask(() => {
      for (const listener of closeListeners) listener(0);
    });
    return child;
  };
  return { spawn, records };
}

describe("MlxAdapter — descriptor and installation", () => {
  it("advertises the MLX server descriptor", () => {
    const adapter = new MlxAdapter({ platform: "darwin", arch: "arm64" });
    expect(adapter.name).toBe("mlx");
    expect(adapter.capabilities).toEqual({
      canPull: true,
      canEmbed: false,
      embeddingOffload: "unknown",
      openAiCompatible: true,
      formats: ["mlx"],
      defaultPort: 8080,
    });
  });

  it("probes mlx_lm.server only on Apple Silicon", async () => {
    const { spawn, records } = successfulSpawn();
    const adapter = new MlxAdapter({ spawn, platform: "darwin", arch: "arm64" });
    await expect(adapter.isInstalled()).resolves.toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.command).toBe("python3");
    expect(records[0]?.args.slice(0, 2)).toEqual(["-I", "-c"]);
    expect(records[0]?.args[2]).toContain("importlib.metadata");
    expect(records[0]?.args[2]).toContain("_run_http_server");
    expect(records[0]?.shell).toBe(false);
    expect(records[0]?.env).toBeUndefined();
  });

  it("is unavailable without spawning off Apple Silicon", async () => {
    for (const target of [
      { platform: "linux", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "win32", arch: "x64" },
    ] as const) {
      const { spawn, records } = successfulSpawn();
      const adapter = new MlxAdapter({ spawn, ...target });
      await expect(adapter.isInstalled()).resolves.toBe(false);
      expect(records).toEqual([]);
    }
  });

  it("returns false when the server probe exits non-zero", async () => {
    const spawn: SpawnFn = () => {
      const child: SpawnedProcess = {
        pid: 1234,
        stdout: { onData: () => {} },
        stderr: { onData: () => {} },
        onClose: (listener) => queueMicrotask(() => listener(1)),
        onError: () => {},
        kill: () => {},
      };
      return child;
    };
    const adapter = new MlxAdapter({ spawn, platform: "darwin", arch: "arm64" });
    await expect(adapter.isInstalled()).resolves.toBe(false);
  });

  it("allows a two-second cold import for the audited runtime probe", async () => {
    vi.useFakeTimers();
    try {
      const spawn: SpawnFn = (_command, _args, options) => {
        let output: ((chunk: string) => void) | undefined;
        let close: ((code: number | null) => void) | undefined;
        const child: SpawnedProcess = {
          pid: 1234,
          stdout: {
            onData: (listener) => {
              output = listener;
            },
          },
          stderr: { onData: () => {} },
          onClose: (listener) => {
            close = listener;
          },
          onError: () => {},
          kill: () => {},
        };
        options.signal?.addEventListener("abort", () => close?.(null), { once: true });
        setTimeout(() => {
          output?.("0.31.3\n");
          close?.(0);
        }, 2_000);
        return child;
      };
      const adapter = new MlxAdapter({ spawn, platform: "darwin", arch: "arm64" });
      const installed = adapter.isInstalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(installed).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["0.31.2\n", "0.31.4\n", "not-a-version\n", ""])(
    "rejects an unaudited or malformed mlx-lm version %j",
    async (output) => {
      const { spawn } = successfulSpawn(output);
      const adapter = new MlxAdapter({ spawn, platform: "darwin", arch: "arm64" });
      await expect(adapter.isInstalled()).resolves.toBe(false);
    },
  );

  it("documents the supported mlx-lm version in the install hint", () => {
    const hint = new MlxAdapter({ platform: "darwin", arch: "arm64" }).installHint();
    expect(hint).toContain("mlx-lm==0.31.3");
  });
});

describe("MlxAdapter — pull", () => {
  const repository = {
    repo: "mlx-community/Qwen3-0.6B-4bit",
    revision: "a".repeat(40),
    files: [
      { file: "config.json", sha256: "b".repeat(64), bytes: 100 },
      { file: "tokenizer_config.json", sha256: "c".repeat(64), bytes: 200 },
      { file: "model.safetensors", sha256: "d".repeat(64), bytes: 1_000 },
    ],
  };

  it("acquires a complete pinned repository and returns its local directory", async () => {
    const requests: AcquireRepositoryRequest[] = [];
    const acquireRepository = (
      request: AcquireRepositoryRequest,
    ): Promise<AcquireRepositoryResult> => {
      requests.push(request);
      return Promise.resolve({
        path: "/cache/mlx/qwen",
        bytes: 1_300,
        digestVerified: true,
        cached: false,
      });
    };
    const progress: string[] = [];
    const adapter = new MlxAdapter({
      acquireRepository,
      modelDirectoryVerifier: () => {},
    });
    const result = await adapter.pull({
      modelId: "qwen3:0.6b",
      repository,
      onProgress: (event) => progress.push(event.status),
    });
    expect(result).toEqual({
      modelId: "qwen3:0.6b",
      digestVerified: true,
      modelPath: "/cache/mlx/qwen",
    });
    expect(requests).toEqual([{ backend: "mlx", ...repository }]);
    expect(progress).toContain("downloaded MLX repository");
  });

  it("refuses pull without a pinned repository manifest", async () => {
    const acquireRepository = vi.fn(() => Promise.reject(new Error("must not run")));
    const adapter = new MlxAdapter({ acquireRepository });
    await expect(adapter.pull({ modelId: "qwen3:0.6b" })).rejects.toBeInstanceOf(BackendError);
    expect(acquireRepository).not.toHaveBeenCalled();
  });

  it("fails closed when repository acquisition is not digest verified", async () => {
    const adapter = new MlxAdapter({
      acquireRepository: () =>
        Promise.resolve({
          path: "/cache/mlx/qwen",
          bytes: 1_300,
          digestVerified: false,
          cached: false,
        }),
    });
    await expect(adapter.pull({ modelId: "qwen3:0.6b", repository })).rejects.toBeInstanceOf(
      BackendError,
    );
  });
});

describe("assertSafeMlxModelDirectory", () => {
  function modelDirectory(config: unknown = { model_type: "llama" }): string {
    const root = mkdtempSync(join(tmpdir(), "llmup-mlx-model-"));
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    writeFileSync(join(root, "tokenizer_config.json"), "{}");
    writeFileSync(join(root, "model.safetensors"), "weights");
    return root;
  }

  it("accepts a data-only verified MLX model directory", () => {
    const root = modelDirectory();
    try {
      expect(() => assertSafeMlxModelDirectory(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([{ model_file: "model.py" }, { auto_map: { AutoModel: "model.CustomModel" } }])(
    "rejects custom-code loader configuration",
    (config) => {
      const root = modelDirectory(config);
      try {
        expect(() => assertSafeMlxModelDirectory(root)).toThrow(BackendError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects executable files even if the caller bypassed catalog validation", () => {
    const root = modelDirectory();
    writeFileSync(join(root, "model.py"), "raise RuntimeError('must not execute')");
    try {
      expect(() => assertSafeMlxModelDirectory(root)).toThrow(BackendError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface FakeServer {
  listening: boolean;
  ready: boolean;
  modelPath: string;
}

function jsonResponse(ok: boolean, status: number, value: unknown): FetchResponseLike {
  return { ok, status, json: () => Promise.resolve(value) };
}

function mlxFetch(server: FakeServer, expectedToken?: string): FetchFn {
  return vi.fn((url, init) => {
    if (!server.listening) return Promise.reject(new Error("ECONNREFUSED"));
    if (
      expectedToken !== undefined &&
      init?.headers?.["authorization"] !== `Bearer ${expectedToken}`
    ) {
      return Promise.resolve(jsonResponse(false, 401, { error: "unauthorized" }));
    }
    const path = new URL(url).pathname;
    if (path === "/health") return Promise.resolve(jsonResponse(true, 200, { status: "ok" }));
    if (path === "/v1/models") {
      return Promise.resolve(
        jsonResponse(true, 200, { object: "list", data: [{ id: server.modelPath }] }),
      );
    }
    if (path === "/v1/chat/completions") {
      const body = JSON.parse(init?.body ?? "{}") as { max_tokens?: number };
      if (body.max_tokens === 1) {
        return Promise.resolve(
          server.ready
            ? jsonResponse(true, 200, {
                choices: [{ message: { role: "assistant", content: "ready" } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              })
            : jsonResponse(false, 503, { error: "loading" }),
        );
      }
      return Promise.resolve(
        jsonResponse(true, 200, { choices: [{ message: { content: "hello from mlx" } }] }),
      );
    }
    return Promise.resolve(jsonResponse(false, 404, {}));
  });
}

const noSleep: SleepFn = () => Promise.resolve();

function listener(server: FakeServer): ListenerIdentity | null {
  return server.listening
    ? {
        pid: 4321,
        process: "Python",
        executable: "/usr/bin/python3",
        started: "2026-08-08T00:00:00.000Z",
        localAddress: "127.0.0.1",
      }
    : null;
}

const stableProcessIdentity = () =>
  Promise.resolve({
    pid: 4321,
    process: "Python",
    executable: "/usr/bin/python3",
    started: "2026-08-08T00:00:00.000Z",
  });

function longRunningSpawn(server: FakeServer): {
  readonly spawn: SpawnFn;
  readonly records: SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    records.push({ command, args: [...args], shell: options.shell, env: options.env });
    server.listening = true;
    const closeListeners: Array<(code: number | null) => void> = [];
    return {
      pid: 4321,
      stdout: null,
      stderr: null,
      onClose: (callback) => closeListeners.push(callback),
      onError: () => {},
      kill: () => {
        server.listening = false;
        queueMicrotask(() => {
          for (const callback of closeListeners) callback(null);
        });
      },
    };
  };
  return { spawn, records };
}

describe("MlxAdapter — lifecycle", () => {
  it("spawns mlx_lm.server with an explicit local model, loopback host, and port", async () => {
    const server: FakeServer = { listening: false, ready: true, modelPath: "/cache/mlx/model" };
    const authToken = "a".repeat(64);
    const { spawn, records } = longRunningSpawn(server);
    const adapter = new MlxAdapter({
      spawn,
      fetch: mlxFetch(server, authToken),
      sleep: noSleep,
      listenerProbe: () => Promise.resolve(listener(server)),
      processProbe: stableProcessIdentity,
      modelDirectoryVerifier: () => {},
      env: {
        PATH: "/runtime/bin",
        HOME: "/Users/tester",
        TMPDIR: "/private/tmp",
        HF_TOKEN: "must-not-leak",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
      },
      authTokenFactory: () => authToken,
      platform: "darwin",
      arch: "arm64",
    });
    const handle = await adapter.serve({
      host: "127.0.0.1",
      port: 18081,
      modelPath: "/cache/mlx/model",
      modelId: "qwen3:0.6b",
    });
    expect(records[0]?.command).toBe("python3");
    expect(records[0]?.shell).toBe(false);
    expect(records[0]?.args.slice(0, 2)).toEqual(["-I", "-c"]);
    expect(records[0]?.args[2]).toContain("GuardedHandler");
    expect(records[0]?.args.slice(3)).toEqual([
      "mlx_lm.server",
      "--model",
      "/cache/mlx/model",
      "--host",
      "127.0.0.1",
      "--port",
      "18081",
      "--allowed-origins",
      "",
      "--log-level",
      "ERROR",
    ]);
    expect(records[0]?.env).toEqual({
      PATH: "/runtime/bin",
      HOME: "/Users/tester",
      TMPDIR: "/private/tmp",
      LLMUP_MLX_AUTH_TOKEN: authToken,
    });
    expect(handle).toMatchObject({
      endpoint: "http://127.0.0.1:18081",
      pid: 4321,
      port: 18081,
      ownedByUs: true,
      processExecutable: "/usr/bin/python3",
    });
    expect(handle.authToken).toBe(authToken);
  });

  it("preserves the startup error when the child already exited before cleanup", async () => {
    const spawn: SpawnFn = () => {
      const closeListeners: Array<(code: number | null) => void> = [];
      queueMicrotask(() => {
        for (const listener of closeListeners.splice(0)) listener(1);
      });
      return {
        pid: 1234,
        stdout: null,
        stderr: null,
        onClose: (listener) => closeListeners.push(listener),
        onError: () => {},
        kill: () => {},
      };
    };
    const adapter = new MlxAdapter({
      spawn,
      fetch: () => Promise.reject(new Error("not listening")),
      sleep: () => new Promise<void>(() => {}),
      listenerProbe: () => Promise.resolve(null),
      modelDirectoryVerifier: () => {},
      platform: "darwin",
      arch: "arm64",
      authTokenFactory: () => "a".repeat(64),
    });

    await expect(adapter.serve({ modelPath: "/cache/mlx/model", port: 18081 })).rejects.toThrow(
      /exited before readiness/,
    );
  });

  it("refuses non-loopback bind before spawning", async () => {
    const { spawn, records } = successfulSpawn();
    const adapter = new MlxAdapter({ spawn, platform: "darwin", arch: "arm64" });
    await expect(adapter.serve({ host: "0.0.0.0", modelPath: "/cache/m" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(records).toEqual([]);
  });

  it("refuses every pre-existing listener instead of attaching without authoritative identity", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const { spawn, records } = successfulSpawn();
    const adapter = new MlxAdapter({
      spawn,
      fetch: mlxFetch(server),
      listenerProbe: () => Promise.resolve(listener(server)),
      modelDirectoryVerifier: () => {},
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.serve({ port: 18081, modelPath: "/cache/mlx/model" }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(records).toEqual([]);
  });

  it("actively aborts a hung readiness request at the command deadline", async () => {
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    const adapter = new MlxAdapter({
      fetch,
      sleep: noSleep,
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.waitUntilReady({
        endpoint: "http://127.0.0.1:18081",
        timeoutMs: 10,
        retries: 1,
      }),
    ).rejects.toBeInstanceOf(BackendError);
  }, 500);

  it("keeps the readiness deadline active while the response body is streaming", async () => {
    const fetch: FetchFn = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        },
      });
      return Promise.resolve({ ok: true, status: 200, body });
    };
    const adapter = new MlxAdapter({
      fetch,
      sleep: noSleep,
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.waitUntilReady({
        endpoint: "http://127.0.0.1:18081",
        timeoutMs: 10,
        retries: 1,
      }),
    ).rejects.toBeInstanceOf(BackendError);
  }, 500);

  it("stops an owned MLX process only after listener identity revalidation", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const signals: Array<NodeJS.Signals | 0 | undefined> = [];
    const kill: KillFn = (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") server.listening = false;
      if (signal === 0 && !server.listening)
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    const adapter = new MlxAdapter({
      fetch: mlxFetch(server),
      kill,
      sleep: noSleep,
      listenerProbe: () => Promise.resolve(listener(server)),
      processProbe: stableProcessIdentity,
      platform: "darwin",
      arch: "arm64",
    });
    await adapter.stop({
      endpoint: "http://127.0.0.1:18081",
      pid: 4321,
      port: 18081,
      ownedByUs: true,
      processExecutable: "/usr/bin/python3",
      processStartedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(signals).toContain("SIGTERM");
  });

  it("does not stop an attached process", async () => {
    const kill = vi.fn<KillFn>();
    const adapter = new MlxAdapter({ kill, platform: "darwin", arch: "arm64" });
    await adapter.stop({
      endpoint: "http://127.0.0.1:18081",
      pid: 4321,
      port: 18081,
      ownedByUs: false,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails when the owned process remains alive after SIGTERM and SIGKILL", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const kill = vi.fn<KillFn>();
    const adapter = new MlxAdapter({
      kill,
      sleep: noSleep,
      listenerProbe: () => Promise.resolve(listener(server)),
      processProbe: stableProcessIdentity,
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.stop({
        endpoint: "http://127.0.0.1:18081",
        pid: 4321,
        port: 18081,
        ownedByUs: true,
        processExecutable: "/usr/bin/python3",
        processStartedAt: "2026-08-08T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(kill).toHaveBeenCalledWith(4321, "SIGKILL");
  });

  it("does not send SIGKILL when the PID is reused after SIGTERM", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    let processExecutable = "/usr/bin/python3";
    let processStartedAt = "2026-08-08T00:00:00.000Z";
    const signals: Array<NodeJS.Signals | 0 | undefined> = [];
    const kill: KillFn = (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        processExecutable = "/usr/bin/unrelated";
        processStartedAt = "2026-08-08T00:01:00.000Z";
      }
    };
    const adapter = new MlxAdapter({
      kill,
      sleep: noSleep,
      listenerProbe: () => Promise.resolve(listener(server)),
      processProbe: () =>
        Promise.resolve({
          pid: 4321,
          process: "replacement",
          executable: processExecutable,
          started: processStartedAt,
        }),
      platform: "darwin",
      arch: "arm64",
    });
    await adapter.stop({
      endpoint: "http://127.0.0.1:18081",
      pid: 4321,
      port: 18081,
      ownedByUs: true,
      processExecutable: "/usr/bin/python3",
      processStartedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(signals).not.toContain("SIGKILL");
  });

  it("fails closed without SIGKILL when process identity becomes unobservable", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const kill = vi.fn<KillFn>();
    const processProbe = vi
      .fn<() => Promise<ProcessIdentity | null>>()
      .mockResolvedValueOnce(await stableProcessIdentity())
      .mockResolvedValue(null);
    const adapter = new MlxAdapter({
      kill,
      sleep: noSleep,
      listenerProbe: () => Promise.resolve(listener(server)),
      processProbe,
      platform: "darwin",
      arch: "arm64",
    });

    await expect(
      adapter.stop({
        endpoint: "http://127.0.0.1:18081",
        pid: 4321,
        port: 18081,
        ownedByUs: true,
        processExecutable: "/usr/bin/python3",
        processStartedAt: "2026-08-08T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(4321, "SIGKILL");
  });
});

describe("MlxAdapter — chat and embeddings", () => {
  const expectedProcess = {
    pid: 4321,
    executable: "/usr/bin/python3",
    started: "2026-08-08T00:00:00.000Z",
  };
  const authToken = "a".repeat(64);

  it("routes chat through the active custom endpoint", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const fetch = mlxFetch(server, authToken);
    const adapter = new MlxAdapter({
      fetch,
      listenerProbe: () => Promise.resolve(listener(server)),
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18081",
        model: "qwen3:0.6b",
        messages: [{ role: "user", content: "hello" }],
        expectedProcess,
        authToken,
      }),
    ).resolves.toEqual({ content: "hello from mlx" });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18081/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("tolerates a transient listener-probe miss while preserving exact process identity", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const fetch = mlxFetch(server, authToken);
    const listenerProbe = vi
      .fn<() => Promise<ListenerIdentity | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(listener(server));
    const adapter = new MlxAdapter({
      fetch,
      listenerProbe,
      sleep: () => Promise.resolve(),
      platform: "darwin",
      arch: "arm64",
    });

    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18081",
        model: "m",
        messages: [],
        expectedProcess,
        authToken,
      }),
    ).resolves.toEqual({ content: "hello from mlx" });
    expect(listenerProbe).toHaveBeenCalledTimes(3);
  });

  it("refuses non-loopback chat endpoints", async () => {
    const fetch = vi.fn<FetchFn>();
    const adapter = new MlxAdapter({ fetch, platform: "darwin", arch: "arm64" });
    await expect(
      adapter.chat({ endpoint: "http://example.com", model: "m", messages: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to transmit chat without the expected active process identity", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const fetch = mlxFetch(server);
    const adapter = new MlxAdapter({
      fetch,
      listenerProbe: () => Promise.resolve(listener(server)),
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18081",
        model: "m",
        messages: [],
        authToken,
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to transmit chat without the active session token", async () => {
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/mlx/model" };
    const fetch = mlxFetch(server, authToken);
    const adapter = new MlxAdapter({
      fetch,
      listenerProbe: () => Promise.resolve(listener(server)),
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18081",
        model: "m",
        messages: [],
        expectedProcess,
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized chat request before fetch", async () => {
    const fetch = vi.fn<FetchFn>();
    const adapter = new MlxAdapter({
      fetch,
      listenerProbe: () =>
        Promise.resolve(listener({ listening: true, ready: true, modelPath: "/cache/m" })),
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18081",
        model: "m",
        messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }],
        expectedProcess,
        authToken,
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized generated content", async () => {
    const fetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse(true, 200, {
          choices: [{ message: { content: "x".repeat(1024 * 1024 + 1) } }],
        }),
      );
    const server: FakeServer = { listening: true, ready: true, modelPath: "/cache/m" };
    const adapter = new MlxAdapter({
      fetch,
      listenerProbe: () => Promise.resolve(listener(server)),
      platform: "darwin",
      arch: "arm64",
    });
    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:18081",
        model: "m",
        messages: [],
        expectedProcess,
        authToken,
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("fails closed for embeddings", async () => {
    const adapter = new MlxAdapter({ platform: "darwin", arch: "arm64" });
    await expect(adapter.embed({ model: "m", input: ["x"] })).rejects.toBeInstanceOf(BackendError);
  });
});

describe("MlxAdapter — serve/stop error-path branch coverage", () => {
  const ownedHandle = {
    endpoint: "http://127.0.0.1:18081",
    pid: 4321,
    port: 18081,
    ownedByUs: true as const,
    processExecutable: "/usr/bin/python3",
    processStartedAt: "2026-08-08T00:00:00.000Z",
  };

  it("refuses to serve off Apple Silicon", async () => {
    const adapter = new MlxAdapter({
      platform: "linux",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
    });
    await expect(adapter.serve({ port: 18081, modelPath: "/cache/m" })).rejects.toThrow(
      /Apple Silicon/i,
    );
  });

  it("refuses to serve once the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new MlxAdapter({
      platform: "darwin",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
    });
    await expect(
      adapter.serve({ port: 18081, modelPath: "/cache/m", signal: controller.signal }),
    ).rejects.toThrow(/serve aborted/i);
  });

  it("requires an absolute verified model path", async () => {
    const adapter = new MlxAdapter({
      platform: "darwin",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
    });
    await expect(adapter.serve({ port: 18081 })).rejects.toThrow(/absolute model path/i);
    await expect(adapter.serve({ port: 18081, modelPath: "relative/m" })).rejects.toThrow(
      /absolute model path/i,
    );
  });

  it("refuses a health-reachable endpoint that has no authoritative listener", async () => {
    const adapter = new MlxAdapter({
      platform: "darwin",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
      listenerProbe: () => Promise.resolve(null),
      fetch: () => Promise.resolve(jsonResponse(true, 200, { status: "ok" })),
    });
    await expect(adapter.serve({ port: 18081, modelPath: "/cache/m" })).rejects.toThrow(
      /occupied MLX endpoint/i,
    );
  });

  it("rejects an invalid generated session token before spawning", async () => {
    const spawn = vi.fn<SpawnFn>();
    const adapter = new MlxAdapter({
      platform: "darwin",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
      listenerProbe: () => Promise.resolve(null),
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      authTokenFactory: () => "not-a-valid-token",
      spawn,
    });
    await expect(adapter.serve({ port: 18081, modelPath: "/cache/m" })).rejects.toThrow(
      /invalid token/i,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("wraps a spawn failure as a run error", async () => {
    const adapter = new MlxAdapter({
      platform: "darwin",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
      listenerProbe: () => Promise.resolve(null),
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      authTokenFactory: () => "a".repeat(64),
      spawn: () => {
        throw new Error("boom");
      },
    });
    await expect(adapter.serve({ port: 18081, modelPath: "/cache/m" })).rejects.toThrow(
      /failed to run/i,
    );
  });

  it("fails when the spawned MLX process reports no usable pid", async () => {
    const spawn: SpawnFn = () => {
      const closeListeners: Array<(code: number | null) => void> = [];
      return {
        pid: undefined,
        stdout: null,
        stderr: null,
        onClose: (l) => closeListeners.push(l),
        onError: () => {},
        kill: () => {
          queueMicrotask(() => {
            for (const l of closeListeners) l(null);
          });
        },
      };
    };
    const adapter = new MlxAdapter({
      platform: "darwin",
      arch: "arm64",
      modelDirectoryVerifier: () => {},
      listenerProbe: () => Promise.resolve(null),
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      authTokenFactory: () => "a".repeat(64),
      sleep: noSleep,
      spawn,
    });
    await expect(adapter.serve({ port: 18081, modelPath: "/cache/m" })).rejects.toThrow(
      /usable pid/i,
    );
  });

  it("refuses to stop an owned process without complete identity", async () => {
    const kill = vi.fn<KillFn>();
    const adapter = new MlxAdapter({ kill, platform: "darwin", arch: "arm64" });
    await expect(
      adapter.stop({ endpoint: "http://127.0.0.1:18081", pid: 4321, port: 18081, ownedByUs: true }),
    ).rejects.toThrow(/complete identity/i);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses to stop when the listener identity is gone", async () => {
    const kill = vi.fn<KillFn>();
    const adapter = new MlxAdapter({
      kill,
      platform: "darwin",
      arch: "arm64",
      listenerProbe: () => Promise.resolve(null),
    });
    await expect(adapter.stop(ownedHandle)).rejects.toThrow(/listener identity changed/i);
    expect(kill).not.toHaveBeenCalled();
  });
});
