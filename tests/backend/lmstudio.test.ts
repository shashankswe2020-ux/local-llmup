import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import {
  isDefaultTrustedLmStudioExecutable,
  LmStudioAdapter,
  type LmsCommandFn,
  type LmsCommandResult,
} from "../../src/backend/lmstudio.js";
import type { ListenerIdentity } from "../../src/backend/listener.js";
import type {
  FetchFn,
  FetchResponseLike,
  SpawnFn,
  SpawnedProcess,
} from "../../src/backend/ollama.js";

function probeSpawn(code: number, stdout = "CLI commit: abc123\n"): SpawnFn {
  return vi.fn<SpawnFn>(() => {
    const closeListeners: Array<(exitCode: number | null) => void> = [];
    const child: SpawnedProcess = {
      pid: 1234,
      stdout: { onData: (listener) => listener(stdout) },
      stderr: { onData: () => {} },
      onClose: (listener) => closeListeners.push(listener),
      onError: () => {},
      kill: () => {},
    };
    queueMicrotask(() => {
      for (const listener of closeListeners) listener(code);
    });
    return child;
  });
}

function commandResult(stdout: string, code = 0): Promise<LmsCommandResult> {
  return Promise.resolve({ code, stdout, stderr: "" });
}

function jsonResponse(ok: boolean, status: number, value: unknown): FetchResponseLike {
  return {
    ok,
    status,
    body: new Response(JSON.stringify(value), { status }).body,
  };
}

const listener: ListenerIdentity = {
  pid: 7001,
  process: "LM Studio",
  executable: "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
  started: "2026-08-08T00:00:00Z",
  localAddress: "127.0.0.1",
};

describe("LmStudioAdapter — descriptor and installation", () => {
  it("advertises the attach-only LM Studio descriptor", () => {
    const adapter = new LmStudioAdapter();
    expect(adapter.name).toBe("lmstudio");
    expect(adapter.capabilities).toEqual({
      canPull: false,
      canEmbed: true,
      embeddingOffload: "unknown",
      openAiCompatible: true,
      formats: ["gguf", "mlx"],
      defaultPort: 1234,
    });
  });

  it("probes lms with discrete argv and shell disabled", async () => {
    const spawn = probeSpawn(0);
    const adapter = new LmStudioAdapter({ spawn });

    await expect(adapter.isInstalled()).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith("lms", ["--version"], {
      shell: false,
      stdio: "pipe",
      signal: expect.any(AbortSignal),
    });
    await expect(adapter.version?.()).resolves.toBe("CLI commit: abc123");
  });

  it("reports missing lms and provides the official install hint", async () => {
    const adapter = new LmStudioAdapter({ spawn: probeSpawn(1), platform: "darwin" });
    await expect(adapter.isInstalled()).resolves.toBe(false);
    expect(adapter.installHint()).toContain("lmstudio.ai");
  });
});

