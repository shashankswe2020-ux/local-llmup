import { describe, expect, it } from "vitest";
import { BackendError } from "../../src/errors.js";
import { LlamaCppAdapter } from "../../src/backend/llamacpp.js";
import { createDefaultRegistry } from "../../src/backend/registry.js";
import type { SpawnFn, SpawnedProcess } from "../../src/backend/ollama.js";

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
      stderr: "version: 3860 (a1b2c3d)\nbuilt with Apple clang version 15.0.0 (clang-1500.0.40.1)\n",
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

describe("LlamaCppAdapter — unimplemented lifecycle (B14b/B14c)", () => {
  it("throws BackendError for serve/pull/chat until later slices land", async () => {
    const adapter = new LlamaCppAdapter();
    await expect(adapter.serve()).rejects.toBeInstanceOf(BackendError);
    await expect(adapter.pull({ modelId: "m" })).rejects.toBeInstanceOf(BackendError);
    await expect(adapter.chat({ model: "m", messages: [] })).rejects.toBeInstanceOf(BackendError);
    await expect(adapter.embed({ model: "m", input: [] })).rejects.toBeInstanceOf(BackendError);
    await expect(
      adapter.waitUntilReady({ endpoint: "http://127.0.0.1:8080" }),
    ).rejects.toBeInstanceOf(BackendError);
    await expect(
      adapter.stop({ endpoint: "http://127.0.0.1:8080", pid: 1, port: 8080, ownedByUs: true }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

describe("createDefaultRegistry — llama.cpp registration", () => {
  it("registers llama.cpp alongside ollama", () => {
    const registry = createDefaultRegistry();
    expect(registry.all().map((a) => a.name)).toEqual(["ollama", "llamacpp"]);
    expect(registry.get("llamacpp")).toBeInstanceOf(LlamaCppAdapter);
  });
});
