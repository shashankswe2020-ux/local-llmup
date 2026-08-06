/**
 * Ollama backend adapter. v1 wraps the `ollama` CLI/daemon: models are pulled
 * with `spawn(..., { shell: false })` (every argument a discrete array element,
 * plus an explicit `--` end-of-options separator) and their integrity is
 * verified against the catalog's recorded SHA-256 digest.
 *
 * This task (T15) implements `pull`, `isInstalled`, and `installHint`; serve,
 * health, lifecycle, chat, and embedding land in later tasks.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import { BackendError, ValidationError } from "../errors.js";
import {
  buildEndpoint,
  DEFAULT_BIND_HOST,
  DEFAULT_OLLAMA_PORT,
  type BackendAdapter,
  type ChatRequest,
  type ChatResult,
  type EmbedRequest,
  type EmbedResult,
  type PullOptions,
  type PullProgress,
  type PullResult,
  type ReadinessOptions,
  type ServeHandle,
  type ServeOptions,
} from "./adapter.js";
import { assertSafeModelId } from "./net.js";
import type { BackendCapabilities } from "../types.js";

/** Default binary name resolved from `PATH`. */
const OLLAMA_BINARY = "ollama";

const MODEL_LAYER_MEDIA_TYPE = "application/vnd.ollama.image.model";

/** A lowercase-hex SHA-256 digest (exactly 64 hex chars). */
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Cap on the unflushed line buffer, bounding memory for newline-less output. */
const MAX_LINE_BUFFER_BYTES = 64 * 1024;

/**
 * Lower bound, as a fraction of the catalog's approximate on-disk size, that a
 * downloaded model must reach in the size-only fallback. The catalog `diskBytes`
 * is a rough estimate — real Ollama pulls routinely differ by a wide margin and
 * are often *larger* than the estimate — so an exact match is meaningless. The
 * fallback is a plausibility guard against truncated/empty downloads, not a
 * byte-exact check; the digest path (when a catalog digest exists) remains the
 * strict integrity guarantee.
 */
const MIN_PULL_SIZE_RATIO = 0.5;

/** Minimal readable-stream surface consumed from a spawned process. */
export interface ProcessOutputStream {
  onData(listener: (chunk: string) => void): void;
}

/** Minimal child-process surface the adapter depends on (a testability seam). */
export interface SpawnedProcess {
  /** OS process id, or undefined when the spawn did not yield one. */
  readonly pid: number | undefined;
  readonly stdout: ProcessOutputStream | null;
  readonly stderr: ProcessOutputStream | null;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  /** Send a termination signal (default SIGTERM) to this child. */
  kill(signal?: NodeJS.Signals): void;
}

/** Spawn a child process with `shell: false`; injected in tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
) => SpawnedProcess;

/** Send a signal to a process by pid (used to stop an owned daemon); injected in tests. */
export type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => void;


/** Integrity facts about a freshly pulled model, as observed on disk. */
export interface PullVerification {
  /** Lowercase hex SHA-256 of the weights, or undefined if unobtainable. */
  readonly sha256?: string | undefined;
  /** On-disk size of the weights in bytes, or undefined if unobtainable. */
  readonly sizeBytes?: number | undefined;
}

/** Probe the backend store for the integrity facts of a pulled model. */
export type DigestProbe = (modelId: string) => Promise<PullVerification>;

/** Minimal HTTP response surface used by the readiness probe. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json?(): Promise<unknown>;
}

/** Perform an HTTP GET; injected in tests. */
export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal | undefined },
) => Promise<FetchResponseLike>;

/** Sleep for `ms`, rejecting if `signal` aborts; injected in tests. */
export type SleepFn = (ms: number, signal?: AbortSignal | undefined) => Promise<void>;

