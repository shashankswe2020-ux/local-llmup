/**
 * The `BackendAdapter` interface abstracts an inference backend (Ollama in v1;
 * MLX / llama.cpp / LM Studio as post-v1 fast-follows) so command code never
 * depends on a concrete backend. Adapters are **stateless**: all runtime facts
 * (pid, port, endpoint, ownership) live in `state.json`, and every method takes
 * the context it needs as arguments and returns plain data.
 */
import { ValidationError } from "../errors.js";
import type { BackendCapabilities, BackendName } from "../types.js";

/** Default loopback bind address; servers never bind `0.0.0.0` without opt-in. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Default port for the Ollama OpenAI-compatible server. */
export const DEFAULT_OLLAMA_PORT = 11434;

/**
 * Build an OpenAI-compatible base endpoint, bracketing IPv6 hosts. The scheme is
 * intentionally plaintext `http://`: v1 binds loopback only, and `--host` binds
 * remain unauthenticated by design (see spec §8).
 */
export function buildEndpoint(host: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError(`invalid port: ${port} (expected an integer in 1..65535)`);
  }
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const hostPart = host.includes(":") && !bracketed ? `[${host}]` : host;
  return `http://${hostPart}:${port}`;
}

/** Validate and normalize an unauthenticated backend endpoint to loopback HTTP. */
export function assertLoopbackEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new ValidationError(`invalid backend endpoint: ${raw}`, { cause });
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const loopback =
    host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || !loopback) {
    throw new ValidationError(`refusing non-loopback backend endpoint: ${raw}`);
  }
  return url.origin;
}

