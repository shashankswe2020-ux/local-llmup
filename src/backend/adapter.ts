/**
 * The `BackendAdapter` interface abstracts an inference backend (Ollama in v1;
 * MLX / llama.cpp / LM Studio as post-v1 fast-follows) so command code never
 * depends on a concrete backend. Adapters are **stateless**: all runtime facts
 * (pid, port, endpoint, ownership) live in `state.json`, and every method takes
 * the context it needs as arguments and returns plain data.
 */
import { ValidationError } from "../errors.js";

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

/** Progress event emitted while a model is being pulled. */
export interface PullProgress {
  readonly status: string;
  readonly completedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

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
  readonly onProgress?: ((event: PullProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Result of a completed pull. */
export interface PullResult {
  readonly modelId: string;
  /** False when only a size check was possible (digest unavailable). */
  readonly digestVerified: boolean;
}

/** Inputs for starting (or attaching to) a backend server. */
export interface ServeOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
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
  readonly signal?: AbortSignal | undefined;
}

/** A single chat turn in an OpenAI-compatible request. */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Inputs for a (non-streaming) chat completion. */
export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal | undefined;
}

/** Result of a chat completion. */
export interface ChatResult {
  readonly content: string;
}

/** Inputs for an embedding request. */
export interface EmbedRequest {
  readonly model: string;
  readonly input: readonly string[];
  readonly signal?: AbortSignal | undefined;
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
  readonly name: string;

  /** Whether the backend binary/daemon is available on this machine. */
  isInstalled(): Promise<boolean>;

  /** OS-appropriate install command shown when the backend is missing. */
  installHint(): string;

  /** Download a model quantization, verifying integrity where possible. */
  pull(options: PullOptions): Promise<PullResult>;

  /** Start the server (or attach to a running one) bound to loopback. */
  serve(options?: ServeOptions): Promise<ServeHandle>;

  /** Resolve once the server passes its readiness probe; throw on timeout. */
  waitUntilReady(options: ReadinessOptions): Promise<void>;

  /** Stop a server this process owns; a no-op for attached daemons. */
  stop(handle: ServeHandle): Promise<void>;

  /** Run a non-streaming chat completion (used by `chat` and `migrate`). */
  chat(request: ChatRequest): Promise<ChatResult>;

  /** Produce embeddings for the given inputs. */
  embed(request: EmbedRequest): Promise<EmbedResult>;
}
