/**
 * Cancellation/compensation model for lifecycle commands.
 *
 * Provides typed termination effects, explicit timeout constants, signal-exit
 * semantics, and remediation reporting for partial completion states.
 */

import { DEFAULT_LOCK_TIMEOUT_MS } from "../state/state.js";

// ─── Explicit timeout constants ────────────────────────────────────────────

/** Maximum milliseconds for terminal cleanup on signal before forced restore. */
export const CLEANUP_TIMEOUT_MS = 30_000;

/** Maximum milliseconds to wait for the state lock before throwing `locked`. */
export const LOCK_TIMEOUT_MS: number = DEFAULT_LOCK_TIMEOUT_MS;

/** Signal-to-exit-code mapping (128 + signal number). */
export const SIGNAL_EXIT_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const);

export type CancellationSignal = keyof typeof SIGNAL_EXIT_CODES;

// ─── Command effect vocabulary ─────────────────────────────────────────────

export type CommandEffect =
  | "unchanged"
  | "artifact_cached_state_unchanged"
  | "spawned_process_cleaned"
  | "prior_server_stopped_replacement_not_started"
  | "state_rollback_attempted"
  | "state_committed"
  | "target_committed_source_retained"
  | "fully_completed";

// ─── Command termination union ─────────────────────────────────────────────

export type CommandTermination =
  | {
      readonly type: "success";
      readonly phase: string;
      readonly effect: "unchanged" | "state_committed" | "fully_completed";
    }
  | {
      readonly type: "cancelled";
      readonly phase: string;
      readonly effect:
        | "unchanged"
        | "artifact_cached_state_unchanged"
        | "spawned_process_cleaned";
    }
  | {
      readonly type: "partial";
      readonly phase: string;
      readonly effect:
        | "prior_server_stopped_replacement_not_started"
        | "state_rollback_attempted"
        | "target_committed_source_retained";
      readonly remediation: string;
    }
  | {
      readonly type: "failed";
      readonly phase: string;
      readonly effect: CommandEffect;
      readonly code: string;
    };

// ─── Remediation messages ──────────────────────────────────────────────────

export function remediationForPriorStopped(modelId: string): string {
  return `The prior server was stopped but its replacement failed to start. Run \`local-llmup up ${modelId}\` to restore service.`;
}

export function remediationForRollbackAttempted(modelId: string): string {
  return `State was cleared but stopping ${modelId} failed; state was restored. Inspect the process manually or retry \`local-llmup down\`.`;
}

export function remediationForTargetCommittedSourceRetained(): string {
  return `Migration target is valid; source was retained. Re-run \`local-llmup migrate --move\` to complete source deletion.`;
}

// ─── Signal-safe lifecycle cancellation ────────────────────────────────────

/**
 * Compute the exit code for a successfully-cleaned cancellation by signal.
 * Returns undefined if the abort reason is not a recognized signal name.
 */
export function exitCodeForSignal(reason: unknown): number | undefined {
  if (typeof reason === "string" && reason in SIGNAL_EXIT_CODES) {
    return SIGNAL_EXIT_CODES[reason as CancellationSignal];
  }
  return undefined;
}

/**
 * Determine the CommandTermination for cancellation at a given phase, based on
 * what effects have occurred so far in the up lifecycle.
 */
export function classifyUpCancellation(
  phase: string,
  priorServerStopped: boolean,
  newServerSpawned: boolean,
): CommandTermination {
  // After state commit, treat as success even if signal arrived late.
  if (phase === "state-commit") {
    return { type: "success", phase, effect: "state_committed" };
  }
  // If prior server was stopped but replacement not yet committed:
  if (priorServerStopped && !newServerSpawned) {
    return {
      type: "partial",
      phase,
      effect: "prior_server_stopped_replacement_not_started",
      remediation: remediationForPriorStopped("the target model"),
    };
  }
  // If a new server was spawned but not yet committed, it should be cleaned.
  if (newServerSpawned) {
    return { type: "cancelled", phase, effect: "spawned_process_cleaned" };
  }
  // During acquisition, artifact may remain in cache.
  if (phase === "acquire" || phase === "verify") {
    return { type: "cancelled", phase, effect: "artifact_cached_state_unchanged" };
  }
  // Before any mutation.
  return { type: "cancelled", phase, effect: "unchanged" };
}

/**
 * Determine the CommandTermination for cancellation at a given phase
 * in the down lifecycle.
 */
export function classifyDownCancellation(
  phase: string,
  stateClearedButStopFailed: boolean,
): CommandTermination {
  if (stateClearedButStopFailed) {
    return {
      type: "partial",
      phase,
      effect: "state_rollback_attempted",
      remediation: remediationForRollbackAttempted("the active model"),
    };
  }
  if (phase === "stop-detach") {
    return { type: "success", phase, effect: "state_committed" };
  }
  return { type: "cancelled", phase, effect: "unchanged" };
}

/**
 * Determine the CommandTermination for cancellation at a given phase
 * in the switch lifecycle.
 */
export function classifySwitchCancellation(phase: string): CommandTermination {
  if (phase === "state-commit") {
    return { type: "success", phase, effect: "state_committed" };
  }
  if (phase === "prepare" || phase === "readiness") {
    return { type: "cancelled", phase, effect: "artifact_cached_state_unchanged" };
  }
  return { type: "cancelled", phase, effect: "unchanged" };
}

/**
 * Format a CommandTermination into an exact, user-facing status string.
 * Never collapses partial work into generic success.
 */
export function formatTermination(termination: CommandTermination): string {
  switch (termination.type) {
    case "success":
      return `Completed successfully at phase: ${termination.phase}`;
    case "cancelled":
      return `Cancelled at phase: ${termination.phase} (effect: ${termination.effect})`;
    case "partial":
      return `Partial completion at phase: ${termination.phase} — ${termination.remediation}`;
    case "failed":
      return `Failed at phase: ${termination.phase} (${termination.code}; effect: ${termination.effect})`;
  }
}
