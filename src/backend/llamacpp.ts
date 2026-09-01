/**
 * llama.cpp backend adapter (`llama-server`, GGUF).
 *
 * This slice (B14c) completes the adapter surface on top of the B14b lifecycle:
 * `pull` acquires a pinned GGUF via the shared, fail-closed weight-acquisition
 * module ({@link acquireWeight}) and returns the on-disk path so the command
 * layer can hand it to `serve -m`; `chat` speaks the OpenAI-compatible
 * `/v1/chat/completions` API; and `embed` fails closed (this adapter declares
 * `canEmbed:false`, so memory capture degrades to the vector-less path rather
 * than fabricating vectors — honesty gate).
 *
 * Like the Ollama adapter, this is stateless and its process/network/clock/
 * download seams are injectable (`spawn`/`fetch`/`sleep`/`kill`/`acquire`) so
 * tests never touch a real `llama-server` or the network. Every spawn is
 * `shell:false` with a discrete argument array; the server is only ever bound to
 * loopback without an explicit opt-in.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BackendError, ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import {
  assertLoopbackEndpoint,
  buildEndpoint,
  DEFAULT_BIND_HOST,
  type BackendAdapter,
  type ChatRequest,
  type ChatResult,
  type EmbedRequest,
  type EmbedResult,
  type PullOptions,
  type PullResult,
  type ReadinessOptions,
  type ServeHandle,
  type ServeOptions,
} from "./adapter.js";
import { acquireWeight, createAcquireFetch } from "./acquire.js";
import type { AcquireRequest, AcquireResult } from "./acquire.js";
import type {
  FetchFn,
  FetchResponseLike,
  KillFn,
  ProcessOutputStream,
  SleepFn,
  SpawnFn,
  SpawnedProcess,
} from "./ollama.js";
import type { BackendCapabilities } from "../types.js";
import { assertSafeModelId } from "./net.js";
import {
  matchesExpectedExecutable,
  probeListenerIdentity,
  probeProcessIdentity,
  sameListenerProcess,
  type ListenerIdentity,
  type ProcessIdentity,
} from "./listener.js";

/** Default binary name resolved from `PATH`. */
const LLAMA_SERVER_BINARY = "llama-server";

/** llama.cpp / mlx-lm / llamafile all default to loopback port 8080 (spec §12.5). */
const LLAMACPP_DEFAULT_PORT = 8080;

/** Upper bound on how long the `--version` probe may run before it is aborted. */
const VERSION_PROBE_TIMEOUT_MS = 1_500;

/** Cap on captured probe output, bounding memory for newline-less streams. */
const VERSION_CAPTURE_MAX_BYTES = 8 * 1024;

/** Cap on characters kept from a non-semver version banner. */
const VERSION_BANNER_MAX_CHARS = 100;

/** Readiness paths probed in order: llama.cpp `/health` first, OpenAI fallback. */
const READINESS_PATHS = ["/health", "/v1/models"] as const;
/** OpenAI-compatible-only readiness path (when `requireOpenAiCompatibility`). */
const OPENAI_READINESS_PATHS = ["/v1/models"] as const;
/** llama.cpp-specific endpoint used to fingerprint an attach target. */
const IDENTITY_PATH = "/props";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_RETRIES = 20;
const READINESS_BACKOFF_BASE_MS = 100;
const READINESS_BACKOFF_MAX_MS = 2_000;
/** Upper bound on a single readiness request, so one hung probe can't outlive the deadline. */
const READINESS_REQUEST_TIMEOUT_MS = 5_000;

const SHUTDOWN_GRACE_MS = 500;
const SHUTDOWN_POLL_INTERVAL_MS = 50;
const SHUTDOWN_POLL_ATTEMPTS = 10;

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
    stdio: options.stdio === "ignore" ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
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

/** Map a spawn/child failure onto a typed {@link BackendError}. */
function wrapSpawnError(binary: string, error: unknown): BackendError {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as { code?: unknown }).code;
  if (err.name === "AbortError" || code === "ABORT_ERR") {
    return new BackendError(`${binary} was aborted`, { cause: err });
  }
  if (code === "ENOENT") {
    return new BackendError(`${binary} not found on PATH`, { cause: err });
  }
  return new BackendError(`failed to run ${binary}: ${err.message}`, { cause: err });
}

interface ProbeResult {
  readonly code: number;
  readonly text: string;
}

