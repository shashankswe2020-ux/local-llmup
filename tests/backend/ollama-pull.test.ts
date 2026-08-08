import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import type { PullProgress } from "../../src/backend/adapter.js";
import {
  OllamaAdapter,
  createDefaultDigestProbe,
  type DigestProbe,
  type SpawnFn,
  type SpawnedProcess,
} from "../../src/backend/ollama.js";

interface RecordedSpawn {
  command: string;
  args: readonly string[];
  signal: AbortSignal | undefined;
}

interface FakeSpawnConfig {
  stdout?: string[];
  stderr?: string[];
  code?: number;
  error?: Error;
}

/**
 * Build a {@link SpawnFn} that records its invocation and, on the next tick
 * (after the adapter has attached its listeners), replays the configured output
 * lines and then either an `error` or a `close` with the given exit code.
 */
function fakeSpawn(config: FakeSpawnConfig): { spawn: SpawnFn; recorded: RecordedSpawn[] } {
  const recorded: RecordedSpawn[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    recorded.push({ command, args, signal: options.signal });
    const dataListeners = {
      stdout: [] as ((chunk: string) => void)[],
      stderr: [] as ((chunk: string) => void)[],
    };
    const closeListeners: ((code: number | null) => void)[] = [];
    const errorListeners: ((error: Error) => void)[] = [];
    const child: SpawnedProcess = {
      pid: 4242,
      stdout: { onData: (listener) => dataListeners.stdout.push(listener) },
      stderr: { onData: (listener) => dataListeners.stderr.push(listener) },
      onClose: (listener) => closeListeners.push(listener),
      onError: (listener) => errorListeners.push(listener),
      kill: () => {},
    };
    setTimeout(() => {
      if (config.error) {
        for (const listener of errorListeners) listener(config.error);
        return;
      }
      for (const line of config.stdout ?? [])
        for (const listener of dataListeners.stdout) listener(line);
      for (const line of config.stderr ?? [])
        for (const listener of dataListeners.stderr) listener(line);
      for (const listener of closeListeners) listener(config.code ?? 0);
    }, 0);
    return child;
  };
  return { spawn, recorded };
}

const okProbe: DigestProbe = () => Promise.resolve({ sha256: "abc123", sizeBytes: 4900000000 });

