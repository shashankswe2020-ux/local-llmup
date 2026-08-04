/** Base error for all local-llmup failures. Carries a stable, machine-readable code. */
export class LocalLlmupError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalLlmupError";
    this.code = code;
  }
}

/** Invalid external input (CLI args, catalog JSON, API responses, config). */
export class ValidationError extends LocalLlmupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "VALIDATION", options);
    this.name = "ValidationError";
  }
}

/**
 * A model name could not be resolved to a single catalog entry: either no match
 * or an ambiguous one. Carries the candidate ids so callers can surface a
 * "did you mean" list. Extends {@link ValidationError} so generic input-error
 * handling still catches it.
 */
export class ModelResolutionError extends ValidationError {
  readonly candidates: readonly string[];

  constructor(message: string, candidates: readonly string[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelResolutionError";
    this.candidates = candidates;
  }
}

/** Failure interacting with an inference backend (spawn, pull, serve, health). */
export class BackendError extends LocalLlmupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "BACKEND", options);
    this.name = "BackendError";
  }
}

/** Failure reading, writing, or migrating a memory store. */
export class MemoryError extends LocalLlmupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "MEMORY", options);
    this.name = "MemoryError";
  }
}

/** Failure loading, validating, or enriching the model catalog. */
export class CatalogError extends LocalLlmupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CATALOG", options);
    this.name = "CatalogError";
  }
}

/** How a runtime-state operation failed; lets callers react to each case. */
export type StateErrorKind =
  | "io" // filesystem read/write failure
  | "empty" // state file exists but is zero bytes
  | "unparseable" // state file is not valid JSON
  | "invalid" // valid JSON that fails the state schema
  | "locked"; // the lock is held by a live process

/** Failure reading, writing, or locking the runtime state file. */
export class StateError extends LocalLlmupError {
  readonly kind: StateErrorKind;

  constructor(message: string, kind: StateErrorKind, options?: { cause?: unknown }) {
    super(message, "STATE", options);
    this.name = "StateError";
    this.kind = kind;
  }
}