describe("LmStudioAdapter — delegated pull", () => {
  it("finds the exact downloaded GGUF path without claiming delegated verification", async () => {
    const runCommand = vi.fn<LmsCommandFn>(() =>
      commandResult(
        JSON.stringify([
          {
            modelKey: "qwen/qwen3-14b-gguf",
            path: "Qwen/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M.gguf",
            type: "llm",
          },
        ]),
      ),
    );
    const adapter = new LmStudioAdapter({ runCommand });
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
    ).resolves.toEqual({
      modelId: "qwen3:14b",
      digestVerified: false,
      modelPath: "Qwen/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M.gguf",
    });
    expect(runCommand).toHaveBeenCalledWith(["ls", "--json", "--llm", "--quiet"], undefined);
  });

  it("verifies an exact absolute GGUF path when LM Studio exposes one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmup-lmstudio-"));
    try {
      const path = join(dir, "Qwen", "Qwen3-14B-GGUF", "model.gguf");
      mkdirSync(join(dir, "Qwen", "Qwen3-14B-GGUF"), { recursive: true });
      const bytes = Buffer.from("verified gguf");
      writeFileSync(path, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const adapter = new LmStudioAdapter({
        modelsRoot: dir,
        runCommand: () => commandResult(JSON.stringify([{ path, type: "llm" }])),
      });

      await expect(
        adapter.pull({
          modelId: "qwen3:14b",
          source: {
            repo: "Qwen/Qwen3-14B-GGUF",
            revision: "a".repeat(40),
            file: "model.gguf",
            sha256,
          },
        }),
      ).resolves.toMatchObject({ digestVerified: true, modelPath: path });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies a relative GGUF path under the LM Studio model root", async () => {
    const modelsRoot = mkdtempSync(join(tmpdir(), "llmup-lmstudio-root-"));
    try {
      const relativePath = "Qwen/Qwen3-14B-GGUF/model.gguf";
      const path = join(modelsRoot, relativePath);
      mkdirSync(join(modelsRoot, "Qwen", "Qwen3-14B-GGUF"), { recursive: true });
      const bytes = Buffer.from("relative verified gguf");
      writeFileSync(path, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const adapter = new LmStudioAdapter({
        modelsRoot,
        runCommand: () => commandResult(JSON.stringify([{ path: relativePath, type: "llm" }])),
      });

      await expect(
        adapter.pull({
          modelId: "qwen3:14b",
          source: {
            repo: "Qwen/Qwen3-14B-GGUF",
            revision: "a".repeat(40),
            file: "model.gguf",
            sha256,
          },
        }),
      ).resolves.toMatchObject({ digestVerified: true, modelPath: relativePath });
    } finally {
      rmSync(modelsRoot, { recursive: true, force: true });
    }
  });

  it("fails gracefully when the requested model is not downloaded", async () => {
    const adapter = new LmStudioAdapter({ runCommand: () => commandResult("[]") });
    await expect(
      adapter.pull({
        modelId: "missing:7b",
        source: {
          repo: "org/missing-GGUF",
          revision: "a".repeat(40),
          file: "missing.gguf",
          sha256: "b".repeat(64),
        },
      }),
    ).rejects.toThrow(/not downloaded|lms get/i);
  });

  it("requires a path-segment boundary when matching delegated repositories", async () => {
    const adapter = new LmStudioAdapter({
      runCommand: () =>
        commandResult(
          JSON.stringify([{ path: "evilQwen/Qwen3-14B-GGUF/model.gguf", type: "llm" }]),
        ),
    });
    await expect(
      adapter.pull({
        modelId: "qwen3:14b",
        source: {
          repo: "Qwen/Qwen3-14B-GGUF",
          revision: "a".repeat(40),
          file: "model.gguf",
          sha256: "b".repeat(64),
        },
      }),
    ).rejects.toThrow(/not downloaded/i);
  });

  it("selects the installed MLX candidate and rejects dual-format ambiguity", async () => {
    const delegatedSources = [
      {
        format: "gguf" as const,
        source: {
          repo: "org/model-GGUF",
          revision: "a".repeat(40),
          file: "model.gguf",
          sha256: "b".repeat(64),
        },
      },
      {
        format: "mlx" as const,
        repository: {
          repo: "mlx-community/model-4bit",
          revision: "c".repeat(40),
          files: [
            { file: "config.json", sha256: "d".repeat(64), bytes: 1 },
            { file: "tokenizer_config.json", sha256: "e".repeat(64), bytes: 1 },
            { file: "model.safetensors", sha256: "f".repeat(64), bytes: 1 },
          ],
        },
      },
    ];
    const mlxOnly = new LmStudioAdapter({
      runCommand: () =>
        commandResult(JSON.stringify([{ path: "mlx-community/model-4bit", type: "llm" }])),
    });
    await expect(mlxOnly.pull({ modelId: "model:4b", delegatedSources })).resolves.toEqual({
      modelId: "model:4b",
      digestVerified: false,
      modelPath: "mlx-community/model-4bit",
    });

    const both = new LmStudioAdapter({
      runCommand: () =>
        commandResult(
          JSON.stringify([
            { path: "org/model-GGUF/model.gguf", type: "llm" },
            { path: "mlx-community/model-4bit", type: "llm" },
          ]),
        ),
    });
    await expect(both.pull({ modelId: "model:4b", delegatedSources })).rejects.toThrow(/multiple/i);
  });

  it("fails closed on malformed listings, digest mismatch, and symlinked weights", async () => {
    const malformed = new LmStudioAdapter({ runCommand: () => commandResult("not json") });
    await expect(
      malformed.pull({
        modelId: "qwen3:14b",
        source: {
          repo: "Qwen/Qwen3-14B-GGUF",
          revision: "a".repeat(40),
          file: "model.gguf",
          sha256: "b".repeat(64),
        },
      }),
    ).rejects.toBeInstanceOf(BackendError);

    const traversal = new LmStudioAdapter({
      modelsRoot: "/trusted/models",
      runCommand: () =>
        commandResult(
          JSON.stringify([{ path: "../../Qwen/Qwen3-14B-GGUF/model.gguf", type: "llm" }]),
        ),
    });
    await expect(
      traversal.pull({
        modelId: "qwen3:14b",
        source: {
          repo: "Qwen/Qwen3-14B-GGUF",
          revision: "a".repeat(40),
          file: "model.gguf",
          sha256: "b".repeat(64),
        },
      }),
    ).rejects.toThrow(/escapes/i);

    const dir = mkdtempSync(join(tmpdir(), "llmup-lmstudio-unsafe-"));
    try {
      const repoDir = join(dir, "Qwen", "Qwen3-14B-GGUF");
      mkdirSync(repoDir, { recursive: true });
      const target = join(repoDir, "target.gguf");
      const link = join(repoDir, "model.gguf");
      writeFileSync(target, "weights");
      const listing = () => commandResult(JSON.stringify([{ path: link, type: "llm" }]));
      const digestMismatch = new LmStudioAdapter({
        modelsRoot: dir,
        runCommand: () => commandResult(JSON.stringify([{ path: target, type: "llm" }])),
      });
      await expect(
        digestMismatch.pull({
          modelId: "qwen3:14b",
          source: {
            repo: "Qwen/Qwen3-14B-GGUF",
            revision: "a".repeat(40),
            file: "target.gguf",
            sha256: "b".repeat(64),
          },
        }),
      ).rejects.toThrow(/digest mismatch/i);

      symlinkSync(target, link);
      const symlinked = new LmStudioAdapter({ modelsRoot: dir, runCommand: listing });
      await expect(
        symlinked.pull({
          modelId: "qwen3:14b",
          source: {
            repo: "Qwen/Qwen3-14B-GGUF",
            revision: "a".repeat(40),
            file: "model.gguf",
            sha256: createHash("sha256").update("weights").digest("hex"),
          },
        }),
      ).rejects.toBeInstanceOf(BackendError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty delegated model id", async () => {
    const adapter = new LmStudioAdapter();
    await expect(adapter.pull({ modelId: "" })).rejects.toBeInstanceOf(BackendError);
  });
});

describe("LmStudioAdapter — attach-only lifecycle", () => {
  it("attaches only to an authoritative loopback LM Studio server with the requested model", async () => {
    const runCommand = vi.fn<LmsCommandFn>((args) =>
      commandResult(
        args[0] === "ps"
          ? JSON.stringify([{ identifier: "qwen3:14b", path: "Qwen/model.gguf" }])
          : JSON.stringify({ running: true, port: 1234 }),
      ),
    );
    const fetch = vi.fn<FetchFn>((url) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting")
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      if (path === "/v1/models") {
        return Promise.resolve(
          jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
        );
      }
      return Promise.resolve(jsonResponse(false, 404, {}));
    });
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      runCommand,
      listenerProbe: () => Promise.resolve(listener),
    });

    await expect(
      adapter.serve({
        host: "127.0.0.1",
        port: 1234,
        modelId: "qwen3:14b",
        modelPath: "Qwen/model.gguf",
      }),
    ).resolves.toEqual({
      endpoint: "http://127.0.0.1:1234",
      pid: 7001,
      port: 1234,
      ownedByUs: false,
      processExecutable: listener.executable,
      processStartedAt: listener.started,
      modelPath: "Qwen/model.gguf",
    });
    expect(runCommand).toHaveBeenCalledWith(["server", "status", "--json", "--quiet"], undefined);
    expect(runCommand).toHaveBeenCalledWith(["ps", "--json", "--quiet"], expect.any(AbortSignal));
  });

  it("refuses attachment until the user loads the exact runtime-managed model", async () => {
    const runCommand = vi.fn<LmsCommandFn>((args) => {
      return commandResult(
        args[0] === "server" ? JSON.stringify({ running: true, port: 1234 }) : "",
      );
    });
    const fetch: FetchFn = (url) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting")
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      if (path === "/v1/models") {
        return Promise.resolve(jsonResponse(true, 200, { object: "list", data: [] }));
      }
      return Promise.resolve(jsonResponse(false, 404, {}));
    };
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      runCommand,
      listenerProbe: () => Promise.resolve(listener),
    });

    await expect(
      adapter.serve({
        port: 1234,
        modelId: "qwen3:14b",
        modelPath: "Qwen/Qwen3-14B-GGUF/model.gguf",
      }),
    ).rejects.toThrow(/lms load/i);
    expect(runCommand.mock.calls.some(([args]) => args[0] === "load")).toBe(false);
  });

  it("rejects missing, foreign, and non-loopback servers without starting one", async () => {
    const runCommand = vi.fn<LmsCommandFn>();
    const missing = new LmStudioAdapter({
      runCommand,
      listenerProbe: () => Promise.resolve(null),
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(missing.serve({ port: 1234, modelId: "m" })).rejects.toThrow(/server start/i);
    await expect(
      missing.serve({ host: "0.0.0.0", port: 1234, modelId: "m" }),
    ).rejects.toBeInstanceOf(ValidationError);

    const foreign = new LmStudioAdapter({
      platform: "darwin",
      runCommand,
      listenerProbe: () => Promise.resolve(listener),
      fetch: () => Promise.resolve(jsonResponse(true, 200, { lmstudio: false })),
    });
    await expect(foreign.serve({ port: 1234, modelId: "m" })).rejects.toBeInstanceOf(BackendError);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects executable spoofing and listener replacement during attachment", async () => {
    const fetch: FetchFn = (url) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting") {
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      }
      return Promise.resolve(
        jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
      );
    };
    const status = () => commandResult(JSON.stringify({ running: true, port: 1234 }));
    const spoofed = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      runCommand: status,
      listenerProbe: () => Promise.resolve({ ...listener, executable: "/tmp/LM Studio" }),
    });
    await expect(spoofed.serve({ port: 1234, modelId: "qwen3:14b" })).rejects.toThrow(
      /executable/i,
    );

    const replaced = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      runCommand: status,
      listenerProbe: vi
        .fn<() => Promise<ListenerIdentity | null>>()
        .mockResolvedValueOnce(listener)
        .mockResolvedValue({ ...listener, pid: listener.pid + 1 }),
    });
    await expect(replaced.serve({ port: 1234, modelId: "qwen3:14b" })).rejects.toThrow(
      /identity changed/i,
    );
  });

  it("tolerates a transient null listener probe without accepting changed identity", async () => {
    const fetch: FetchFn = (url) => {
      const path = new URL(url).pathname;
      return Promise.resolve(
        path === "/lmstudio-greeting"
          ? jsonResponse(true, 200, { lmstudio: true })
          : jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
      );
    };
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      sleep: () => Promise.resolve(),
      runCommand: (args) =>
        commandResult(
          args[0] === "server"
            ? JSON.stringify({ running: true, port: 1234 })
            : JSON.stringify([{ identifier: "qwen3:14b", path: "Qwen/model.gguf" }]),
        ),
      listenerProbe: vi
        .fn<() => Promise<ListenerIdentity | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(listener),
    });

    await expect(
      adapter.serve({ port: 1234, modelId: "qwen3:14b", modelPath: "Qwen/model.gguf" }),
    ).resolves.toMatchObject({ ownedByUs: false, pid: listener.pid });
  });

  it("trusts the canonical Windows per-user executable case-insensitively", async () => {
    const windowsListener: ListenerIdentity = {
      ...listener,
      executable: "c:\\users\\me\\appdata\\local\\programs\\lm studio\\lm studio.exe",
    };
    const fetch: FetchFn = (url) =>
      Promise.resolve(
        new URL(url).pathname === "/lmstudio-greeting"
          ? jsonResponse(true, 200, { lmstudio: true })
          : jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
      );
    const adapter = new LmStudioAdapter({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local" },
      fetch,
      runCommand: (args) =>
        commandResult(
          args[0] === "server"
            ? JSON.stringify({ running: true, port: 1234 })
            : JSON.stringify([{ identifier: "qwen3:14b", path: "Qwen/model.gguf" }]),
        ),
      listenerProbe: () => Promise.resolve(windowsListener),
    });

    await expect(
      adapter.serve({ port: 1234, modelId: "qwen3:14b", modelPath: "Qwen/model.gguf" }),
    ).resolves.toMatchObject({ processExecutable: windowsListener.executable });
  });
});

