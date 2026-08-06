/**
 * Self-managed weight acquisition (spec §2.8 M2): the shared, guarded path that
 * downloads a single model artifact directly from a **pinned Hugging Face
 * commit** for the backends that manage their own weights (llama.cpp GGUF, MLX).
 * Ollama is exempt — it pulls through its own daemon.
 *
 * Every download is fail-closed and defence-in-depth:
 *
 *  - the resolve URL is built from a validated `owner/name` repo + 40-hex commit
 *    SHA + a traversal-checked file, then passed through {@link assertSafeFetchUrl}
 *    (HTTPS-only, HF host allow-list, no credentials, no private/loopback host);
 *  - bytes stream to a `0600` temp file inside a `0700` per-repo cache directory
 *    under `homeDir`, hashing as they arrive;
 *  - the response's resolved commit (`X-Repo-Commit`) must equal the pinned
 *    revision, and — when the caller supplies one — the SHA-256 digest must match;
 *  - only after verification is the temp file **atomically renamed** into place
 *    (mirrors `writeState`); any failure discards the partial and never promotes;
 *  - cache paths that resolve (via a symlink) outside the cache root are refused,
 *    and a partial is never served.
 *
 * A missing expected digest yields `digestVerified: false` (surfaced honestly,
 * never a fabricated pass — honesty gate); the caller decides its policy.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DIR_MODE, FILE_MODE, loadConfig, type Config } from "../config.js";
import { BackendError, ValidationError } from "../errors.js";
import { assertSafeFetchUrl } from "./net.js";
import type { BackendName } from "../types.js";

/** Default Hugging Face origin the resolve URL is built against. */
const DEFAULT_HF_BASE_URL = "https://huggingface.co";

/** Hugging Face repo id: exactly one `owner/name`, each segment alphanumeric-led. */
const HF_REPO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** A pinned git commit SHA — 40 hex, never a floating tag/branch. */
const REVISION_RE = /^[0-9a-f]{40}$/i;
/** A lowercase-or-upper hex SHA-256 digest (exactly 64 hex chars). */
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** A single artifact to acquire, resolved from a catalog `gguf`/`mlx` source. */
export interface AcquireRequest {
  /** Owning backend — namespaces the on-disk cache. */
  readonly backend: BackendName;
  /** Hugging Face `owner/name` repo id. */
  readonly repo: string;
  /** Full 40-hex commit SHA to pin (never a floating tag). */
  readonly revision: string;
  /** Exact repo-relative filename (no globs, `..`, or absolute paths). */
  readonly file: string;
  /** Expected SHA-256 digest; when absent, integrity is reported unverified. */
  readonly sha256?: string | undefined;
}

/** Outcome of a successful {@link acquireWeight}. */
export interface AcquireResult {
  /** Absolute path to the verified, cached artifact. */
  readonly path: string;
  /** Size of the artifact in bytes. */
  readonly bytes: number;
  /** Whether the artifact was checked against an expected digest (honesty gate). */
  readonly digestVerified: boolean;
  /** True when served from an already-cached, digest-matching file (no download). */
  readonly cached: boolean;
}

/** Minimal HTTP response surface consumed by {@link acquireWeight}; injected in tests. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** Response body as a Node readable stream, or `null` when there is no body. */
  readonly body: Readable | null;
}

/** Perform an HTTP GET, returning a streaming body; injected in tests. */
export type AcquireFetch = (url: string) => Promise<FetchResponseLike>;

/**
 * The production {@link AcquireFetch}: native `fetch`, adapting the web response
 * body into a Node readable stream so the download path is stream-based (never
 * buffering a multi-gigabyte artifact fully into memory).
 */
export function createAcquireFetch(): AcquireFetch {
  return async (url: string): Promise<FetchResponseLike> => {
    // Redirects are followed because Hugging Face resolve URLs hand off to a CDN
    // host. The trust anchor is not the transport but the content: the pinned
    // commit and the SHA-256 digest are verified after download, so a redirect
    // cannot promote bytes that do not match the expected digest, and no
    // credentials are ever attached to leak across a hop.
    const response = await fetch(url, { redirect: "follow" });
    const webBody = response.body;
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: (name: string): string | null => response.headers.get(name) },
      body:
        webBody !== null
          ? Readable.fromWeb(webBody as Parameters<typeof Readable.fromWeb>[0])
          : null,
    };
  };
}

