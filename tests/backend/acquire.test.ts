import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { BackendError, ValidationError } from "../../src/errors.js";
import {
  acquireWeight,
  assertExactFileMatch,
  buildHfResolveUrl,
  createAcquireFetch,
  type AcquireDeps,
  type FetchResponseLike,
} from "../../src/backend/acquire.js";

const REV = "0123456789abcdef0123456789abcdef01234567";
const WEIGHTS = Buffer.from("GGUF fake weights payload");
const DIGEST = createHash("sha256").update(WEIGHTS).digest("hex");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-acquire-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function config() {
  return loadConfig({ LOCAL_LLMUP_HOME: home });
}

function okResponse(bytes: Buffer, commit: string | null = REV): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === "x-repo-commit" ? commit : null) },
    body: Readable.from([bytes]),
  };
}

function deps(response: FetchResponseLike, overrides: Partial<AcquireDeps> = {}): AcquireDeps {
  return {
    config: config(),
    fetch: vi.fn(async () => response),
    ...overrides,
  };
}

const request = {
  backend: "llamacpp" as const,
  repo: "owner/Repo-Name",
  revision: REV,
  file: "model-q4.gguf",
  sha256: DIGEST,
};

describe("buildHfResolveUrl", () => {
  it("pins the commit and encodes file segments", () => {
    const url = buildHfResolveUrl("https://huggingface.co", "owner/name", REV, "sub dir/x.gguf");
    expect(url).toBe(
      `https://huggingface.co/owner/name/resolve/${REV}/sub%20dir/x.gguf?download=true`,
    );
  });

  it("trims a trailing slash on the base", () => {
    const url = buildHfResolveUrl("https://huggingface.co/", "o/n", REV, "f.gguf");
    expect(url).toBe(`https://huggingface.co/o/n/resolve/${REV}/f.gguf?download=true`);
  });
});

