import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BackendError } from "../../src/errors.js";
import { loadConfig } from "../../src/config.js";
import {
  acquireRepository,
  lockRepositorySnapshot,
  type AcquireRepositoryArtifact,
  type AcquireRepositoryDeps,
  type AcquireRequest,
  type AcquireResult,
} from "../../src/backend/acquire.js";

const REVISION = "a".repeat(40);

function artifact(file: string, bytes: number, hex: string): AcquireRepositoryArtifact {
  return { file, bytes, sha256: hex.repeat(64) };
}

function manifest(): readonly AcquireRepositoryArtifact[] {
  return [
    artifact("config.json", 10, "b"),
    artifact("tokenizer_config.json", 20, "c"),
    artifact("weights/model.safetensors", 30, "d"),
  ];
}

describe("acquireRepository", () => {
  it("serializes one repository snapshot and permits retry after release", () => {
    const home = mkdtempSync(join(tmpdir(), "llmup-repository-lock-"));
    const config = loadConfig({ LOCAL_LLMUP_HOME: home });
    const request = { backend: "mlx" as const, repo: "o/r", revision: REVISION, files: manifest() };
    try {
      const release = lockRepositorySnapshot(request, config);
      expect(() => lockRepositorySnapshot(request, config)).toThrow(BackendError);
      release();
      const retryRelease = lockRepositorySnapshot(request, config);
      retryRelease();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("holds one repository lock through acquisition and final verification", async () => {
    const events: string[] = [];
    const files = manifest();
    const request = { backend: "mlx" as const, repo: "o/r", revision: REVISION, files };
    await acquireRepository(request, {
      lockRepository: (received) => {
        expect(received).toBe(request);
        events.push("lock");
        return () => events.push("release");
      },
      acquire: (entry) => {
        events.push(`acquire:${entry.file}`);
        const expected = files.find((file) => file.file === entry.file)!;
        return Promise.resolve({
          path: join("/cache/root", entry.file),
          bytes: expected.bytes,
          digestVerified: true,
          cached: true,
        });
      },
      listFiles: () => {
        events.push("verify");
        return files.map((file) => file.file);
      },
    });
    expect(events[0]).toBe("lock");
    expect(events.at(-2)).toBe("verify");
    expect(events.at(-1)).toBe("release");

    const release = vi.fn();
    await expect(
      acquireRepository(request, {
        lockRepository: () => release,
        acquire: () => Promise.reject(new BackendError("interrupted")),
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(release).toHaveBeenCalledOnce();
  });

  it("acquires every pinned file and returns their shared revision directory", async () => {
    const requests: AcquireRequest[] = [];
    const progress: Array<{ completedBytes: number; totalBytes: number; file: string }> = [];
    const acquire = vi.fn(
      (request: AcquireRequest): Promise<AcquireResult> => {
        requests.push(request);
        return Promise.resolve({
          path: join("/cache/mlx/o/r@" + REVISION, request.file),
          bytes: manifest().find((entry) => entry.file === request.file)?.bytes ?? 0,
          digestVerified: true,
          cached: false,
        });
      },
    );
    const deps: AcquireRepositoryDeps = {
      acquire,
      listFiles: () => manifest().map((entry) => entry.file),
      onProgress: (event) => progress.push(event),
    };

    const result = await acquireRepository(
      { backend: "mlx", repo: "o/r", revision: REVISION, files: manifest() },
      deps,
    );

    expect(result).toEqual({
      path: join("/cache/mlx/o/r@" + REVISION),
      bytes: 60,
      digestVerified: true,
      cached: false,
    });
    expect(requests).toEqual(
      manifest().map((entry) => ({
        backend: "mlx",
        repo: "o/r",
        revision: REVISION,
        file: entry.file,
        sha256: entry.sha256,
      })),
    );
    expect(progress.at(-1)).toEqual({
      completedBytes: 60,
      totalBytes: 60,
      file: "weights/model.safetensors",
    });
  });

  it("reports cached only when every file is a verified cache hit", async () => {
    const files = manifest();
    let index = 0;
    const result = await acquireRepository(
      { backend: "mlx", repo: "o/r", revision: REVISION, files },
      {
        acquire: (request) => {
          const entry = files[index++]!;
          return Promise.resolve({
            path: join("/cache/root", request.file),
            bytes: entry.bytes,
            digestVerified: true,
            cached: entry.file !== "config.json",
          });
        },
        listFiles: () => files.map((entry) => entry.file),
      },
    );
    expect(result.cached).toBe(false);
    expect(result.path).toBe("/cache/root");
  });

  it("fails closed when an acquired file size differs from the manifest", async () => {
    await expect(
      acquireRepository(
        { backend: "mlx", repo: "o/r", revision: REVISION, files: manifest() },
        {
          acquire: (request) =>
            Promise.resolve({
              path: join("/cache/root", request.file),
              bytes: 999,
              digestVerified: true,
              cached: false,
            }),
          listFiles: () => manifest().map((entry) => entry.file),
        },
      ),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("fails closed on an unverified artifact", async () => {
    await expect(
      acquireRepository(
        { backend: "mlx", repo: "o/r", revision: REVISION, files: manifest() },
        {
          acquire: (request) =>
            Promise.resolve({
              path: join("/cache/root", request.file),
              bytes: manifest().find((entry) => entry.file === request.file)!.bytes,
              digestVerified: false,
              cached: false,
            }),
          listFiles: () => manifest().map((entry) => entry.file),
        },
      ),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("rejects an acquisition result path that does not match the requested file suffix", async () => {
    await expect(
      acquireRepository(
        { backend: "mlx", repo: "o/r", revision: REVISION, files: manifest() },
        {
          acquire: (request) => {
            const entry = manifest().find((candidate) => candidate.file === request.file)!;
            return Promise.resolve({
              path: join("/cache/root", request.file === "config.json" ? "unrelated.json" : request.file),
              bytes: entry.bytes,
              digestVerified: true,
              cached: true,
            });
          },
          listFiles: () => manifest().map((entry) => entry.file),
        },
      ),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("rejects missing, extra, or duplicate files in the completed repository", async () => {
    const acquire: AcquireRepositoryDeps["acquire"] = (request) => {
      const entry = manifest().find((candidate) => candidate.file === request.file)!;
      return Promise.resolve({
        path: join("/cache/root", request.file),
        bytes: entry.bytes,
        digestVerified: true,
        cached: true,
      });
    };
    for (const files of [
      ["config.json", "tokenizer_config.json"],
      [...manifest().map((entry) => entry.file), "rogue.py"],
      ["config.json", "config.json", "tokenizer_config.json", "weights/model.safetensors"],
    ]) {
      await expect(
        acquireRepository(
          { backend: "mlx", repo: "o/r", revision: REVISION, files: manifest() },
          { acquire, listFiles: () => files },
        ),
      ).rejects.toBeInstanceOf(BackendError);
    }
  });
});