/** Readiness paths probed in order: OpenAI-compatible first, native fallback. */
const READINESS_PATHS = ["/v1/models", "/api/tags"] as const;
const OPENAI_READINESS_PATHS = ["/v1/models"] as const;

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_RETRIES = 20;
const READINESS_BACKOFF_BASE_MS = 100;
const READINESS_BACKOFF_MAX_MS = 2_000;
/** Upper bound on a single readiness request, so one hung probe can't outlive the deadline. */
const READINESS_REQUEST_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 500;
const SHUTDOWN_POLL_INTERVAL_MS = 50;
const SHUTDOWN_POLL_ATTEMPTS = 10;

/** Non-sensitive parent env keys that are safe/useful to preserve for `ollama serve`. */
const SERVE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

/** Build a minimal child env: explicit host bind plus selected safe parent keys. */
function buildServeEnv(host: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { OLLAMA_HOST: `${host}:${port}` };
  for (const key of SERVE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Exponential backoff (capped) for the Nth readiness attempt (1-based). */
function readinessBackoffMs(attempt: number): number {
  return Math.min(READINESS_BACKOFF_BASE_MS * 2 ** (attempt - 1), READINESS_BACKOFF_MAX_MS);
}

const defaultFetch: FetchFn = (url, init) => fetch(url, { signal: init?.signal ?? null });

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BackendError("readiness wait aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BackendError("readiness wait aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Outcome of one readiness attempt across all probe paths. */
type ProbeResult = { readonly ready: true } | { readonly ready: false; readonly lastError: unknown };

/** Attach probe classification used by `serve` attach-vs-spawn decision. */
type AttachProbeResult = "trusted" | "untrusted" | "unreachable";

/** Minimal shape check for Ollama's `/api/version` payload. */
function isLikelyOllamaVersionPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0;
}

function adaptStream(stream: Readable | null): ProcessOutputStream | null {
  if (stream === null) return null;
  stream.setEncoding("utf8");
  return {
    onData: (listener) => {
      stream.on("data", (chunk: string) => listener(chunk));
    },
  };
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    signal: options.signal,
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    pid: child.pid,
    stdout: adaptStream(child.stdout),
    stderr: adaptStream(child.stderr),
    onClose: (listener) => {
      child.on("close", (code) => listener(code));
    },
    onError: (listener) => {
      child.on("error", (error) => listener(error));
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
};

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

/**
 * Whether `host` is a loopback bind address. A non-loopback bind exposes the
 * unauthenticated server beyond the local machine, so it requires opt-in. This
 * is a lexical check on the bind address, not a DNS resolution.
 */
function isLoopbackBindHost(host: string): boolean {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = unbracketed.toLowerCase();
  return lower === "localhost" || lower === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

/**
 * A pid we can safely signal: a positive integer. Zero or negative pids address
 * process *groups* (`kill(0)` → the caller's group), so they must never reach
 * `process.kill`.
 */
function isUsablePid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 0;
}

/** Wait for a spawned child to emit `close`, or time out. */
function waitForChildClose(child: SpawnedProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    child.onClose(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Best-effort spawned-child teardown: TERM, then KILL if it does not exit. */
async function stopSpawnedChild(child: SpawnedProcess): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  if (await waitForChildClose(child, SHUTDOWN_GRACE_MS)) return;

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }

  await waitForChildClose(child, SHUTDOWN_GRACE_MS);
}


/** Turn a raw output line into a progress event. */
function toProgress(line: string): PullProgress {
  return { status: line };
}

/** Split streamed chunks into trimmed lines, treating `\r` and `\n` as breaks. */
function lineConsumer(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
    // Bound memory if a (possibly hostile) stream never emits a newline.
    if (buffer.length > MAX_LINE_BUFFER_BYTES) {
      buffer = buffer.slice(buffer.length - MAX_LINE_BUFFER_BYTES);
    }
  };
}

function wrapSpawnError(binary: string, error: Error): BackendError {
  const code = (error as { code?: unknown }).code;
  if (error.name === "AbortError" || code === "ABORT_ERR") {
    return new BackendError(`${binary} was aborted`, { cause: error });
  }
  if (code === "ENOENT") {
    return new BackendError(`${binary} not found on PATH`, { cause: error });
  }
  return new BackendError(`failed to run ${binary}: ${error.message}`, { cause: error });
}

interface RunProcessOptions {
  readonly onLine?: ((line: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Run a process to completion, returning its exit code. */
function runProcess(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      child = spawn(binary, args, { signal: options.signal });
    } catch (error) {
      reject(wrapSpawnError(binary, error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (options.onLine) {
      const consume = lineConsumer(options.onLine);
      child.stdout?.onData(consume);
      child.stderr?.onData(lineConsumer(options.onLine));
    }
    child.onError((error) => reject(wrapSpawnError(binary, error)));
    child.onClose((code) => resolve(code ?? -1));
  });
}

/** True for a single path segment that cannot escape its parent directory. */
function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
  );
}

/** True when `target` resolves inside `base` (belt-and-suspenders traversal guard). */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel.length > 0 && !rel.startsWith("..");
}

/**
 * Parse `name`, `namespace/name`, or `registry/namespace/name` (with `:tag`) into
 * a manifest path. Returns `undefined` if any segment is unsafe or the resulting
 * path would escape `<modelsDir>/manifests` — the model id is untrusted here.
 */
function resolveManifestPath(modelsDir: string, modelId: string): string | undefined {
  let registry = "registry.ollama.ai";
  let namespace = "library";
  let remainder = modelId;

  const segments = modelId.split("/");
  if (segments.length === 3) {
    [registry, namespace, remainder] = segments as [string, string, string];
  } else if (segments.length === 2) {
    [namespace, remainder] = segments as [string, string];
  }

  const colon = remainder.lastIndexOf(":");
  const name = colon === -1 ? remainder : remainder.slice(0, colon);
  const tag = colon === -1 ? "latest" : remainder.slice(colon + 1);

  if (![registry, namespace, name, tag].every(isSafePathSegment)) return undefined;

  const manifestsRoot = join(modelsDir, "manifests");
  const path = join(manifestsRoot, registry, namespace, name, tag);
  return isWithin(manifestsRoot, path) ? path : undefined;
}

interface ModelLayer {
  readonly hex: string;
}

/** Extract the (validated) weights-layer digest from a parsed manifest, if present. */
function findModelLayer(parsed: unknown): ModelLayer | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const layers = (parsed as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return undefined;

  for (const layer of layers) {
    if (typeof layer !== "object" || layer === null) continue;
    const entry = layer as { mediaType?: unknown; digest?: unknown };
    if (entry.mediaType !== MODEL_LAYER_MEDIA_TYPE) continue;
    if (typeof entry.digest !== "string") continue;
    if (!entry.digest.startsWith("sha256:")) continue;
    const hex = entry.digest.slice("sha256:".length);
    // The digest is interpolated into a blob path — reject anything but 64 hex.
    if (!SHA256_HEX.test(hex)) continue;
    return { hex };
  }
  return undefined;
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

/** Options for the default filesystem-backed digest probe. */
export interface DefaultDigestProbeOptions {
  readonly modelsDir?: string | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
  readonly hashFile?: ((path: string) => Promise<string>) | undefined;
  readonly statFile?: ((path: string) => Promise<{ size: number }>) | undefined;
}

/**
 * Build the default {@link DigestProbe} that reads Ollama's content-addressed
 * store: it resolves the model's manifest, locates the weights layer, hashes the
 * referenced blob, and reports its size. Any missing manifest/layer/blob yields
 * an empty result (treated as "digest unavailable" by the caller).
 */
export function createDefaultDigestProbe(options: DefaultDigestProbeOptions = {}): DigestProbe {
  const modelsDir =
    options.modelsDir ?? process.env["OLLAMA_MODELS"] ?? join(homedir(), ".ollama", "models");
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const hashFile = options.hashFile ?? sha256File;
  const statFile = options.statFile ?? (async (path: string) => ({ size: (await fsStat(path)).size }));

  return async (modelId: string): Promise<PullVerification> => {
    const manifestPath = resolveManifestPath(modelsDir, modelId);
    if (manifestPath === undefined) return {};

    let raw: string;
    try {
      raw = await readFile(manifestPath);
    } catch {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }

    const layer = findModelLayer(parsed);
    if (layer === undefined) return {};

    // `layer.hex` is validated as 64 hex chars, so it cannot traverse.
    const blobPath = join(modelsDir, "blobs", `sha256-${layer.hex}`);

    let sha256: string | undefined;
    try {
      sha256 = await hashFile(blobPath);
    } catch {
      sha256 = undefined;
    }

    // Only trust an actually-measured on-disk size; never the (untrusted)
    // manifest-declared size, which an attacker could forge to match.
    let sizeBytes: number | undefined;
    try {
      sizeBytes = (await statFile(blobPath)).size;
    } catch {
      sizeBytes = undefined;
    }

    return { sha256, sizeBytes };
  };
}

/** Options for constructing an {@link OllamaAdapter}. */
export interface OllamaAdapterOptions {
  readonly spawn?: SpawnFn | undefined;
  readonly probe?: DigestProbe | undefined;
  readonly binary?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly fetch?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly kill?: KillFn | undefined;
}

/** Stateless adapter over the Ollama backend. */
export class OllamaAdapter implements BackendAdapter {
  readonly name = "ollama";
  readonly capabilities: BackendCapabilities = {
    canPull: true,
    canEmbed: true,
    openAiCompatible: true,
    formats: ["ollama"],
    defaultPort: DEFAULT_OLLAMA_PORT,
  };
  private readonly spawn: SpawnFn;
  private readonly probe: DigestProbe;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;
  private readonly kill: KillFn;

  constructor(options: OllamaAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.probe = options.probe ?? createDefaultDigestProbe();
    this.binary = options.binary ?? OLLAMA_BINARY;
    this.platform = options.platform ?? process.platform;
    this.fetch = options.fetch ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.kill = options.kill ?? defaultKill;
  }

  async isInstalled(): Promise<boolean> {
    try {
      const code = await runProcess(this.spawn, this.binary, ["--version"]);
      return code === 0;
    } catch {
      return false;
    }
  }

  installHint(): string {
    switch (this.platform) {
      case "darwin":
        return "brew install ollama";
      case "linux":
        return "curl -fsSL https://ollama.com/install.sh | sh";
      case "win32":
        return "winget install Ollama.Ollama";
      default:
        return "Install Ollama from https://ollama.com/download";
    }
  }

  async pull(options: PullOptions): Promise<PullResult> {
    // Defence in depth: validate before spawning, keep every argument discrete,
    // and add `--` so a hypothetical leading-dash id cannot become an option.
    assertSafeModelId(options.modelId);

    const onProgress = options.onProgress;
    const code = await runProcess(this.spawn, this.binary, ["pull", "--", options.modelId], {
      onLine: onProgress ? (line) => onProgress(toProgress(line)) : undefined,
      signal: options.signal,
    });

    if (code !== 0) {
      throw new BackendError(`ollama pull failed for ${options.modelId} (exit code ${code})`);
    }

    return this.verifyPull(options);
  }

  private async verifyPull(options: PullOptions): Promise<PullResult> {
    const { sha256, sizeBytes } = await this.probe(options.modelId);
    const expected = options.expectedSha256?.trim().toLowerCase();
    const actual = sha256?.trim().toLowerCase();

    // A catalog digest makes verification mandatory: if we could not compute the
    // downloaded weights' digest, fail closed rather than silently downgrading.
    if (expected !== undefined && expected.length > 0) {
      if (actual === undefined || actual.length === 0) {
        throw new BackendError(
          `cannot verify ${options.modelId}: expected digest ${expected} but no digest was produced for the downloaded weights`,
        );
      }
      if (actual !== expected) {
        throw new BackendError(
          `digest mismatch for ${options.modelId}: expected ${expected}, downloaded ${actual}`,
        );
      }
      return { modelId: options.modelId, digestVerified: true };
    }

    // No catalog digest recorded → size-only fallback. Never fail open: require a
    // measured positive size and reject a download that is grossly smaller than
    // the catalog estimate (a truncated or empty pull). The estimate is
    // approximate, so we tolerate benign differences — including pulls that are
    // larger than expected — rather than demanding a byte-exact match.
    if (sizeBytes === undefined || sizeBytes <= 0) {
      throw new BackendError(
        `cannot verify ${options.modelId}: the catalog records no digest and no weights were found on disk`,
      );
    }
    if (options.expectedSizeBytes !== undefined) {
      const minAcceptableBytes = options.expectedSizeBytes * MIN_PULL_SIZE_RATIO;
      if (sizeBytes < minAcceptableBytes) {
        throw new BackendError(
          `size too small for ${options.modelId}: expected roughly ${options.expectedSizeBytes} bytes, found only ${sizeBytes}`,
        );
      }
    }
    return { modelId: options.modelId, digestVerified: false };
  }

  /**
   * Start the backend, preferring to attach to an already-running daemon over
   * spawning a duplicate. When we do spawn, we wait for the daemon to pass its
   * readiness probe and, on any failure, kill the process we started so it can
   * never leak as an orphan. The returned handle records `ownedByUs` so the
   * caller (and {@link stop}) only ever terminates daemons this process spawned.
   */
  async serve(options?: ServeOptions): Promise<ServeHandle> {
    const host = options?.host ?? DEFAULT_BIND_HOST;
    const port = options?.port ?? DEFAULT_OLLAMA_PORT;

    // Defence in depth: never expose the unauthenticated daemon beyond loopback
    // unless the caller explicitly opts in (spec §8).
    if (!(options?.allowNonLoopback ?? false) && !isLoopbackBindHost(host)) {
      throw new ValidationError(
        `refusing to bind non-loopback host "${host}" without an explicit opt-in`,
      );
    }

    const endpoint = buildEndpoint(host, port);
    const signal = options?.signal;

    if (signal?.aborted) {
      throw new BackendError(`ollama serve aborted for ${endpoint}`);
    }

    // Attach only when a reachable listener also passes a lightweight identity
    // check. Failing closed here avoids sending prompts/memory to arbitrary
    // local processes that happen to answer readiness probes.
    const attachProbe = await this.probeAttachTarget(endpoint, signal);
    if (attachProbe === "trusted") {
      return { endpoint, pid: 0, port, ownedByUs: false };
    }
    if (attachProbe === "untrusted") {
      throw new BackendError(
        `refusing to attach to ${endpoint}: listener did not pass Ollama identity check`,
      );
    }

    // The probe masks an abort as "not reachable", so re-check before spawning.
    if (signal?.aborted) {
      throw new BackendError(`ollama serve aborted for ${endpoint}`);
    }

    // Spawn our own daemon bound to the requested (loopback by default) address.
    // The caller's signal is deliberately NOT passed to this (persistent) child:
    // a successful serve leaves the daemon running, and its shutdown is owned by
    // stop()/state, not by the caller's request-scoped signal.
    let child: SpawnedProcess;
    try {
      child = this.spawn(this.binary, ["serve"], {
        env: buildServeEnv(host, port),
      });
    } catch (error) {
      throw wrapSpawnError(this.binary, error instanceof Error ? error : new Error(String(error)));
    }

    // `spawn` failures (e.g. ENOENT) and early exits arrive as events, not as a
    // synchronous throw. Observe them so they cannot crash the host as an
    // unhandled 'error', and so a crashing daemon short-circuits the wait.
    const earlyFailure = new Promise<never>((_resolve, reject) => {
      child.onError((error) => reject(wrapSpawnError(this.binary, error)));
      child.onClose((code) =>
        reject(new BackendError(`ollama serve exited before ${endpoint} was ready (code ${code})`)),
      );
    });
    // If readiness wins the race the daemon stays up and this promise may settle
    // later; swallow it so it never becomes an unhandled rejection.
    earlyFailure.catch(() => {});

    const pid = child.pid;
    if (!isUsablePid(pid)) {
      // Without a usable positive pid we cannot safely track/stop it. Tear it
      // down and fail.
      await stopSpawnedChild(child);
      throw new BackendError(`ollama serve did not report a usable pid for ${endpoint}`);
    }

    try {
      await Promise.race([this.waitUntilReady({ endpoint, signal }), earlyFailure]);
    } catch (error) {
      // Readiness failed/timed out or the daemon crashed: clean up our own child.
      await stopSpawnedChild(child);
      throw error instanceof BackendError
        ? error
        : new BackendError(`ollama serve failed to become ready at ${endpoint}`, { cause: error });
    }

    return { endpoint, pid, port, ownedByUs: true };
  }

  /** One quick readiness attempt used to decide attach-vs-spawn. */
  private async isReachable(
    endpoint: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const result = await this.probeReady(endpoint, signal, READINESS_REQUEST_TIMEOUT_MS);
    return result.ready;
  }

  /** Classify attach target as trusted, untrusted, or unreachable. */
  private async probeAttachTarget(
    endpoint: string,
    signal: AbortSignal | undefined,
  ): Promise<AttachProbeResult> {
    if (!(await this.isReachable(endpoint, signal))) return "unreachable";
    return (await this.isLikelyOllamaDaemon(endpoint, signal, READINESS_REQUEST_TIMEOUT_MS))
      ? "trusted"
      : "untrusted";
  }

  /** Best-effort daemon identity check for attach: validate `/api/version` shape. */
  private async isLikelyOllamaDaemon(
    endpoint: string,
    callerSignal: AbortSignal | undefined,
    requestTimeoutMs: number,
  ): Promise<boolean> {
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const base = endpoint.replace(/\/+$/, "");
      const response = await this.fetch(`${base}/api/version`, { signal: controller.signal });
      if (!response.ok || typeof response.json !== "function") return false;
      return isLikelyOllamaVersionPayload(await response.json());
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /**
   * Poll the OpenAI-compatible readiness endpoint (`/v1/models`, falling back to
   * `/api/tags`) with exponential backoff until it responds, the attempt budget
   * is spent, or the deadline elapses. Both exhaustion cases throw a typed
   * {@link BackendError} (distinguished by message) carrying the last transport
   * error as `cause`. Each request is itself bounded so a hung probe cannot
   * outlive the deadline. `retries` is the maximum number of attempts.
   */
  async waitUntilReady(options: ReadinessOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const maxAttempts = Math.max(1, options.retries ?? DEFAULT_READINESS_RETRIES);
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    for (;;) {
      if (options.signal?.aborted) {
        throw new BackendError(`readiness check aborted for ${options.endpoint}`);
      }

      attempt += 1;
      const requestTimeoutMs = Math.min(
        READINESS_REQUEST_TIMEOUT_MS,
        Math.max(deadline - Date.now(), 1),
      );
      const result = await this.probeReady(
        options.endpoint,
        options.signal,
        requestTimeoutMs,
        options.requireOpenAiCompatibility ?? false,
      );
      if (result.ready) return;
      const cause = result.lastError !== undefined ? { cause: result.lastError } : undefined;

      if (attempt >= maxAttempts) {
        throw new BackendError(
          `${options.endpoint} did not become ready after ${attempt} attempt(s)`,
          cause,
        );
      }
      if (Date.now() >= deadline) {
        throw new BackendError(`${options.endpoint} readiness timed out after ${timeoutMs}ms`, cause);
      }

      const remaining = Math.max(deadline - Date.now(), 0);
      await this.sleep(Math.min(readinessBackoffMs(attempt), remaining), options.signal);
    }
  }

  /**
   * One readiness attempt. Tries each probe path with a per-request timeout
   * (combined with the caller's signal); returns ready on the first 2xx.
   */
  private async probeReady(
    endpoint: string,
    callerSignal: AbortSignal | undefined,
    requestTimeoutMs: number,
    requireOpenAiCompatibility = false,
  ): Promise<ProbeResult> {
    const base = endpoint.replace(/\/+$/, "");
    let lastError: unknown;
    const readinessPaths = requireOpenAiCompatibility ? OPENAI_READINESS_PATHS : READINESS_PATHS;

    for (const path of readinessPaths) {
      const controller = new AbortController();
      const onCallerAbort = (): void => controller.abort();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      try {
        const response = await this.fetch(`${base}${path}`, { signal: controller.signal });
        if (response.ok) return { ready: true };
      } catch (error) {
        // Connection refused / timeout / network error → try the next path, then retry.
        lastError = error;
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    }
    return { ready: false, lastError };
  }

  /**
   * Stop a daemon. Only processes this adapter spawned (`ownedByUs`) are ever
   * signalled; an attached (foreign) daemon is left running. A process that has
   * already exited (`ESRCH`) is treated as a successful, idempotent stop.
   */
  async stop(handle: ServeHandle): Promise<void> {
    if (!handle.ownedByUs) return;
    // Refuse non-positive pids: `kill(0)`/`kill(-n)` would signal a whole process
    // group rather than the single daemon we own (handles round-trip through the
    // untrusted state file).
    if (!isUsablePid(handle.pid)) {
      throw new BackendError(`refusing to stop ollama daemon: invalid pid ${handle.pid}`);
    }

    // Defend against stale state + pid reuse: only terminate when the recorded
    // endpoint is still serving Ollama. If the endpoint is gone but the pid is
    // still alive, the pid may now belong to an unrelated process.
    if (!(await this.isReachable(handle.endpoint, undefined))) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ESRCH") return;
        throw new BackendError(`failed to probe ollama daemon liveness (pid ${handle.pid})`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      throw new BackendError(
        `refusing to stop ollama daemon (pid ${handle.pid}): ${handle.endpoint} is not reachable and pid may have been reused`,
      );
    }

    try {
      this.kill(handle.pid, "SIGTERM");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ESRCH") return;
      throw new BackendError(`failed to stop ollama daemon (pid ${handle.pid})`, {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    for (let attempt = 0; attempt < SHUTDOWN_POLL_ATTEMPTS; attempt += 1) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ESRCH") return;
        throw new BackendError(`failed to probe ollama daemon liveness (pid ${handle.pid})`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      await this.sleep(SHUTDOWN_POLL_INTERVAL_MS);
    }

    try {
      this.kill(handle.pid, "SIGKILL");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ESRCH") return;
      throw new BackendError(`failed to force-stop ollama daemon (pid ${handle.pid})`, {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    for (let attempt = 0; attempt < SHUTDOWN_POLL_ATTEMPTS; attempt += 1) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ESRCH") return;
        throw new BackendError(`failed to probe ollama daemon liveness (pid ${handle.pid})`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      await this.sleep(SHUTDOWN_POLL_INTERVAL_MS);
    }

    throw new BackendError(
      `failed to stop ollama daemon (pid ${handle.pid}): still alive after SIGTERM and SIGKILL`,
    );
  }

  chat(_request: ChatRequest): Promise<ChatResult> {
    return Promise.reject(new BackendError("ollama chat is implemented in a later task"));
  }

  embed(_request: EmbedRequest): Promise<EmbedResult> {
    return Promise.reject(new BackendError("ollama embed is implemented in a later task"));
  }
}