/** Progress event emitted while a model is being pulled. */
export interface PullProgress {
  readonly status: string;
  readonly completedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

/**
 * A pinned weight artifact for self-managed backends (llama.cpp GGUF, MLX) that
 * download a single file directly from a Hugging Face commit. Ignored by daemon
 * runtimes (Ollama) that pull by model id through their own content store.
 */
export interface PullWeightSource {
  /** Hugging Face `owner/name` repo id. */
  readonly repo: string;
  /** Full 40-hex commit SHA to pin (never a floating tag). */
  readonly revision: string;
  /** Exact repo-relative filename (no globs, `..`, or absolute paths). */
  readonly file: string;
  /** Expected SHA-256 digest; when absent, integrity is reported unverified. */
  readonly sha256?: string | undefined;
}

/** One digest-pinned file in a complete self-managed repository snapshot. */
export interface PullRepositoryFile {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Complete pinned repository source used by multi-file runtimes such as MLX. */
export interface PullRepositorySource {
  readonly repo: string;
  readonly revision: string;
  readonly files: readonly PullRepositoryFile[];
}

/** One model source candidate managed by an attach-only delegated runtime. */
export type PullDelegatedSource =
  | { readonly format: "gguf"; readonly source: PullWeightSource }
  | { readonly format: "mlx"; readonly repository: PullRepositorySource };

/** Inputs for pulling (downloading) a model quantization. */
export interface PullOptions {
  readonly modelId: string;
  /** Catalog SHA-256 digest to verify; absent → size-only verification. */
  readonly expectedSha256?: string | undefined;
  /**
   * Catalog on-disk size in bytes, used by the size-only fallback when a digest
   * cannot be obtained. This is an approximate estimate: the fallback treats it
   * as a plausibility floor (rejecting grossly-truncated downloads) rather than
   * a byte-exact target. Absent → the fallback only asserts the weights exist.
   */
  readonly expectedSizeBytes?: number | undefined;
  /**
   * Pinned Hugging Face weight artifact for self-managed backends (llama.cpp,
   * MLX). Required by those adapters and ignored by daemon runtimes (Ollama),
   * which resolve weights from {@link modelId} through their own store.
   */
  readonly source?: PullWeightSource | undefined;
  /** Complete multi-file repository manifest for MLX-style runtimes. */
  readonly repository?: PullRepositorySource | undefined;
  /** All catalog candidates an attach-only runtime may already manage. */
  readonly delegatedSources?: readonly PullDelegatedSource[] | undefined;
  readonly onProgress?: ((event: PullProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Result of a completed pull. */
export interface PullResult {
  readonly modelId: string;
  /** False when only a size check was possible (digest unavailable). */
  readonly digestVerified: boolean;
  /**
   * Filesystem path to the acquired weights, for per-model runtimes that must
   * hand the path to `serve` (e.g. llama.cpp's `-m`). Omitted by daemon runtimes
   * (Ollama) that serve from a shared store and take no explicit weights path.
   */
  readonly modelPath?: string | undefined;
}

/** Inputs for starting (or attaching to) a backend server. */
export interface ServeOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  /**
   * Filesystem path to the model weights to load. Required by per-model runtimes
   * that serve exactly one model per process (e.g. llama.cpp's `llama-server -m`,
   * MLX's `mlx_lm.server --model`); ignored by daemon runtimes that serve all
   * pulled models from a shared store (e.g. Ollama).
   */
  readonly modelPath?: string | undefined;
  /** Canonical catalog id exposed to OpenAI clients by single-model runtimes. */
  readonly modelId?: string | undefined;
  /**
   * Permit binding a non-loopback host (e.g. `0.0.0.0`). Off by default: the
   * server is unauthenticated, so exposing it beyond loopback must be an
   * explicit, deliberate opt-in (spec §8).
   */
  readonly allowNonLoopback?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A running server this process discovered or spawned. */
export interface ServeHandle {
  readonly endpoint: string;
  readonly pid: number;
  readonly port: number;
  /** True when this process spawned the daemon (so `down` may stop it). */
  readonly ownedByUs: boolean;
  /** Immutable process identity captured from the listening socket owner. */
  readonly processExecutable?: string | undefined;
  readonly processStartedAt?: string | undefined;
  /** Per-session bearer secret required by guarded self-managed runtimes. */
  readonly authToken?: string | undefined;
  /** Exact runtime-managed model path required to revalidate delegated attachment. */
  readonly modelPath?: string | undefined;
}

/** Options controlling how {@link BackendAdapter.stop} terminates a server. */
export interface StopOptions {
  /**
   * Allow stopping a daemon this process did not spawn (`ownedByUs: false`).
   * Only bypasses the ownership gate — the endpoint, pid, executable, and
   * process-identity verification still run before any signal is sent.
   */
  readonly allowForeign?: boolean | undefined;
}

/** Inputs for the readiness probe. */
export interface ReadinessOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number | undefined;
  readonly retries?: number | undefined;
  /**
   * Require OpenAI-compatible readiness (`/v1/models`) instead of allowing the
   * native Ollama fallback (`/api/tags`).
   */
  readonly requireOpenAiCompatibility?: boolean | undefined;
  readonly authToken?: string | undefined;
  readonly expectedProcess?: ExpectedProcessIdentity | undefined;
  readonly modelId?: string | undefined;
  readonly expectedModelPath?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A single chat turn in an OpenAI-compatible request. */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Tool calls an assistant turn requested (replayed back to the model). */
  readonly toolCalls?: readonly ChatToolCall[] | undefined;
  /** For `role: "tool"` result turns, the tool whose output this carries. */
  readonly toolName?: string | undefined;
}

/** A tool (function) definition advertised to a tool-capable model. */
export interface ChatTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly parameters: Record<string, unknown>;
}

/** A tool invocation the model requested in its response. */
export interface ChatToolCall {
  /** Provider-assigned call id, when the backend supplies one. */
  readonly id?: string | undefined;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Persisted process instance expected to own an active inference endpoint. */
export interface ExpectedProcessIdentity {
  readonly pid: number;
  readonly executable: string;
  readonly started: string;
}

/** Inputs for a (non-streaming) chat completion. */
export interface ChatRequest {
  /** Active server endpoint from state; omitted only by legacy/default callers. */
  readonly endpoint?: string | undefined;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** Tools to advertise for this turn; backends that lack tool support ignore it. */
  readonly tools?: readonly ChatTool[] | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Optional for legacy/daemon callers; required by MLX inference. */
  readonly expectedProcess?: ExpectedProcessIdentity | undefined;
  /** Active server bearer secret; required by guarded MLX inference. */
  readonly authToken?: string | undefined;
  readonly expectedModelPath?: string | undefined;
}

/** Result of a chat completion. */
export interface ChatResult {
  readonly content: string;
  /** Tool calls the model requested, when it chose to call tools instead of replying. */
  readonly toolCalls?: readonly ChatToolCall[] | undefined;
}

/**
 * Inputs for a streaming chat completion. Identical to {@link ChatRequest} plus
 * an `onDelta` sink that receives content fragments as the model produces them.
 * The returned {@link ChatResult} still carries the fully-accumulated content
 * (and any tool calls), so callers can ignore streaming and use the result.
 */
export interface ChatStreamRequest extends ChatRequest {
  /** Called with each content fragment as it arrives, in order. */
  readonly onDelta: (chunk: string) => void;
}

/** Inputs for an embedding request. */
export interface EmbedRequest {
  /** Active server endpoint from state; omitted only by legacy/default callers. */
  readonly endpoint?: string | undefined;
  readonly model: string;
  readonly input: readonly string[];
  readonly signal?: AbortSignal | undefined;
  /** Persisted attached/owned process expected to own the inference endpoint. */
  readonly expectedProcess?: ExpectedProcessIdentity | undefined;
  readonly expectedModelPath?: string | undefined;
}

/** Result of an embedding request. */
export interface EmbedResult {
  readonly vectors: readonly (readonly number[])[];
  readonly dimension: number;
}

/**
 * A stateless inference backend. Implementations must not cache mutable runtime
 * state between calls; persistence is the caller's responsibility via the state
 * module.
 */
export interface BackendAdapter {
  /** Stable adapter identifier, e.g. "ollama". */
  readonly name: BackendName;