describe("createAcquireFetch — redirect policy", () => {
  it("rejects a redirect to a private or non-allowlisted host before following it", async () => {
    let cancelled = false;
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          {
            status: 302,
            headers: { location: "https://169.254.169.254/weights.gguf" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchFn);

    await expect(
      createAcquireFetch()(`https://huggingface.co/o/r/resolve/${REV}/x.gguf`),
    ).rejects.toThrow(ValidationError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("follows a validated Hugging Face CDN redirect manually", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.hf.co/weights.gguf" },
        }),
      )
      .mockResolvedValueOnce(new Response(WEIGHTS, { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);

    const result = await createAcquireFetch()(`https://huggingface.co/o/r/resolve/${REV}/x.gguf`);

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("assertExactFileMatch", () => {
  it("returns the single exact match", () => {
    expect(assertExactFileMatch(["a.gguf", "model-q4.gguf"], "model-q4.gguf")).toBe(
      "model-q4.gguf",
    );
  });

  it("throws on zero match", () => {
    expect(() => assertExactFileMatch(["a.gguf"], "model-q4.gguf")).toThrow(BackendError);
  });

  it("throws on multi match", () => {
    expect(() => assertExactFileMatch(["dup.gguf", "dup.gguf"], "dup.gguf")).toThrow(BackendError);
  });
});

describe("acquireWeight — happy path", () => {
  it("downloads, verifies the digest, and atomically writes an owner-only file", async () => {
    const d = deps(okResponse(WEIGHTS));
    const result = await acquireWeight(request, d);

    const expectedPath = join(
      home,
      "cache",
      "llamacpp",
      "owner",
      `Repo-Name@${REV}`,
      "model-q4.gguf",
    );
    expect(result.path).toBe(expectedPath);
    expect(result.bytes).toBe(WEIGHTS.length);
    expect(result.digestVerified).toBe(true);
    expect(result.cached).toBe(false);

    // File is 0600, its directory is 0700, and no temp file is left behind.
    expect(statSync(expectedPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(expectedPath)).mode & 0o777).toBe(0o700);
    const siblings = statSync(dirname(expectedPath));
    expect(siblings.isDirectory()).toBe(true);
    expect(lstatSync(expectedPath).isSymbolicLink()).toBe(false);
  });

  it("rejects a self-managed acquisition without an expected digest", async () => {
    const { sha256: _omit, ...noDigest } = request;
    await expect(acquireWeight(noDigest, deps(okResponse(WEIGHTS)))).rejects.toThrow(
      ValidationError,
    );
  });

  it("tolerates an absent X-Repo-Commit header (URL pins the commit)", async () => {
    const result = await acquireWeight(request, deps(okResponse(WEIGHTS, null)));
    expect(result.digestVerified).toBe(true);
    expect(statSync(result.path).isFile()).toBe(true);
  });

  it("passes the constructed URL through the SSRF guard (host allow-listed)", async () => {
    const fetchFn = vi.fn(async () => okResponse(WEIGHTS));
    await acquireWeight(request, { config: config(), fetch: fetchFn });
    const called = fetchFn.mock.calls[0]?.[0] as string;
    expect(called).toBe(
      `https://huggingface.co/owner/Repo-Name/resolve/${REV}/model-q4.gguf?download=true`,
    );
  });
});

describe("acquireWeight — cache hit", () => {
  it("returns the existing verified file without fetching again", async () => {
    const fetchFn = vi.fn(async () => okResponse(WEIGHTS));
    const d: AcquireDeps = { config: config(), fetch: fetchFn };
    await acquireWeight(request, d);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const second = await acquireWeight(request, d);
    expect(second.cached).toBe(true);
    expect(second.digestVerified).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1); // not re-fetched
  });

  it("re-downloads when the cached file is corrupt (digest no longer matches)", async () => {
    const finalPath = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`, "model-q4.gguf");
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(finalPath, Buffer.from("corrupted bytes")); // wrong content on disk

    const fetchFn = vi.fn(async () => okResponse(WEIGHTS));
    const result = await acquireWeight(request, { config: config(), fetch: fetchFn });
    expect(result.cached).toBe(false);
    expect(result.digestVerified).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("normalizes a verified cache hit back to owner-only mode", async () => {
    const finalPath = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`, "model-q4.gguf");
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(finalPath, WEIGHTS);
    chmodSync(finalPath, 0o666);

    const result = await acquireWeight(request, deps(okResponse(WEIGHTS)));

    expect(result.cached).toBe(true);
    expect(statSync(finalPath).mode & 0o777).toBe(0o600);
  });
});

describe("acquireWeight — artifact locking", () => {
  it("refuses a concurrent acquisition of the same artifact", async () => {
    let releaseFetch: ((response: FetchResponseLike) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<FetchResponseLike>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchFn = vi.fn(() => {
      markStarted?.();
      return pending;
    });
    const first = acquireWeight(request, { config: config(), fetch: fetchFn });
    await started;

    await expect(
      acquireWeight(request, { config: config(), fetch: vi.fn(async () => okResponse(WEIGHTS)) }),
    ).rejects.toThrow(/already in progress/);

    releaseFetch?.(okResponse(WEIGHTS));
    await expect(first).resolves.toMatchObject({ digestVerified: true });
  });

  it("reclaims an artifact lock owned by a dead process", async () => {
    const dir = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${request.file}.lock`), "99999999");

    await expect(acquireWeight(request, deps(okResponse(WEIGHTS)))).resolves.toMatchObject({
      digestVerified: true,
    });
  });
});

describe("acquireWeight — fail closed", () => {
  it("discards the partial and never promotes on a digest mismatch", async () => {
    const bad = { ...request, sha256: "f".repeat(64) };
    await expect(acquireWeight(bad, deps(okResponse(WEIGHTS)))).rejects.toThrow(BackendError);

    const dir = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`);
    const finalPath = join(dir, "model-q4.gguf");
    expect(() => statSync(finalPath)).toThrow(); // not promoted
    // The partial must be discarded — no leftover *.part temp files remain.
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("fails closed when the resolved commit differs from the pinned revision", async () => {
    const wrongCommit = okResponse(WEIGHTS, "ffffffffffffffffffffffffffffffffffffffff");
    await expect(acquireWeight(request, deps(wrongCommit))).rejects.toThrow(BackendError);
    const finalPath = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`, "model-q4.gguf");
    expect(() => statSync(finalPath)).toThrow();
  });

  it("rejects a non-ok HTTP response", async () => {
    const notFound: FetchResponseLike = {
      ok: false,
      status: 404,
      headers: { get: () => null },
      body: null,
    };
    await expect(acquireWeight(request, deps(notFound))).rejects.toThrow(BackendError);
  });

  it("aborts before fetch when the caller signal is already aborted", async () => {
    const fetchFn = vi.fn(async () => okResponse(WEIGHTS));
    await expect(
      acquireWeight(request, {
        config: config(),
        fetch: fetchFn,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(BackendError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts a stalled fetch at the configured timeout", async () => {
    const fetchFn = vi.fn(
      (_url: string, signal?: AbortSignal): Promise<FetchResponseLike> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );

    await expect(
      acquireWeight(request, { config: config(), fetch: fetchFn, timeoutMs: 1 }),
    ).rejects.toThrow(BackendError);
    expect(fetchFn.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("rejects a response that exceeds the configured byte ceiling and discards it", async () => {
    const dir = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`);
    await expect(
      acquireWeight(request, deps(okResponse(WEIGHTS), { maxBytes: WEIGHTS.length - 1 })),
    ).rejects.toThrow(BackendError);
    expect(readdirSync(dir).filter((file) => file.endsWith(".part"))).toEqual([]);
    expect(() => statSync(join(dir, request.file))).toThrow();
  });

  it("emits bounded byte progress while streaming", async () => {
    const progress = vi.fn();
    const result = await acquireWeight(
      request,
      deps(okResponse(WEIGHTS), { onProgress: progress }),
    );
    expect(result.bytes).toBe(WEIGHTS.length);
    expect(progress).toHaveBeenLastCalledWith(WEIGHTS.length);
  });

  it("reclaims an abandoned partial owned by a dead process before downloading", async () => {
    const dir = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, ".Repo-Name.99999999.deadbeef.part");
    writeFileSync(stale, Buffer.alloc(4));

    await acquireWeight(request, deps(okResponse(WEIGHTS)));

    expect(() => statSync(stale)).toThrow();
  });

  it("rejects a non-HTTPS / private-host base URL via the SSRF guard", async () => {
    const d = deps(okResponse(WEIGHTS), { baseUrl: "http://169.254.169.254" });
    await expect(acquireWeight(request, d)).rejects.toThrow(ValidationError);
  });

  it("rejects a non-allow-listed base host", async () => {
    const d = deps(okResponse(WEIGHTS), { baseUrl: "https://evil.example.com" });
    await expect(acquireWeight(request, d)).rejects.toThrow(ValidationError);
  });

  it("rejects a cache component that resolves outside the cache root (symlink)", async () => {
    const backendDir = join(home, "cache", "llamacpp");
    mkdirSync(backendDir, { recursive: true });
    const external = mkdtempSync(join(tmpdir(), "llmup-evil-"));
    symlinkSync(external, join(backendDir, "owner")); // owner -> outside the cache root
    try {
      await expect(acquireWeight(request, deps(okResponse(WEIGHTS)))).rejects.toThrow(BackendError);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("rejects a cache root symlink that escapes the configured home", async () => {
    const external = mkdtempSync(join(tmpdir(), "llmup-cache-root-"));
    mkdirSync(home, { recursive: true });
    symlinkSync(external, join(home, "cache"));
    try {
      await expect(acquireWeight(request, deps(okResponse(WEIGHTS)))).rejects.toThrow(BackendError);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("refuses a symlink sitting at the final artifact path", async () => {
    const repoDir = join(home, "cache", "llamacpp", "owner", `Repo-Name@${REV}`);
    mkdirSync(repoDir, { recursive: true });
    const external = mkdtempSync(join(tmpdir(), "llmup-target-"));
    const victim = join(external, "victim");
    writeFileSync(victim, Buffer.from("do not clobber"));
    symlinkSync(victim, join(repoDir, "model-q4.gguf")); // final path is a symlink
    try {
      await expect(acquireWeight(request, deps(okResponse(WEIGHTS)))).rejects.toThrow(BackendError);
      expect(statSync(victim).size).toBe("do not clobber".length); // untouched
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("rejects an invalid revision (not a 40-hex SHA)", async () => {
    const bad = { ...request, revision: "main" };
    await expect(acquireWeight(bad, deps(okResponse(WEIGHTS)))).rejects.toThrow(ValidationError);
  });

  it("rejects a traversal in the file path", async () => {
    const bad = { ...request, file: "../escape.gguf" };
    await expect(acquireWeight(bad, deps(okResponse(WEIGHTS)))).rejects.toThrow(ValidationError);
  });

  it("rejects an invalid repo id", async () => {
    const bad = { ...request, repo: "../secret" };
    await expect(acquireWeight(bad, deps(okResponse(WEIGHTS)))).rejects.toThrow(ValidationError);
  });
});