/**
 * Run `binary args`, returning the exit code and (optionally) the combined
 * stdout+stderr text, capped at {@link VERSION_CAPTURE_MAX_BYTES}. Rejects with a
 * {@link BackendError} if the spawn itself fails.
 */
function probe(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  capture: boolean,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      child = spawn(binary, args, { shell: false, stdio: "pipe", signal });
    } catch (error) {
      reject(wrapSpawnError(binary, error));
      return;
    }
    let text = "";
    if (capture) {
      const onData = (chunk: string): void => {
        if (text.length < VERSION_CAPTURE_MAX_BYTES) {
          text += chunk;
        }
      };
      child.stdout?.onData(onData);
      child.stderr?.onData(onData);
    }
    child.onError((error) => reject(wrapSpawnError(binary, error)));
    child.onClose((code) => resolve({ code: code ?? -1, text }));
  });
}

/**
 * Extract a best-effort version from `llama-server --version` output. llama.cpp
 * reports a build number (e.g. `version: 3860 (a1b2c3d)`), often on stderr,
 * alongside a compiler banner (`built with Apple clang version 15.0.0 …`). The
 * `version:` line is authoritative, so match it first — matching a generic
 * semver token first would wrongly report the *compiler* version. Fall back to
 * a semver token, then the first non-empty line (length-bounded). The result is
 * still untrusted — callers `stripControl` before display.
 */
function parseVersion(output: string): string | null {
  const build = /version:\s*([0-9A-Za-z.+-]+)/i.exec(output);
  if (build !== null && build[1] !== undefined) {
    return build[1];
  }
  const semver = /\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/.exec(output);
  if (semver !== null) {
    return semver[0];
  }
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine !== undefined ? firstLine.slice(0, VERSION_BANNER_MAX_CHARS) : null;
}

const defaultFetch: FetchFn = (url, init) => {
  const requestInit: RequestInit = {
    signal: init?.signal ?? null,
    redirect: "error",
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
  };
  return fetch(url, requestInit);
};

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

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

/** Acquire a pinned weight artifact; injected in tests so no network is touched. */
export interface AcquireRuntimeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxBytes?: number | undefined;
  readonly onProgress?: ((completedBytes: number) => void) | undefined;
}

export type AcquireFn = (
  request: AcquireRequest,
  options?: AcquireRuntimeOptions,
) => Promise<AcquireResult>;

/** Production {@link AcquireFn}: the shared fail-closed downloader with native `fetch`. */
const defaultAcquire: AcquireFn = (request, options = {}) =>
  acquireWeight(request, { fetch: createAcquireFetch(), ...options });

/**
 * OpenAI-compatible chat completion response (the subset we consume). `choices`
 * must be non-empty; the first choice's message content is the reply. Extra
 * fields are ignored, so a richer server response still parses.
 */
const OpenAiChatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

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

/** Exponential backoff (capped) for the Nth readiness attempt (1-based). */
function readinessBackoffMs(attempt: number): number {
  return Math.min(READINESS_BACKOFF_BASE_MS * 2 ** (attempt - 1), READINESS_BACKOFF_MAX_MS);
}

/**
 * Fingerprint a `/props` payload as a llama-server response. `/props` is
 * distinctive to llama.cpp (it reports slot/generation settings), so a listener
 * that answers it with this shape is trusted for attach; anything else is
 * refused rather than risk sending prompts to an unrelated local process.
 */
interface LlamaServerIdentity {
  readonly modelPath: string;
  readonly modelAlias: string;
}

function llamaServerIdentity(payload: unknown): LlamaServerIdentity | null {
  if (typeof payload !== "object" || payload === null) return null;
  const props = payload as Record<string, unknown>;
  const likely =
    typeof props["default_generation_settings"] === "object" ||
    typeof props["total_slots"] === "number" ||
    typeof props["chat_template"] === "string" ||
    typeof props["model_path"] === "string";
  if (!likely) return null;
  return {
    modelPath: typeof props["model_path"] === "string" ? props["model_path"] : "",
    modelAlias: typeof props["model_alias"] === "string" ? props["model_alias"] : "",
  };
}

/** Outcome of one readiness attempt across all probe paths. */
type ReadinessResult =
  { readonly ready: true } | { readonly ready: false; readonly lastError: unknown };

/** Outcome of a single path probe: 2xx, a non-2xx HTTP status, or a transport error. */
type PathProbe =
  | { readonly kind: "ok" }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "error"; readonly error: unknown };