describe("LmStudioAdapter — OpenAI-compatible inference", () => {
  const loadedCommand: LmsCommandFn = () =>
    commandResult(JSON.stringify([{ identifier: "qwen3:14b", path: "Qwen/model.gguf" }]));
  it("rejects a malformed LM Studio API token at construction", () => {
    expect(() => new LmStudioAdapter({ env: { LM_API_TOKEN: "bad\nvalue" } })).toThrow(
      ValidationError,
    );
  });

  it("routes bounded chat and embeddings through the attached endpoint", async () => {
    const fetch: FetchFn = (url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-token" });
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting")
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      if (path === "/v1/models") {
        return Promise.resolve(
          jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
        );
      }
      if (path === "/v1/chat/completions") {
        expect(JSON.parse(init?.body ?? "{}")).toMatchObject({ model: "qwen3:14b", stream: false });
        return Promise.resolve(
          jsonResponse(true, 200, { choices: [{ message: { content: "hello" } }] }),
        );
      }
      if (path === "/v1/embeddings") {
        return Promise.resolve(
          jsonResponse(true, 200, {
            data: [
              { index: 0, embedding: [0.1, 0.2] },
              { index: 1, embedding: [0.3, 0.4] },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse(false, 404, {}));
    };
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      env: { LM_API_TOKEN: "test-token" },
      runCommand: loadedCommand,
      listenerProbe: () => Promise.resolve(listener),
    });

    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:1234/ignored",
        model: "qwen3:14b",
        messages: [{ role: "user", content: "hi" }],
        expectedProcess: {
          pid: listener.pid,
          executable: listener.executable,
          started: listener.started,
        },
        expectedModelPath: "Qwen/model.gguf",
      }),
    ).resolves.toEqual({ content: "hello" });
    await expect(
      adapter.embed({
        endpoint: "http://127.0.0.1:1234",
        model: "qwen3:14b",
        input: ["a", "b"],
        expectedProcess: {
          pid: listener.pid,
          executable: listener.executable,
          started: listener.started,
        },
        expectedModelPath: "Qwen/model.gguf",
      }),
    ).resolves.toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      dimension: 2,
    });
  });

  it("cancels an oversized streaming response", async () => {
    const cancelled = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled();
      },
    });
    const fetch: FetchFn = (url) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting") {
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      }
      if (path === "/v1/models") {
        return Promise.resolve(
          jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
        );
      }
      return Promise.resolve({ ok: true, status: 200, body: oversized });
    };
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch,
      runCommand: loadedCommand,
      listenerProbe: () => Promise.resolve(listener),
    });

    await expect(
      adapter.chat({
        endpoint: "http://127.0.0.1:1234",
        model: "qwen3:14b",
        messages: [],
        expectedProcess: {
          pid: listener.pid,
          executable: listener.executable,
          started: listener.started,
        },
        expectedModelPath: "Qwen/model.gguf",
      }),
    ).rejects.toThrow(/byte limit/i);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("enforces the caller readiness deadline across a hanging response", async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchFn = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      const adapter = new LmStudioAdapter({
        platform: "darwin",
        fetch,
        listenerProbe: () => Promise.resolve(listener),
      });
      const readiness = adapter.waitUntilReady({
        endpoint: "http://127.0.0.1:1234",
        timeoutMs: 10,
        retries: 1,
        expectedProcess: {
          pid: listener.pid,
          executable: listener.executable,
          started: listener.started,
        },
        modelId: "qwen3:14b",
        expectedModelPath: "Qwen/model.gguf",
      });
      const rejected = expect(readiness).rejects.toBeInstanceOf(BackendError);
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the caller readiness deadline across a hanging listener probe", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new LmStudioAdapter({
        platform: "darwin",
        listenerProbe: () => new Promise<ListenerIdentity | null>(() => {}),
      });
      const readiness = adapter.waitUntilReady({
        endpoint: "http://127.0.0.1:1234",
        timeoutMs: 10,
        retries: 1,
        modelId: "qwen3:14b",
        expectedModelPath: "Qwen/model.gguf",
        expectedProcess: {
          pid: listener.pid,
          executable: listener.executable,
          started: listener.started,
        },
      });
      const rejected = expect(readiness).rejects.toBeInstanceOf(BackendError);
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LmStudioAdapter — error-path branch coverage", () => {
  const EXPECTED = {
    pid: listener.pid,
    executable: listener.executable,
    started: listener.started,
  };
  const loadedPs: LmsCommandFn = (args) =>
    commandResult(
      args[0] === "server"
        ? JSON.stringify({ running: true, port: 1234 })
        : JSON.stringify([{ identifier: "qwen3:14b", path: "Qwen/model.gguf" }]),
    );

  function inferenceFetch(
    extra?: (path: string, init?: Parameters<FetchFn>[1]) => FetchResponseLike | undefined,
  ): FetchFn {
    return (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting")
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      if (path === "/v1/models")
        return Promise.resolve(
          jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
        );
      return Promise.resolve(extra?.(path, init) ?? jsonResponse(false, 404, {}));
    };
  }

  function inferenceAdapter(fetchFn: FetchFn, runCommand: LmsCommandFn = loadedPs): LmStudioAdapter {
    return new LmStudioAdapter({
      platform: "darwin",
      fetch: fetchFn,
      runCommand,
      listenerProbe: () => Promise.resolve(listener),
    });
  }

  const baseChat = {
    endpoint: "http://127.0.0.1:1234",
    model: "qwen3:14b",
    messages: [{ role: "user" as const, content: "hi" }],
    expectedProcess: EXPECTED,
    expectedModelPath: "Qwen/model.gguf",
  };
  const baseEmbed = {
    endpoint: "http://127.0.0.1:1234",
    model: "qwen3:14b",
    input: ["a", "b"],
    expectedProcess: EXPECTED,
    expectedModelPath: "Qwen/model.gguf",
  };

  it("refuses chat without process and model-path identity", async () => {
    const adapter = inferenceAdapter(inferenceFetch());
    await expect(
      adapter.chat({ endpoint: baseChat.endpoint, model: baseChat.model, messages: baseChat.messages }),
    ).rejects.toThrow(/without process and model-path identity/i);
    await expect(
      adapter.chat({ ...baseChat, expectedModelPath: undefined }),
    ).rejects.toThrow(/without process and model-path identity/i);
  });

  it("refuses inference when the listener identity is unavailable", async () => {
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch: inferenceFetch(),
      runCommand: loadedPs,
      listenerProbe: () => Promise.resolve(null),
    });
    await expect(adapter.chat(baseChat)).rejects.toThrow(/listener identity is unavailable/i);
  });

  it("refuses inference when the listener executable is untrusted", async () => {
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch: inferenceFetch(),
      runCommand: loadedPs,
      listenerProbe: () => Promise.resolve({ ...listener, executable: "/tmp/LM Studio" }),
    });
    await expect(adapter.chat(baseChat)).rejects.toThrow(/not a trusted/i);
  });

  it("refuses inference when the expected process identity does not match", async () => {
    const adapter = inferenceAdapter(inferenceFetch());
    await expect(
      adapter.chat({ ...baseChat, expectedProcess: { ...EXPECTED, pid: EXPECTED.pid + 1 } }),
    ).rejects.toThrow(/process identity changed/i);
  });

  it("refuses inference when the greeting is not an authoritative LM Studio", async () => {
    const fetch: FetchFn = (url) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting")
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: false }));
      return Promise.resolve(
        jsonResponse(true, 200, { object: "list", data: [{ id: "qwen3:14b" }] }),
      );
    };
    const adapter = inferenceAdapter(fetch);
    await expect(adapter.chat(baseChat)).rejects.toThrow(/process identity changed/i);
  });

  it("refuses inference when the model is not available", async () => {
    const fetch: FetchFn = (url) => {
      const path = new URL(url).pathname;
      if (path === "/lmstudio-greeting")
        return Promise.resolve(jsonResponse(true, 200, { lmstudio: true }));
      return Promise.resolve(jsonResponse(true, 200, { object: "list", data: [] }));
    };
    const adapter = inferenceAdapter(fetch);
    await expect(adapter.chat(baseChat)).rejects.toThrow(/is not available/i);
  });

  it("refuses inference when the loaded-model query fails or mismatches", async () => {
    const psFails = inferenceAdapter(inferenceFetch(), (args) =>
      commandResult(args[0] === "server" ? JSON.stringify({ running: true, port: 1234 }) : "", 1),
    );
    await expect(psFails.chat(baseChat)).rejects.toThrow(/failed to query loaded/i);

    const psWrongPath = inferenceAdapter(inferenceFetch(), (args) =>
      commandResult(
        args[0] === "server"
          ? JSON.stringify({ running: true, port: 1234 })
          : JSON.stringify([{ identifier: "qwen3:14b", path: "Other/model.gguf" }]),
      ),
    );
    await expect(psWrongPath.chat(baseChat)).rejects.toThrow(/not loaded from the exact/i);
  });

  it("refuses inference when the listener changes during validation", async () => {
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch: inferenceFetch(),
      runCommand: loadedPs,
      listenerProbe: vi
        .fn<() => Promise<ListenerIdentity | null>>()
        .mockResolvedValueOnce(listener)
        .mockResolvedValue({ ...listener, pid: listener.pid + 5 }),
    });
    await expect(adapter.chat(baseChat)).rejects.toThrow(/listener changed during validation/i);
  });

  it("rejects an oversized chat request body", async () => {
    const adapter = inferenceAdapter(inferenceFetch());
    await expect(
      adapter.chat({
        ...baseChat,
        messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 16) }],
      }),
    ).rejects.toThrow(/request exceeds byte limit/i);
  });

  it("rejects a chat HTTP error, malformed JSON, and oversized content", async () => {
    const httpError = inferenceAdapter(
      inferenceFetch((path) =>
        path === "/v1/chat/completions" ? jsonResponse(false, 503, {}) : undefined,
      ),
    );
    await expect(httpError.chat(baseChat)).rejects.toThrow(/HTTP 503/i);

    const malformed = inferenceAdapter(
      inferenceFetch((path) =>
        path === "/v1/chat/completions" ? jsonResponse(true, 200, { nope: 1 }) : undefined,
      ),
    );
    await expect(malformed.chat(baseChat)).rejects.toThrow(/malformed JSON/i);

    const oversized = inferenceAdapter(
      inferenceFetch((path) =>
        path === "/v1/chat/completions"
          ? jsonResponse(true, 200, {
              choices: [{ message: { content: "y".repeat(1024 * 1024 + 16) } }],
            })
          : undefined,
      ),
    );
    await expect(oversized.chat(baseChat)).rejects.toThrow(/invalid content/i);
  });

  it("rejects invalid embedding input counts and oversized bodies", async () => {
    const adapter = inferenceAdapter(inferenceFetch());
    await expect(adapter.embed({ ...baseEmbed, input: [] })).rejects.toThrow(/input count is invalid/i);
    await expect(
      adapter.embed({ ...baseEmbed, input: Array.from({ length: 1025 }, () => "a") }),
    ).rejects.toThrow(/input count is invalid/i);
    await expect(
      adapter.embed({ ...baseEmbed, input: ["z".repeat(4 * 1024 * 1024 + 16)] }),
    ).rejects.toThrow(/request exceeds byte limit/i);
  });

  it("rejects embedding HTTP errors, length mismatches, and inconsistent vectors", async () => {
    const httpError = inferenceAdapter(
      inferenceFetch((path) =>
        path === "/v1/embeddings" ? jsonResponse(false, 500, {}) : undefined,
      ),
    );
    await expect(httpError.embed(baseEmbed)).rejects.toThrow(/HTTP 500/i);

    const lengthMismatch = inferenceAdapter(
      inferenceFetch((path) =>
        path === "/v1/embeddings"
          ? jsonResponse(true, 200, { data: [{ index: 0, embedding: [0.1, 0.2] }] })
          : undefined,
      ),
    );
    await expect(lengthMismatch.embed(baseEmbed)).rejects.toThrow(/malformed JSON/i);

    const inconsistent = inferenceAdapter(
      inferenceFetch((path) =>
        path === "/v1/embeddings"
          ? jsonResponse(true, 200, {
              data: [
                { index: 0, embedding: [0.1, 0.2] },
                { index: 1, embedding: [0.3] },
              ],
            })
          : undefined,
      ),
    );
    await expect(inconsistent.embed(baseEmbed)).rejects.toThrow(/inconsistent vectors/i);
  });

  it("rejects a failed or mismatched LM Studio server status during attach", async () => {
    const statusFails = new LmStudioAdapter({
      platform: "darwin",
      fetch: inferenceFetch(),
      runCommand: (args) =>
        commandResult(args[0] === "server" ? JSON.stringify({ running: true, port: 1234 }) : "", 1),
      listenerProbe: () => Promise.resolve(listener),
    });
    await expect(
      statusFails.serve({ port: 1234, modelId: "qwen3:14b", modelPath: "Qwen/model.gguf" }),
    ).rejects.toThrow(/failed to query LM Studio server status/i);

    const portMismatch = new LmStudioAdapter({
      platform: "darwin",
      fetch: inferenceFetch(),
      runCommand: (args) =>
        commandResult(
          args[0] === "server"
            ? JSON.stringify({ running: true, port: 9999 })
            : JSON.stringify([{ identifier: "qwen3:14b", path: "Qwen/model.gguf" }]),
        ),
      listenerProbe: () => Promise.resolve(listener),
    });
    await expect(
      portMismatch.serve({ port: 1234, modelId: "qwen3:14b", modelPath: "Qwen/model.gguf" }),
    ).rejects.toThrow(/reports port 9999/i);
  });

  it("requires the exact delegated model path when attaching to a loaded model", async () => {
    const adapter = inferenceAdapter(inferenceFetch());
    await expect(adapter.serve({ port: 1234, modelId: "qwen3:14b" })).rejects.toThrow(
      /requires the exact delegated model path/i,
    );
  });

  it("rejects an attach whose loaded model path does not match exactly", async () => {
    const adapter = inferenceAdapter(inferenceFetch(), (args) =>
      commandResult(
        args[0] === "server"
          ? JSON.stringify({ running: true, port: 1234 })
          : JSON.stringify([{ identifier: "qwen3:14b", path: "Other/model.gguf" }]),
      ),
    );
    await expect(
      adapter.serve({ port: 1234, modelId: "qwen3:14b", modelPath: "Qwen/model.gguf" }),
    ).rejects.toThrow(/not loaded from the exact/i);
  });

  it("rejects an attach when the listener changes during model validation", async () => {
    const adapter = new LmStudioAdapter({
      platform: "darwin",
      fetch: inferenceFetch(),
      runCommand: loadedPs,
      listenerProbe: vi
        .fn<() => Promise<ListenerIdentity | null>>()
        .mockResolvedValueOnce(listener)
        .mockResolvedValueOnce(listener)
        .mockResolvedValue({ ...listener, pid: listener.pid + 9 }),
    });
    await expect(
      adapter.serve({ port: 1234, modelId: "qwen3:14b", modelPath: "Qwen/model.gguf" }),
    ).rejects.toThrow(/identity changed during model validation/i);
  });

  it("fails a delegated pull when the LM Studio listing command errors", async () => {
    const adapter = new LmStudioAdapter({ runCommand: () => commandResult("", 1) });
    await expect(
      adapter.pull({
        modelId: "qwen3:14b",
        source: {
          repo: "Qwen/Qwen3-14B-GGUF",
          revision: "a".repeat(40),
          file: "model.gguf",
          sha256: "b".repeat(64),
        },
      }),
    ).rejects.toThrow(/failed to list downloaded/i);
  });

  it("reports a null version when the probe exits non-zero or overflows", async () => {
    await expect(new LmStudioAdapter({ spawn: probeSpawn(1) }).version?.()).resolves.toBeNull();
    await expect(
      new LmStudioAdapter({ spawn: probeSpawn(0, "x".repeat(9000)) }).version?.(),
    ).resolves.toBeNull();
    await expect(new LmStudioAdapter({ spawn: probeSpawn(0, "   ") }).version?.()).resolves.toBeNull();
  });

  it("requires full identity for readiness", async () => {
    const adapter = new LmStudioAdapter({ platform: "darwin" });
    await expect(
      adapter.waitUntilReady({
        endpoint: "http://127.0.0.1:1234",
        modelId: "qwen3:14b",
        expectedModelPath: "Qwen/model.gguf",
      }),
    ).rejects.toThrow(/requires process, model, and delegated path identity/i);
  });

  it("classifies default trusted LM Studio executables by platform", () => {
    expect(
      isDefaultTrustedLmStudioExecutable(
        "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
        "darwin",
      ),
    ).toBe(true);
    expect(isDefaultTrustedLmStudioExecutable("/tmp/rogue", "darwin")).toBe(false);
    expect(
      isDefaultTrustedLmStudioExecutable(
        "C:\\Program Files\\LM Studio\\LM Studio.exe",
        "win32",
        {},
      ),
    ).toBe(true);
    expect(isDefaultTrustedLmStudioExecutable("/usr/bin/llmster", "linux", {})).toBe(true);
  });
});