/** Injectable side effects for {@link acquireWeight}. */
export interface AcquireDeps {
  readonly config?: Config | undefined;
  readonly fetch: AcquireFetch;
  /** Origin to build the resolve URL against; defaults to Hugging Face. */
  readonly baseUrl?: string | undefined;
}

/**
 * Build a pinned Hugging Face resolve URL. The `file` is path-segment encoded so
 * a space or unicode character cannot corrupt the URL; the repo and revision are
 * validated by the caller before they reach here.
 */
export function buildHfResolveUrl(
  baseUrl: string,
  repo: string,
  revision: string,
  file: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const encodedFile = file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${repo}/resolve/${revision}/${encodedFile}?download=true`;
}

/**
 * Return the single member of `available` equal to `requested`. Throws
 * {@link BackendError} on zero matches or more than one (a poisoned listing with
 * duplicate filenames) — the exact-artifact guard (spec §2.8 H3).
 */
export function assertExactFileMatch(available: readonly string[], requested: string): string {
  const matches = available.filter((candidate) => candidate === requested);
  if (matches.length === 0) {
    throw new BackendError(`weight file not found in repo listing: ${requested}`);
  }
  if (matches.length > 1) {
    throw new BackendError(
      `ambiguous weight file: ${matches.length} entries match ${requested}`,
    );
  }
  return matches[0] as string;
}

/**
 * Acquire one pinned artifact into the local cache, fail-closed. See the module
 * header for the full guarantee. Throws {@link ValidationError} for malformed
 * input or an unsafe URL, and {@link BackendError} for a failed download,
 * commit/digest mismatch, or a cache path that escapes the cache root.
 */
export async function acquireWeight(
  request: AcquireRequest,
  deps: AcquireDeps,
): Promise<AcquireResult> {
  const config = deps.config ?? loadConfig();
  assertValidRequest(request);

  const cacheRoot = join(config.homeDir, "cache");
  const [owner, name] = request.repo.split("/") as [string, string];
  const repoDir = join(cacheRoot, request.backend, owner, `${name}@${request.revision}`);
  const finalPath = join(repoDir, request.file);

  // Defence in depth: the composed path must stay inside its own repo dir even
  // though `file` was already traversal-checked.
  if (!isWithin(repoDir, finalPath)) {
    throw new BackendError(`refusing to write weight outside its cache directory: ${request.file}`);
  }

  const parentDir = dirname(finalPath);
  ensureCacheDir(cacheRoot, parentDir);

  // A pre-existing symlink at the target is a promotion/traversal vector.
  const existing = lstatSafe(finalPath);
  if (existing?.isSymbolicLink()) {
    throw new BackendError(`refusing to use symlinked cache entry: ${finalPath}`);
  }
  if (existing?.isFile()) {
    const hit = await tryCacheHit(finalPath, request.sha256);
    if (hit !== null) {
      return hit;
    }
    unlinkSync(finalPath); // corrupt/mismatched cache entry — re-download
  }

  const url = assertSafeFetchUrl(
    buildHfResolveUrl(deps.baseUrl ?? DEFAULT_HF_BASE_URL, request.repo, request.revision, request.file),
    { allowedHosts: ["huggingface.co"] },
  ).toString();

  const response = await deps.fetch(url);
  if (!response.ok) {
    throw new BackendError(`weight download failed (HTTP ${response.status}) for ${request.file}`);
  }
  // The resolve URL already pins the exact 40-hex commit, so Hugging Face serves
  // that commit or 404s. `X-Repo-Commit` is a belt-and-braces confirmation: when
  // present it MUST equal the pinned revision; when absent (a mirror/proxy that
  // strips it) the pinned URL remains the anchor and the digest is the ultimate
  // integrity gate.
  const resolvedCommit = response.headers.get("x-repo-commit");
  if (resolvedCommit !== null && resolvedCommit.toLowerCase() !== request.revision.toLowerCase()) {
    throw new BackendError(
      `resolved commit ${resolvedCommit} does not match pinned revision ${request.revision}`,
    );
  }
  if (response.body === null) {
    throw new BackendError(`weight download returned no body for ${request.file}`);
  }

  const tempPath = join(parentDir, `.${name}.${process.pid}.${randomUUID()}.part`);
  let bytes = 0;
  try {
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(response.body, hasher, createWriteStream(tempPath, { mode: FILE_MODE, flags: "wx" }));
    chmodSync(tempPath, FILE_MODE);

    const digest = hash.digest("hex");
    const digestVerified = request.sha256 !== undefined;
    if (digestVerified && digest !== request.sha256!.toLowerCase()) {
      throw new BackendError(
        `digest mismatch for ${request.file}: expected ${request.sha256}, got ${digest}`,
      );
    }

    // A same-directory rename is atomic on POSIX; the temp file already lives
    // in the destination directory, so no cross-device copy can occur.
    renameSync(tempPath, finalPath);
    return { path: finalPath, bytes, digestVerified, cached: false };
  } catch (error) {
    discard(tempPath);
    if (error instanceof BackendError || error instanceof ValidationError) {
      throw error;
    }
    throw new BackendError(`failed to acquire ${request.file}`, { cause: error });
  }
}

function assertValidRequest(request: AcquireRequest): void {
  if (!HF_REPO_ID_RE.test(request.repo)) {
    throw new ValidationError(`unsafe repo id: ${request.repo}`);
  }
  if (!REVISION_RE.test(request.revision)) {
    throw new ValidationError(`revision must be a 40-hex commit SHA: ${request.revision}`);
  }
  if (!isSafeRepoRelativePath(request.file)) {
    throw new ValidationError(
      `unsafe weight file path (no globs, \`..\`, or absolute paths): ${request.file}`,
    );
  }
  if (request.sha256 !== undefined && !SHA256_RE.test(request.sha256)) {
    throw new ValidationError(`expected sha256 must be 64 hex chars: ${request.sha256}`);
  }
}

