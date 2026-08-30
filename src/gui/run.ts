/**
 * Server-owned chat run coordinator (task 32.2).
 *
 * The GUI server owns run identity, cancellation, and terminal-state
 * transitions rather than trusting the client. Each run has a unique id and an
 * {@link AbortController} whose signal is threaded through the harness, backend,
 * and agent tool loop. One run may be active per session at a time; a second
 * concurrent start fails closed with a typed {@link RunConflictError}.
 *
 * A run reaches exactly one terminal phase: `completed`, `cancelled`, or
 * `failed`. Once cancelled, a late completion cannot append an assistant
 * message — {@link RunCoordinator.settle} refuses to move a non-active run.
 */
import { LocalLlmupError } from "../errors.js";

/** Raised when a run is started while another is already active. Maps to HTTP 409. */
export class RunConflictError extends LocalLlmupError {
  constructor(message = "a run is already active for this session") {
    super(message, "RUN_CONFLICT");
    this.name = "RunConflictError";
  }
}

export type RunPhase = "active" | "completed" | "cancelled" | "failed";

export interface Run {
  readonly id: string;
  readonly controller: AbortController;
  phase: RunPhase;
}

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run_${Date.now().toString(36)}_${runCounter.toString(36)}`;
}

export class RunCoordinator {
  private activeRun: Run | null = null;

  /** The run currently accepting output, or `null` when idle. */
  get active(): Run | null {
    return this.activeRun;
  }

  /**
   * Begin a new run. Throws {@link RunConflictError} when another run is still
   * active, so callers can return a typed conflict before opening a stream.
   */
  begin(): Run {
    if (this.activeRun !== null && this.activeRun.phase === "active") {
      throw new RunConflictError();
    }
    const run: Run = { id: nextRunId(), controller: new AbortController(), phase: "active" };
    this.activeRun = run;
    return run;
  }

  /**
   * Cancel the active run (optionally guarded by id). Aborts its signal and
   * moves it to `cancelled`. Idempotent and safe to call after a run settled.
   */
  cancel(id?: string): boolean {
    const run = this.activeRun;
    if (run === null || run.phase !== "active") {
      return false;
    }
    if (id !== undefined && run.id !== id) {
      return false;
    }
    run.phase = "cancelled";
    run.controller.abort();
    this.activeRun = null;
    return true;
  }

  /**
   * Move a still-active run to a non-cancelled terminal phase. Returns `false`
   * when the run was already cancelled or settled, which is the late-completion
   * guard: a caller must not append output for a run it did not settle.
   */
  settle(run: Run, phase: "completed" | "failed"): boolean {
    if (run.phase !== "active") {
      return false;
    }
    run.phase = phase;
    if (this.activeRun === run) {
      this.activeRun = null;
    }
    return true;
  }

  /** Whether a run may still emit output (active and not aborted). */
  isActive(run: Run): boolean {
    return run.phase === "active" && !run.controller.signal.aborted;
  }
}