describe("OllamaAdapter.pull", () => {
  it("spawns `ollama pull` with discrete args and an end-of-options separator", async () => {
    const { spawn, recorded } = fakeSpawn({ stdout: ["success\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn, probe: okProbe });

    await adapter.pull({ modelId: "llama3.1:8b", expectedSha256: "abc123" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.command).toBe("ollama");
    expect(recorded[0]?.args).toEqual(["pull", "--", "llama3.1:8b"]);
  });

  it("streams progress status lines to onProgress", async () => {
    const { spawn } = fakeSpawn({
      stdout: ["pulling manifest\n", "pulling 8ab4: 45%\r", "pulling 8ab4: 100%\n", "success\n"],
      code: 0,
    });
    const adapter = new OllamaAdapter({ spawn, probe: okProbe });
    const events: PullProgress[] = [];

    await adapter.pull({
      modelId: "llama3.1:8b",
      expectedSha256: "abc123",
      onProgress: (event) => events.push(event),
    });

    const statuses = events.map((event) => event.status);
    expect(statuses).toContain("pulling manifest");
    expect(statuses).toContain("success");
  });

  it("forwards the abort signal to the spawned process", async () => {
    const { spawn, recorded } = fakeSpawn({ code: 0 });
    const adapter = new OllamaAdapter({ spawn, probe: okProbe });
    const controller = new AbortController();

    await adapter.pull({
      modelId: "llama3.1:8b",
      expectedSha256: "abc123",
      signal: controller.signal,
    });

    expect(recorded[0]?.signal).toBe(controller.signal);
  });

  it("rejects an unsafe model id before spawning", async () => {
    const { spawn, recorded } = fakeSpawn({ code: 0 });
    const adapter = new OllamaAdapter({ spawn, probe: okProbe });

    await expect(
      adapter.pull({ modelId: "-rf; rm", expectedSha256: "abc" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(recorded).toHaveLength(0);
  });

  it("throws BackendError on a non-zero exit code", async () => {
    const { spawn } = fakeSpawn({ stderr: ["Error: pull failed\n"], code: 1 });
    const adapter = new OllamaAdapter({ spawn, probe: okProbe });

    await expect(
      adapter.pull({ modelId: "llama3.1:8b", expectedSha256: "abc" }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("throws BackendError when the process fails to spawn", async () => {
    const spawnError = Object.assign(new Error("spawn ollama ENOENT"), { code: "ENOENT" });
    const { spawn } = fakeSpawn({ error: spawnError });
    const adapter = new OllamaAdapter({ spawn, probe: okProbe });

    await expect(
      adapter.pull({ modelId: "llama3.1:8b", expectedSha256: "abc" }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("reports digestVerified:true when the digest matches", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sha256: "DEAD", sizeBytes: 10 });
    const adapter = new OllamaAdapter({ spawn, probe });

    const result = await adapter.pull({ modelId: "llama3.1:8b", expectedSha256: "dead" });

    expect(result).toEqual({ modelId: "llama3.1:8b", digestVerified: true });
  });

  it("fails closed on a digest mismatch", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sha256: "aaaa", sizeBytes: 10 });
    const adapter = new OllamaAdapter({ spawn, probe });

    await expect(
      adapter.pull({ modelId: "llama3.1:8b", expectedSha256: "bbbb" }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("falls back to size-only verification when no digest is available", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sizeBytes: 4900000000 });
    const adapter = new OllamaAdapter({ spawn, probe });

    const result = await adapter.pull({ modelId: "llama3.1:8b", expectedSizeBytes: 4900000000 });

    expect(result).toEqual({ modelId: "llama3.1:8b", digestVerified: false });
  });

  it("accepts a pull larger than the approximate catalog size", async () => {
    // Real regression: the catalog `diskBytes` is a rough estimate, and real
    // Ollama pulls are routinely larger (e.g. llama3.2:1b: catalog ~800 MB,
    // actual ~1.32 GB). The fallback must not fail on this benign difference.
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sizeBytes: 1_321_082_688 });
    const adapter = new OllamaAdapter({ spawn, probe });

    const result = await adapter.pull({ modelId: "llama3.2:1b", expectedSizeBytes: 800_000_000 });

    expect(result).toEqual({ modelId: "llama3.2:1b", digestVerified: false });
  });

  it("accepts a pull modestly under the approximate catalog size", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sizeBytes: 3_800_000_000 });
    const adapter = new OllamaAdapter({ spawn, probe });

    const result = await adapter.pull({ modelId: "llama3.1:8b", expectedSizeBytes: 4_900_000_000 });

    expect(result).toEqual({ modelId: "llama3.1:8b", digestVerified: false });
  });

  it("does not fail open: an expected digest with no actual digest fails closed", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sizeBytes: 5 });
    const adapter = new OllamaAdapter({ spawn, probe });

    await expect(
      adapter.pull({ modelId: "llama3.1:8b", expectedSha256: "abc123" }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("fails closed when no digest and no size are available", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({});
    const adapter = new OllamaAdapter({ spawn, probe });

    await expect(adapter.pull({ modelId: "llama3.1:8b" })).rejects.toBeInstanceOf(BackendError);
  });

  it("fails closed when the download is grossly smaller than expected (truncated)", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const probe: DigestProbe = () => Promise.resolve({ sizeBytes: 100 });
    const adapter = new OllamaAdapter({ spawn, probe });

    await expect(
      adapter.pull({ modelId: "llama3.1:8b", expectedSizeBytes: 4_900_000_000 }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

describe("OllamaAdapter.isInstalled / installHint", () => {
  it("reports installed when `ollama --version` exits zero", async () => {
    const { spawn, recorded } = fakeSpawn({ stdout: ["ollama version 0.1\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.isInstalled()).resolves.toBe(true);
    expect(recorded[0]?.args).toEqual(["--version"]);
    expect(recorded[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports not installed when the binary is missing", async () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.isInstalled()).resolves.toBe(false);
  });

  it("gives an OS-appropriate install hint", () => {
    expect(new OllamaAdapter({ platform: "darwin" }).installHint()).toContain("brew");
    expect(new OllamaAdapter({ platform: "linux" }).installHint()).toContain("install.sh");
    expect(new OllamaAdapter({ platform: "win32" }).installHint()).toContain("winget");
  });
});

describe("OllamaAdapter.version", () => {
  it("spawns `ollama --version` with a discrete arg array", async () => {
    const { spawn, recorded } = fakeSpawn({ stdout: ["ollama version is 0.3.14\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn });

    await adapter.version();

    expect(recorded[0]?.command).toBe("ollama");
    expect(recorded[0]?.args).toEqual(["--version"]);
  });

  it("extracts the semver token from the version banner", async () => {
    const { spawn } = fakeSpawn({ stdout: ["ollama version is 0.3.14\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.version()).resolves.toBe("0.3.14");
  });

  it("returns null when the process exits non-zero", async () => {
    const { spawn } = fakeSpawn({ stdout: ["boom\n"], code: 1 });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.version()).resolves.toBeNull();
  });

  it("returns null when the binary is missing", async () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.version()).resolves.toBeNull();
  });

  it("falls back to the trimmed banner when no semver is present", async () => {
    const { spawn } = fakeSpawn({ stdout: ["dev-build\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.version()).resolves.toBe("dev-build");
  });

  it("passes an abort signal so a hung probe cannot block doctor", async () => {
    const { spawn, recorded } = fakeSpawn({ stdout: ["ollama version is 0.3.14\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn });

    await adapter.version();

    expect(recorded[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("strips control sequences from a non-semver banner at the source", async () => {
    const { spawn } = fakeSpawn({ stdout: ["dev\u001b[31mbuild\n"], code: 0 });
    const adapter = new OllamaAdapter({ spawn });

    await expect(adapter.version()).resolves.toBe("devbuild");
  });
});

describe("createDefaultDigestProbe", () => {
  const manifest = JSON.stringify({
    layers: [
      { mediaType: "application/vnd.ollama.image.template", digest: "sha256:tmpl", size: 1 },
      {
        mediaType: "application/vnd.ollama.image.model",
        digest: `sha256:${"a".repeat(64)}`,
        size: 4900000000,
      },
    ],
  });

  it("hashes the model blob referenced by the manifest", async () => {
    const readFile = vi.fn((path: string) => {
      expect(path).toContain("manifests/registry.ollama.ai/library/llama3.1/8b");
      return Promise.resolve(manifest);
    });
    const hashFile = vi.fn((path: string) => {
      expect(path).toContain(`blobs/sha256-${"a".repeat(64)}`);
      return Promise.resolve("computedhash");
    });
    const statFile = vi.fn(() => Promise.resolve({ size: 4900000000 }));
    const probe = createDefaultDigestProbe({ modelsDir: "/models", readFile, hashFile, statFile });

    await expect(probe("llama3.1:8b")).resolves.toEqual({
      sha256: "computedhash",
      sizeBytes: 4900000000,
    });
  });

  it("defaults the tag to `latest` and namespace to `library`", async () => {
    const readFile = vi.fn((path: string) => {
      expect(path).toContain("library/gemma2/latest");
      return Promise.resolve(manifest);
    });
    const probe = createDefaultDigestProbe({
      modelsDir: "/models",
      readFile,
      hashFile: () => Promise.resolve("h"),
      statFile: () => Promise.resolve({ size: 1 }),
    });

    await probe("gemma2");
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("resolves a registry/namespace/name id", async () => {
    const readFile = vi.fn((path: string) => {
      expect(path).toContain("manifests/registry.example.com/team/model/v1");
      return Promise.resolve(manifest);
    });
    const probe = createDefaultDigestProbe({
      modelsDir: "/models",
      readFile,
      hashFile: () => Promise.resolve("h"),
      statFile: () => Promise.resolve({ size: 1 }),
    });

    await probe("registry.example.com/team/model:v1");
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("returns nothing when the manifest cannot be read", async () => {
    const probe = createDefaultDigestProbe({
      modelsDir: "/models",
      readFile: () => Promise.reject(new Error("ENOENT")),
    });

    await expect(probe("llama3.1:8b")).resolves.toEqual({});
  });

  it("returns nothing when the manifest is malformed JSON", async () => {
    const probe = createDefaultDigestProbe({
      modelsDir: "/models",
      readFile: () => Promise.resolve("{not json"),
    });

    await expect(probe("llama3.1:8b")).resolves.toEqual({});
  });

  it("returns nothing when the manifest has no model layer", async () => {
    const probe = createDefaultDigestProbe({
      modelsDir: "/models",
      readFile: () => Promise.resolve(JSON.stringify({ layers: [] })),
    });

    await expect(probe("llama3.1:8b")).resolves.toEqual({});
  });

  it("ignores a model layer whose digest is not a 64-char hex sha256", async () => {
    const readFile = () =>
      Promise.resolve(
        JSON.stringify({
          layers: [
            {
              mediaType: "application/vnd.ollama.image.model",
              digest: "sha256:../../../../etc/passwd",
              size: 1,
            },
          ],
        }),
      );
    const hashFile = vi.fn(() => Promise.resolve("h"));
    const probe = createDefaultDigestProbe({ modelsDir: "/models", readFile, hashFile });

    await expect(probe("llama3.1:8b")).resolves.toEqual({});
    expect(hashFile).not.toHaveBeenCalled();
  });

  it("refuses to read a manifest for a traversal-y model id", async () => {
    const readFile = vi.fn(() => Promise.resolve(manifest));
    const probe = createDefaultDigestProbe({ modelsDir: "/models", readFile });

    await expect(probe("../../../../etc/passwd")).resolves.toEqual({});
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not trust the manifest-declared size when the blob cannot be stat-ed", async () => {
    const readFile = () => Promise.resolve(manifest);
    const probe = createDefaultDigestProbe({
      modelsDir: "/models",
      readFile,
      hashFile: () => Promise.resolve("computedhash"),
      statFile: () => Promise.reject(new Error("ENOENT")),
    });

    await expect(probe("llama3.1:8b")).resolves.toEqual({
      sha256: "computedhash",
      sizeBytes: undefined,
    });
  });
});