/**
 * True when `f` is a safe repo-relative path: non-empty, no glob metacharacters,
 * no backslashes or percent-encoding, no control characters, not absolute, and
 * no `.`/`..` segments (blocks traversal when composing the local cache path).
 * Mirrors the catalog schema's `isSafeModelFile`.
 */
function isSafeRepoRelativePath(f: string): boolean {
  if (f.length === 0) return false;
  if (/[*?[\]{}]/.test(f)) return false;
  if (f.includes("\\")) return false;
  if (f.includes("%")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(f)) return false;
  if (f.startsWith("/")) return false;
  return f.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** Create `parentDir` (0700) and assert it resolves inside the cache root. */
function ensureCacheDir(cacheRoot: string, parentDir: string): void {
  mkdirSync(parentDir, { recursive: true, mode: DIR_MODE });
  chmodSync(parentDir, DIR_MODE);
  const rootReal = realpathSync(cacheRoot);
  const parentReal = realpathSync(parentDir);
  if (!isWithin(rootReal, parentReal)) {
    throw new BackendError(
      `refusing to use a cache path that resolves outside the cache root: ${parentDir}`,
    );
  }
}

/** Return a cache-hit result when `finalPath` matches the expected digest. */
async function tryCacheHit(
  finalPath: string,
  expectedSha: string | undefined,
): Promise<AcquireResult | null> {
  const bytes = statSync(finalPath).size;
  if (expectedSha === undefined) {
    return { path: finalPath, bytes, digestVerified: false, cached: true };
  }
  const digest = await sha256File(finalPath);
  if (digest !== expectedSha.toLowerCase()) {
    return null;
  }
  return { path: finalPath, bytes, digestVerified: true, cached: true };
}

function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function discard(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch {
    // Best-effort: the partial may never have been created.
  }
}