  /** Declarative capabilities: what this backend can pull, embed, and serve. */
  readonly capabilities: BackendCapabilities;

  /** Whether the backend binary/daemon is available on this machine. */
  isInstalled(): Promise<boolean>;

  /** OS-appropriate install command shown when the backend is missing. */
  installHint(): string;

  /**
   * Best-effort backend version string (e.g. `"0.3.14"`), or `null` when it
   * cannot be determined. Probed offline via an arg-array, `shell:false` spawn.
   * Optional: adapters that cannot report a version omit it. Callers must treat
   * the value as untrusted and `stripControl` it before display.
   */
  version?(): Promise<string | null>;

  /** Download a model quantization, verifying integrity where possible. */
  pull(options: PullOptions): Promise<PullResult>;

  /** Start the server (or attach to a running one) bound to loopback. */
  serve(options?: ServeOptions): Promise<ServeHandle>;

  /** Resolve once the server passes its readiness probe; throw on timeout. */
  waitUntilReady(options: ReadinessOptions): Promise<void>;

  /**
   * Stop a server. By default this is a no-op for attached (foreign) daemons;
   * pass `allowForeign` to let an identity-verified foreign daemon be stopped.
   * All other safety checks (endpoint/pid/executable ownership) always apply.
   */
  stop(handle: ServeHandle, options?: StopOptions): Promise<void>;

  /** Run a non-streaming chat completion (used by `chat` and `migrate`). */
  chat(request: ChatRequest): Promise<ChatResult>;

  /**
   * Optionally run a streaming chat completion, invoking `onDelta` with content
   * fragments as they arrive. Backends that cannot stream omit this method;
   * callers must fall back to {@link BackendAdapter.chat}.
   */
  chatStream?(request: ChatStreamRequest): Promise<ChatResult>;

  /** Produce embeddings for the given inputs. */
  embed(request: EmbedRequest): Promise<EmbedResult>;
}
