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
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
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
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const PROGRESS_INTERVAL_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_ALLOWED_HOSTS = ["huggingface.co", "hf.co"] as const;

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
  /** Expected SHA-256 digest; required for self-managed artifacts. */
  readonly sha256: string;
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
export type AcquireFetch = (
  url: string,
  signal?: AbortSignal | undefined,
) => Promise<FetchResponseLike>;

/**
 * The production {@link AcquireFetch}: native `fetch`, adapting the web response
 * body into a Node readable stream so the download path is stream-based (never
 * buffering a multi-gigabyte artifact fully into memory).
 */
export function createAcquireFetch(): AcquireFetch {
  return async (url: string, signal?: AbortSignal): Promise<FetchResponseLike> => {
    let current = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const safe = assertSafeFetchUrl(current, { allowedHosts: DOWNLOAD_ALLOWED_HOSTS });
      const response = await fetch(safe, {
        redirect: "manual",
        ...(signal !== undefined ? { signal } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null || redirects === MAX_REDIRECTS) {
          throw new BackendError(`unsafe or excessive redirect while downloading weights`);
        }
        current = new URL(location, safe).toString();
        continue;
      }
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
    }
    throw new BackendError(`weight download exceeded ${MAX_REDIRECTS} redirects`);
  };
}

/** Injectable side effects for {@link acquireWeight}. */
export interface AcquireDeps {
  readonly config?: Config | undefined;
  readonly fetch: AcquireFetch;
  readonly signal?: AbortSignal | undefined;
  /** Hard upper bound for streamed bytes; required from catalog sizing in production. */
  readonly maxBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onProgress?: ((completedBytes: number) => void) | undefined;
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
  if (deps.signal?.aborted) {
    throw new BackendError(`weight acquisition aborted for ${request.file}`);
  }

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
  ensureCacheDir(config.homeDir, cacheRoot, parentDir);
  removeAbandonedPartials(parentDir);
  const releaseLock = acquireArtifactLock(finalPath);
  try {

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
    discard(finalPath); // corrupt/mismatched cache entry — re-download (race-safe)
  }