/** Attach-target classification for the serve attach-vs-spawn decision. */
type AttachClassification = "trusted" | "untrusted" | "unreachable";

/** Options for constructing a {@link LlamaCppAdapter}. */
export interface LlamaCppAdapterOptions {
  readonly spawn?: SpawnFn | undefined;
  readonly binary?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly fetch?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly kill?: KillFn | undefined;
  readonly acquire?: AcquireFn | undefined;
  readonly listenerProbe?:
    ((port: number, host: string) => Promise<ListenerIdentity | null>) | undefined;
  readonly processProbe?: ((pid: number) => Promise<ProcessIdentity | null>) | undefined;
}

/** Stateless adapter over the llama.cpp `llama-server` backend. */
export class LlamaCppAdapter implements BackendAdapter {
  readonly name = "llamacpp";
  readonly capabilities: BackendCapabilities = {
    canPull: true,
    // A single chat-serving `llama-server` instance cannot also serve
    // embeddings (that requires a dedicated `--embedding` server), so declare
    // `false`: memory capture then degrades to the vector-less path (honest, no
    // fabricated vectors) rather than calling an endpoint that isn't enabled.
    canEmbed: false,
    embeddingOffload: "unknown",
    openAiCompatible: true,
    formats: ["gguf"],
    defaultPort: LLAMACPP_DEFAULT_PORT,
  };

  private readonly spawn: SpawnFn;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;
  private readonly kill: KillFn;
  private readonly acquire: AcquireFn;
  private readonly listenerProbe: (port: number, host: string) => Promise<ListenerIdentity | null>;
  private readonly processProbe: (pid: number) => Promise<ProcessIdentity | null>;

  constructor(options: LlamaCppAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? LLAMA_SERVER_BINARY;
    this.platform = options.platform ?? process.platform;
    this.fetch = options.fetch ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.kill = options.kill ?? defaultKill;
    this.acquire = options.acquire ?? defaultAcquire;
    this.listenerProbe = options.listenerProbe ?? probeListenerIdentity;
    this.processProbe = options.processProbe ?? probeProcessIdentity;
  }

