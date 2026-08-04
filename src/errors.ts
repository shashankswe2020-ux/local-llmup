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