  const url = assertSafeFetchUrl(
    buildHfResolveUrl(deps.baseUrl ?? DEFAULT_HF_BASE_URL, request.repo, request.revision, request.file),
    { allowedHosts: ["huggingface.co"] },
  ).toString();

  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  deps.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  let response: FetchResponseLike;
  try {
    response = await deps.fetch(url, controller.signal);
  } catch (cause) {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    throw new BackendError(`weight download failed for ${request.file}`, { cause });
  }
  if (!response.ok) {
    response.body?.destroy();
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    throw new BackendError(`weight download failed (HTTP ${response.status}) for ${request.file}`);
  }
  // The resolve URL already pins the exact 40-hex commit, so Hugging Face serves
  // that commit or 404s. `X-Repo-Commit` is a belt-and-braces confirmation: when
  // present it MUST equal the pinned revision; when absent (a mirror/proxy that
  // strips it) the pinned URL remains the anchor and the digest is the ultimate
  // integrity gate.
  const resolvedCommit = response.headers.get("x-repo-commit");
  if (resolvedCommit !== null && resolvedCommit.toLowerCase() !== request.revision.toLowerCase()) {
    response.body?.destroy();
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    throw new BackendError(
      `resolved commit ${resolvedCommit} does not match pinned revision ${request.revision}`,
    );
  }
  if (response.body === null) {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    throw new BackendError(`weight download returned no body for ${request.file}`);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (
    deps.maxBytes !== undefined &&
    Number.isFinite(declaredBytes) &&
    declaredBytes > deps.maxBytes
  ) {
    response.body?.destroy();
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    throw new BackendError(
      `weight download exceeds ${deps.maxBytes} byte limit for ${request.file}`,
    );
  }

  const tempPath = join(parentDir, `.${name}.${process.pid}.${randomUUID()}.part`);
  let bytes = 0;
  let lastProgress = 0;
  try {
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        if (deps.maxBytes !== undefined && bytes > deps.maxBytes) {
          callback(
            new BackendError(
              `weight download exceeds ${deps.maxBytes} byte limit for ${request.file}`,
            ),
          );
          return;
        }
        if (bytes - lastProgress >= PROGRESS_INTERVAL_BYTES) {
          lastProgress = bytes;
          deps.onProgress?.(bytes);
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      response.body,
      hasher,
      createWriteStream(tempPath, { mode: FILE_MODE, flags: "wx" }),
      { signal: controller.signal },
    );
    if (bytes !== lastProgress) deps.onProgress?.(bytes);
    chmodSync(tempPath, FILE_MODE);

    const digest = hash.digest("hex");
    if (digest !== request.sha256.toLowerCase()) {
      throw new BackendError(
        `digest mismatch for ${request.file}: expected ${request.sha256}, got ${digest}`,
      );
    }

    // A same-directory rename is atomic on POSIX; the temp file already lives
    // in the destination directory, so no cross-device copy can occur.
    renameSync(tempPath, finalPath);
    return { path: finalPath, bytes, digestVerified: true, cached: false };
  } catch (error) {
    discard(tempPath);
    if (error instanceof BackendError || error instanceof ValidationError) {
      throw error;
    }
    const winner = lstatSafe(finalPath)?.isFile()
      ? await tryCacheHit(finalPath, request.sha256)
      : null;
    if (winner !== null) return winner;
    throw new BackendError(`failed to acquire ${request.file}`, { cause: error });
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
  }
  } finally {
    releaseLock();
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
  if (!SHA256_RE.test(request.sha256)) {
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
function ensureCacheDir(homeDir: string, cacheRoot: string, parentDir: string): void {
  assertNoSymlinkComponents(homeDir, parentDir);
  mkdirSync(parentDir, { recursive: true, mode: DIR_MODE });
  assertNoSymlinkComponents(homeDir, parentDir);
  for (const component of pathComponents(cacheRoot, parentDir)) {
    chmodSync(component, DIR_MODE);
  }
  const homeReal = realpathSync(homeDir);
  const rootReal = realpathSync(cacheRoot);
  const parentReal = realpathSync(parentDir);
  if (!isWithin(homeReal, rootReal) || !isWithin(rootReal, parentReal)) {
    throw new BackendError(
      `refusing to use a cache path that resolves outside the cache root: ${parentDir}`,
    );
  }
}

function assertNoSymlinkComponents(homeDir: string, candidate: string): void {
  const home = lstatSafe(homeDir);
  if (home?.isSymbolicLink()) {
    throw new BackendError(`refusing symlinked local-llmup home: ${homeDir}`);
  }
  let current = homeDir;
  for (const segment of relative(homeDir, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (lstatSafe(current)?.isSymbolicLink()) {
      throw new BackendError(`refusing symlinked cache component: ${current}`);
    }
  }
}

function pathComponents(root: string, candidate: string): string[] {
  const components: string[] = [root];
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    components.push(current);
  }
  return components;
}

/** Return a cache-hit result when `finalPath` matches the expected digest. */
async function tryCacheHit(
  finalPath: string,
  expectedSha: string,
): Promise<AcquireResult | null> {
  const bytes = statSync(finalPath).size;
  const digest = await sha256File(finalPath);
  if (digest !== expectedSha.toLowerCase()) {
    return null;
  }
  chmodSync(finalPath, FILE_MODE);
  return { path: finalPath, bytes, digestVerified: true, cached: true };
}

/** Remove crash leftovers only when their recorded process no longer exists. */
function removeAbandonedPartials(parentDir: string): void {
  for (const name of readdirSync(parentDir)) {
    if (!name.endsWith(".part")) continue;
    const match = name.match(/\.(\d+)\.[^.]+\.part$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
    discard(join(parentDir, name));
  }
}

function acquireArtifactLock(finalPath: string): () => void {
  const lockPath = `${finalPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", FILE_MODE);
      writeSync(fd, String(process.pid));
      return () => {
        try {
          closeSync(fd);
        } finally {
          discard(lockPath);
        }
      };
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") {
        throw new BackendError(`failed to lock weight artifact: ${finalPath}`, { cause: error });
      }
      const ownerPid = Number(readFileSafe(lockPath));
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
        discard(lockPath);
        continue;
      }
      throw new BackendError(`weight acquisition already in progress: ${finalPath}`);
    }
  }
  throw new BackendError(`failed to reclaim stale weight lock: ${finalPath}`);
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
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