  async isInstalled(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_PROBE_TIMEOUT_MS);
    try {
      const { code } = await probe(
        this.spawn,
        this.binary,
        ["--version"],
        controller.signal,
        false,
      );
      return code === 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  installHint(): string {
    switch (this.platform) {
      case "darwin":
        return "brew install llama.cpp";
      case "linux":
        return "brew install llama.cpp  # or build/download llama-server from https://github.com/ggml-org/llama.cpp/releases";
      case "win32":
        return "winget install ggml.llamacpp  # or download llama-server from https://github.com/ggml-org/llama.cpp/releases";
      default:
        return "Install llama.cpp (llama-server) from https://github.com/ggml-org/llama.cpp";
    }
  }

  /**
   * Best-effort version via `llama-server --version` (arg array, `shell:false`).
   * Bounded by an abort deadline so a wedged binary cannot block `doctor`, and
   * `stripControl`-clean at the source: display-safe or `null`. Never throws — a
   * probe failure or non-zero exit reports `null` rather than aborting.
   */
  async version(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_PROBE_TIMEOUT_MS);
    try {
      const { code, text } = await probe(
        this.spawn,
        this.binary,
        ["--version"],
        controller.signal,
        true,
      );
      if (code !== 0) return null;
      const parsed = parseVersion(text);
      return parsed === null ? null : stripControl(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Acquire a pinned GGUF weight via the shared, fail-closed
   * {@link acquireWeight} module: it verifies the resolved commit and (when the
   * catalog supplies one) the SHA-256 digest, and only promotes the file after
   * an atomic rename — never serving a partial or mismatched download. Returns
   * the on-disk path so the command layer can pass it to `serve -m`. Requires a
   * pinned {@link PullOptions.source}; there is no model-id fallback because
   * llama.cpp manages its own weights rather than pulling through a daemon.
   */
  async pull(options: PullOptions): Promise<PullResult> {
    const source = options.source;
    if (source === undefined) {
      throw new BackendError(
        `refusing to pull ${options.modelId}: llamacpp requires a pinned gguf weight source`,
      );
    }
    if (source.sha256 === undefined) {
      throw new BackendError(
        `refusing to pull ${options.modelId}: llamacpp requires a catalog SHA-256 digest`,
      );
    }

    options.onProgress?.({ status: `downloading ${source.file}` });
    const request: AcquireRequest = {
      backend: this.name,
      repo: source.repo,
      revision: source.revision,
      file: source.file,
      sha256: source.sha256,
    };
    const maxBytes =
      options.expectedSizeBytes !== undefined
        ? Math.ceil(
            Math.max(options.expectedSizeBytes * 1.5, options.expectedSizeBytes + 64 * 1024 * 1024),
          )
        : undefined;
    const result = await this.acquire(request, {
      signal: options.signal,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      onProgress: (completedBytes) =>
        options.onProgress?.({
          status: `downloading ${source.file}`,
          completedBytes,
          ...(options.expectedSizeBytes !== undefined
            ? { totalBytes: options.expectedSizeBytes }
            : {}),
        }),
    });
    options.onProgress?.({
      status: result.cached ? `cached ${source.file}` : `downloaded ${source.file}`,
      completedBytes: result.bytes,
      totalBytes: result.bytes,
    });

    return {
      modelId: options.modelId,
      digestVerified: result.digestVerified,
      modelPath: result.path,
    };
  }

  /**
   * Start `llama-server` for one model, preferring to attach to a running
   * llama-server on the target port over spawning a duplicate. The bind is
   * loopback-only unless `allowNonLoopback` is set (spec §8). The port-ownership
   * preflight never claims ownership of a foreign listener: a trusted
   * llama-server is attached (`ownedByUs:false`), an unrecognised listener is
   * refused, and only a free port leads to an owned spawn. On any readiness
   * failure the spawned child is torn down so it cannot leak as an orphan.
   */
  async serve(options?: ServeOptions): Promise<ServeHandle> {
    const host = options?.host ?? DEFAULT_BIND_HOST;
    const port = options?.port ?? LLAMACPP_DEFAULT_PORT;

    // Defence in depth: never expose the unauthenticated server beyond loopback
    // unless the caller explicitly opts in (spec §8).
    if (!(options?.allowNonLoopback ?? false) && !isLoopbackBindHost(host)) {
      throw new ValidationError(
        `refusing to bind non-loopback host "${host}" without an explicit opt-in`,
      );
    }

    const endpoint = buildEndpoint(host, port);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new BackendError(`llama-server serve aborted for ${endpoint}`);
    }

    // Port-ownership preflight: attach to a trusted llama-server, refuse a
    // foreign listener, and only spawn when the port is free.
    const requestedModelPath = options?.modelPath?.trim();
    const requestedModelId = options?.modelId?.trim();
    const listenerBefore = await this.listenerProbe(port, host);
    const attach = await this.probeAttachTarget(
      endpoint,
      signal,
      requestedModelPath,
      requestedModelId,
    );
    if (attach === "trusted") {
      await this.pollUntilReady(
        endpoint,
        DEFAULT_READINESS_TIMEOUT_MS,
        DEFAULT_READINESS_RETRIES,
        signal,
        (probeSignal, requestTimeoutMs) =>
          this.probeServeReady(endpoint, probeSignal, requestTimeoutMs),
      );
      const listenerAfter = await this.listenerProbe(port, host);
      if (
        listenerBefore === null ||
        listenerAfter === null ||
        !sameListenerProcess(listenerBefore, listenerAfter) ||
        !matchesExpectedExecutable(listenerAfter, this.binary)
      ) {
        throw new BackendError(
          `refusing to attach to ${endpoint}: listener ownership could not be verified`,
        );
      }
      return {
        endpoint,
        pid: listenerAfter.pid,
        port,
        ownedByUs: false,
        processExecutable: listenerAfter.executable,
        processStartedAt: listenerAfter.started,
      };
    }
    if (attach === "untrusted") {
      throw new BackendError(
        `refusing to attach to ${endpoint}: listener did not pass llama-server identity check`,
      );
    }
    if (listenerBefore !== null) {
      throw new BackendError(`refusing to spawn at ${endpoint}: port has an unresponsive listener`);
    }

    // The probe masks an abort as "unreachable", so re-check before spawning.
    if (signal?.aborted) {
      throw new BackendError(`llama-server serve aborted for ${endpoint}`);
    }

    // llama-server loads exactly one model per process, so a weights path is
    // mandatory to spawn our own server (attaching above needs none).
    const modelPath = requestedModelPath;
    if (modelPath === undefined || modelPath.length === 0) {
      throw new BackendError(`refusing to serve ${endpoint}: no model path was provided`);
    }
    // Defence in depth: a leading-dash path could be misparsed as a flag by some
    // argv parsers even when passed as the `-m` value, so refuse it outright.
    if (modelPath.startsWith("-")) {
      throw new BackendError(`refusing to serve ${endpoint}: model path must not start with "-"`);
    }

    // Arg array, `shell:false`, explicit loopback bind. llama-server takes no
    // positional args (the model is the `-m` option), so no `--` separator.
    const modelId = requestedModelId;
    if (modelId !== undefined && modelId.length > 0) assertSafeModelId(modelId);
    const args = [
      "-m",
      modelPath,
      "--host",
      host,
      "--port",
      String(port),
      ...(modelId !== undefined && modelId.length > 0 ? ["--alias", modelId] : []),
    ];

    // The caller's signal is deliberately NOT passed to this (persistent) child:
    // a successful serve leaves the server running, and its shutdown is owned by
    // stop()/state, not by the caller's request-scoped signal.
    let child: SpawnedProcess;
    let spawnedIdentity: ListenerIdentity | undefined;
    try {
      child = this.spawn(this.binary, args, { shell: false, stdio: "ignore" });
    } catch (error) {
      throw wrapSpawnError(this.binary, error);
    }

    // `spawn` failures (e.g. ENOENT) and early exits arrive as events, not as a
    // synchronous throw. Observe them so they cannot crash the host as an
    // unhandled 'error', and so a crashing server short-circuits the wait.
    const earlyFailure = new Promise<never>((_resolve, reject) => {
      child.onError((error) => reject(wrapSpawnError(this.binary, error)));
      child.onClose((code) =>
        reject(new BackendError(`llama-server exited before ${endpoint} was ready (code ${code})`)),
      );
    });
    earlyFailure.catch(() => {});

    const pid = child.pid;
    if (!isUsablePid(pid)) {
      await stopSpawnedChild(child);
      throw new BackendError(`llama-server did not report a usable pid for ${endpoint}`);
    }

    try {
      // Gate on `/health` (authoritative load state) rather than `/v1/models`,
      // which can answer 200 while the model is still loading.
      await Promise.race([
        this.pollUntilReady(
          endpoint,
          DEFAULT_READINESS_TIMEOUT_MS,
          DEFAULT_READINESS_RETRIES,
          signal,
          (probeSignal, requestTimeoutMs) =>
            this.probeServeReady(endpoint, probeSignal, requestTimeoutMs),
        ),
        earlyFailure,
      ]);
      const listener = await this.listenerProbe(port, host);
      if (
        listener === null ||
        listener.pid !== pid ||
        !matchesExpectedExecutable(listener, this.binary) ||
        !(await this.isLikelyLlamaServer(
          endpoint,
          signal,
          READINESS_REQUEST_TIMEOUT_MS,
          modelPath,
          modelId,
        ))
      ) {
        throw new BackendError(`llama-server readiness did not belong to spawned pid ${pid}`);
      }
      spawnedIdentity = listener;
    } catch (error) {
      await stopSpawnedChild(child);
      throw error instanceof BackendError
        ? error
        : new BackendError(`llama-server failed to become ready at ${endpoint}`, { cause: error });
    }
    if (spawnedIdentity === undefined) {
      throw new BackendError(`llama-server did not produce a verified process identity`);
    }

    return {
      endpoint,
      pid,
      port,
      ownedByUs: true,
      processExecutable: spawnedIdentity.executable,
      processStartedAt: spawnedIdentity.started,
    };
  }

  /**
   * Poll the readiness endpoint (`/health`, falling back to `/v1/models`; or
   * `/v1/models` only when `requireOpenAiCompatibility`) with exponential
   * backoff until it responds, the attempt budget is spent, or the deadline
   * elapses. Both exhaustion cases throw a typed {@link BackendError}. Each
   * request is itself bounded so a hung probe cannot outlive the deadline.
   */
  async waitUntilReady(options: ReadinessOptions): Promise<void> {
    const endpoint = assertLoopbackEndpoint(options.endpoint);
    await this.pollUntilReady(
      endpoint,
      options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      Math.max(1, options.retries ?? DEFAULT_READINESS_RETRIES),
      options.signal,
      (probeSignal, requestTimeoutMs) =>
        this.probeReady(
          endpoint,
          probeSignal,
          requestTimeoutMs,
          options.requireOpenAiCompatibility ?? false,
        ),
    );
  }

  /**
   * Shared readiness retry loop: call `probeOnce` with exponential backoff until
   * it reports ready, the attempt budget is spent, or the deadline elapses.
   */
  private async pollUntilReady(
    endpoint: string,
    timeoutMs: number,
    maxAttempts: number,
    signal: AbortSignal | undefined,
    probeOnce: (
      signal: AbortSignal | undefined,
      requestTimeoutMs: number,
    ) => Promise<ReadinessResult>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    for (;;) {
      if (signal?.aborted) {
        throw new BackendError(`readiness check aborted for ${endpoint}`);
      }

      attempt += 1;
      const requestTimeoutMs = Math.min(
        READINESS_REQUEST_TIMEOUT_MS,
        Math.max(deadline - Date.now(), 1),
      );
      const result = await probeOnce(signal, requestTimeoutMs);
      if (result.ready) return;
      const cause = result.lastError !== undefined ? { cause: result.lastError } : undefined;

      if (attempt >= maxAttempts) {
        throw new BackendError(
          `${endpoint} did not become ready after ${attempt} attempt(s)`,
          cause,
        );
      }
      if (Date.now() >= deadline) {
        throw new BackendError(`${endpoint} readiness timed out after ${timeoutMs}ms`, cause);
      }

      const remaining = Math.max(deadline - Date.now(), 0);
      await this.sleep(Math.min(readinessBackoffMs(attempt), remaining), signal);
    }
  }

  /**
   * Stop a server. Only processes this adapter spawned (`ownedByUs`) are ever
   * signalled; an attached (foreign) server is left running. A process that has
   * already exited (`ESRCH`) is treated as a successful, idempotent stop.
   */
  async stop(handle: ServeHandle): Promise<void> {
    if (!handle.ownedByUs) return;
    const endpoint = assertLoopbackEndpoint(handle.endpoint);
    // Refuse non-positive pids: `kill(0)`/`kill(-n)` would signal a whole process
    // group rather than the single server we own (handles round-trip through the
    // untrusted state file).
    if (!isUsablePid(handle.pid)) {
      throw new BackendError(`refusing to stop llama-server: invalid pid ${handle.pid}`);
    }
    const host = new URL(endpoint).hostname.replace(/^\[/, "").replace(/\]$/, "");
    const listener = await this.listenerProbe(handle.port, host);
    if (listener === null) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        if (isEsrch(error)) return;
        throw error;
      }
      throw new BackendError(
        `refusing to stop llama-server (pid ${handle.pid}): no verified listener owns the port`,
      );
    }
    if (listener.pid !== handle.pid || !matchesExpectedExecutable(listener, this.binary)) {
      throw new BackendError(
        `refusing to stop llama-server (pid ${handle.pid}): pid does not own the recorded listener`,
      );
    }
    if (
      (handle.processExecutable !== undefined &&
        listener.executable !== handle.processExecutable) ||
      (handle.processStartedAt !== undefined && listener.started !== handle.processStartedAt)
    ) {
      throw new BackendError(
        `refusing to stop llama-server (pid ${handle.pid}): process identity changed`,
      );
    }

    // Defend against stale state + pid reuse: only terminate when the recorded
    // endpoint is still serving. If the endpoint is gone but the pid is still
    // alive, the pid may now belong to an unrelated process.
    if (!(await this.isReachable(endpoint, undefined))) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        if (isEsrch(error)) return;
        throw new BackendError(`failed to probe llama-server liveness (pid ${handle.pid})`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      throw new BackendError(
        `refusing to stop llama-server (pid ${handle.pid}): ${endpoint} is not reachable and pid may have been reused`,
      );
    }
    if (
      !(await this.isLikelyLlamaServer(
        endpoint,
        undefined,
        READINESS_REQUEST_TIMEOUT_MS,
        undefined,
        undefined,
      ))
    ) {
      throw new BackendError(
        `refusing to stop llama-server (pid ${handle.pid}): endpoint failed identity check`,
      );
    }
    const listenerAfter = await this.listenerProbe(handle.port, host);
    if (listenerAfter === null || !sameListenerProcess(listener, listenerAfter)) {
      throw new BackendError(
        `refusing to stop llama-server (pid ${handle.pid}): listener changed during identity check`,
      );
    }

    try {
      this.kill(handle.pid, "SIGTERM");
    } catch (error) {
      if (isEsrch(error)) return;
      throw new BackendError(`failed to stop llama-server (pid ${handle.pid})`, {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    for (let attempt = 0; attempt < SHUTDOWN_POLL_ATTEMPTS; attempt += 1) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        if (isEsrch(error)) return;
        throw new BackendError(`failed to probe llama-server liveness (pid ${handle.pid})`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      await this.sleep(SHUTDOWN_POLL_INTERVAL_MS);
    }

    const forceIdentity = await this.processProbe(handle.pid);
    if (
      forceIdentity === null ||
      forceIdentity.pid !== listener.pid ||
      forceIdentity.executable !== listener.executable ||
      forceIdentity.started !== listener.started
    ) {
      throw new BackendError(
        `refusing to force-stop llama-server (pid ${handle.pid}): process identity changed`,
      );
    }

    try {
      this.kill(handle.pid, "SIGKILL");
    } catch (error) {
      if (isEsrch(error)) return;
      throw new BackendError(`failed to force-stop llama-server (pid ${handle.pid})`, {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    for (let attempt = 0; attempt < SHUTDOWN_POLL_ATTEMPTS; attempt += 1) {
      try {
        this.kill(handle.pid, 0);
      } catch (error) {
        if (isEsrch(error)) return;
        throw new BackendError(`failed to probe llama-server liveness (pid ${handle.pid})`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      await this.sleep(SHUTDOWN_POLL_INTERVAL_MS);
    }

    throw new BackendError(
      `failed to stop llama-server (pid ${handle.pid}): still alive after SIGTERM and SIGKILL`,
    );
  }

  /**
   * Non-streaming chat completion over the OpenAI-compatible endpoint
   * (`POST /v1/chat/completions`). The reply is the first choice's message
   * content; a transport failure, non-2xx status, or malformed body raises a
   * typed {@link BackendError}. The model id travels only in the JSON body (not
   * an argv or URL path), so it is passed through as-is.
   */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const endpoint = assertLoopbackEndpoint(
      request.endpoint ?? buildEndpoint(DEFAULT_BIND_HOST, LLAMACPP_DEFAULT_PORT),
    );
    const expectedListener = await this.captureExpectedInferenceListener(
      endpoint,
      request.expectedProcess,
    );
    const url = `${endpoint}/v1/chat/completions`;

    let response: FetchResponseLike;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
        }),
        signal: request.signal,
      });
    } catch (error) {
      throw new BackendError(`llamacpp chat request failed for ${request.model}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    if (!response.ok) {
      throw new BackendError(
        `llamacpp chat failed for ${request.model} (status ${response.status})`,
      );
    }
    if (typeof response.json !== "function") {
      throw new BackendError("llamacpp chat returned a malformed response body");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new BackendError("llamacpp chat returned invalid JSON", {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    const parsed = OpenAiChatResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BackendError("llamacpp chat returned a malformed response body", {
        cause: parsed.error,
      });
    }

    const [first] = parsed.data.choices;
    if (first === undefined) {
      throw new BackendError("llamacpp chat returned no choices");
    }
    await this.assertInferenceListenerUnchanged(endpoint, expectedListener);
    return { content: first.message.content };
  }

  /**
   * Embeddings are not served: a single chat `llama-server` process cannot also
   * answer `/v1/embeddings`, so this adapter declares `canEmbed:false` and fails
   * closed here rather than fabricating vectors. Memory capture consults the
   * capability flag and degrades to the vector-less path (honesty gate).
   */
  embed(_request: EmbedRequest): Promise<EmbedResult> {
    return Promise.reject(
      new BackendError(
        "llamacpp does not serve embeddings (canEmbed is false); memory capture uses the vector-less path",
      ),
    );
  }

  private async captureExpectedInferenceListener(
    endpoint: string,
    expected: import("./adapter.js").ExpectedProcessIdentity | undefined,
  ): Promise<ListenerIdentity | null> {
    if (expected === undefined) return null;
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
    const port = Number(url.port || "80");
    const listener = await this.listenerProbe(port, host);
    if (
      listener === null ||
      listener.pid !== expected.pid ||
      listener.executable !== expected.executable ||
      listener.started !== expected.started ||
      !matchesExpectedExecutable(listener, this.binary)
    ) {
      throw new BackendError(
        "llamacpp inference listener does not match expected process identity",
      );
    }
    return listener;
  }

  private async assertInferenceListenerUnchanged(
    endpoint: string,
    before: ListenerIdentity | null,
  ): Promise<void> {
    if (before === null) return;
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
    const port = Number(url.port || "80");
    const after = await this.listenerProbe(port, host);
    if (after === null || !sameListenerProcess(before, after)) {
      throw new BackendError("llamacpp inference listener changed during request");
    }
  }

  /** One quick readiness attempt used to decide attach-vs-spawn / liveness. */
  private async isReachable(endpoint: string, signal: AbortSignal | undefined): Promise<boolean> {
    const result = await this.probeReady(endpoint, signal, READINESS_REQUEST_TIMEOUT_MS, false);
    return result.ready;
  }

  /** Classify an attach target as trusted, untrusted, or unreachable. */
  private async probeAttachTarget(
    endpoint: string,
    signal: AbortSignal | undefined,
    expectedModelPath: string | undefined,
    expectedModelId: string | undefined,
  ): Promise<AttachClassification> {
    if (!(await this.isReachable(endpoint, signal))) return "unreachable";
    return (await this.isLikelyLlamaServer(
      endpoint,
      signal,
      READINESS_REQUEST_TIMEOUT_MS,
      expectedModelPath,
      expectedModelId,
    ))
      ? "trusted"
      : "untrusted";
  }

  /** Best-effort identity check for attach: validate the `/props` shape. */
  private async isLikelyLlamaServer(
    endpoint: string,
    callerSignal: AbortSignal | undefined,
    requestTimeoutMs: number,
    expectedModelPath: string | undefined,
    expectedModelId: string | undefined,
  ): Promise<boolean> {
    const base = endpoint.replace(/\/+$/, "");
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await this.fetch(`${base}${IDENTITY_PATH}`, { signal: controller.signal });
      if (!response.ok || typeof response.json !== "function") return false;
      const identity = llamaServerIdentity(await response.json());
      if (identity === null) return false;
      return (
        (expectedModelPath === undefined ||
          resolve(identity.modelPath) === resolve(expectedModelPath)) &&
        (expectedModelId === undefined || identity.modelAlias === expectedModelId)
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
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
    requireOpenAiCompatibility: boolean,
  ): Promise<ReadinessResult> {
    const base = endpoint.replace(/\/+$/, "");
    let lastError: unknown;
    const paths = requireOpenAiCompatibility ? OPENAI_READINESS_PATHS : READINESS_PATHS;

    for (const path of paths) {
      const probe = await this.probePath(base, path, callerSignal, requestTimeoutMs);
      if (probe.kind === "ok") return { ready: true };
      if (probe.kind === "error") lastError = probe.error;
    }
    return { ready: false, lastError };
  }

  /**
   * Owned-serve readiness. `/health` is authoritative: `200` → ready, `503` →
   * still loading (keep waiting, never fall through). Only when `/health` is
   * absent (404) or unreachable do we consult `/v1/models`, so a model that is
   * still loading is never reported ready.
   */
  private async probeServeReady(
    endpoint: string,
    callerSignal: AbortSignal | undefined,
    requestTimeoutMs: number,
  ): Promise<ReadinessResult> {
    const base = endpoint.replace(/\/+$/, "");
    const health = await this.probePath(base, "/health", callerSignal, requestTimeoutMs);
    if (health.kind === "ok") return { ready: true };
    if (health.kind === "status" && health.status === 503) {
      // Reachable but still loading the model — wait rather than mask via /v1/models.
      return { ready: false, lastError: undefined };
    }
    const models = await this.probePath(base, "/v1/models", callerSignal, requestTimeoutMs);
    if (models.kind === "ok") return { ready: true };
    return { ready: false, lastError: models.kind === "error" ? models.error : undefined };
  }

  /**
   * Perform one bounded GET against `base + path`, classifying the outcome as a
   * 2xx (`ok`), a non-2xx HTTP `status`, or a transport `error`. The request is
   * capped by `requestTimeoutMs` and the caller's abort signal.
   */
  private async probePath(
    base: string,
    path: string,
    callerSignal: AbortSignal | undefined,
    requestTimeoutMs: number,
  ): Promise<PathProbe> {
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await this.fetch(`${base}${path}`, { signal: controller.signal });
      return response.ok ? { kind: "ok" } : { kind: "status", status: response.status };
    } catch (error) {
      return { kind: "error", error };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

/** True when an error carries the POSIX `ESRCH` (no such process) code. */
function isEsrch(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ESRCH";
}
