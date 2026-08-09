import { describe, expect, it } from "vitest";
import {
  CLEANUP_TIMEOUT_MS,
  LOCK_TIMEOUT_MS,
  SIGNAL_EXIT_CODES,
  classifyDownCancellation,
  classifySwitchCancellation,
  classifyUpCancellation,
  exitCodeForSignal,
  formatTermination,
  remediationForPriorStopped,
  remediationForRollbackAttempted,
  remediationForTargetCommittedSourceRetained,
  type CommandTermination,
} from "../../src/tui/cancellation.js";
import { DEFAULT_LOCK_TIMEOUT_MS } from "../../src/state/state.js";

describe("Cancellation constants", () => {
  it("CLEANUP_TIMEOUT_MS is the explicit 30-second default", () => {
    expect(CLEANUP_TIMEOUT_MS).toBe(30_000);
  });

  it("LOCK_TIMEOUT_MS is the explicit 10-second default", () => {
    expect(LOCK_TIMEOUT_MS).toBe(10_000);
  });

  it("LOCK_TIMEOUT_MS equals the state module default", () => {
    expect(LOCK_TIMEOUT_MS).toBe(DEFAULT_LOCK_TIMEOUT_MS);
  });

  it("SIGNAL_EXIT_CODES maps standard signal numbers", () => {
    expect(SIGNAL_EXIT_CODES.SIGHUP).toBe(129);
    expect(SIGNAL_EXIT_CODES.SIGINT).toBe(130);
    expect(SIGNAL_EXIT_CODES.SIGTERM).toBe(143);
  });

  it("SIGNAL_EXIT_CODES is frozen", () => {
    expect(Object.isFrozen(SIGNAL_EXIT_CODES)).toBe(true);
  });
});

describe("exitCodeForSignal", () => {
  it("returns 130 for SIGINT", () => {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
  });

  it("returns 143 for SIGTERM", () => {
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });

  it("returns 129 for SIGHUP", () => {
    expect(exitCodeForSignal("SIGHUP")).toBe(129);
  });

  it("returns undefined for unrecognized reasons", () => {
    expect(exitCodeForSignal("SIGUSR1")).toBeUndefined();
    expect(exitCodeForSignal(undefined)).toBeUndefined();
    expect(exitCodeForSignal(42)).toBeUndefined();
    expect(exitCodeForSignal(null)).toBeUndefined();
  });
});

describe("classifyUpCancellation", () => {
  it("returns unchanged before any mutation", () => {
    const result = classifyUpCancellation("resolve", false, false);
    expect(result).toEqual({ type: "cancelled", phase: "resolve", effect: "unchanged" });
  });

  it("returns artifact_cached_state_unchanged during acquisition", () => {
    const result = classifyUpCancellation("acquire", false, false);
    expect(result).toEqual({
      type: "cancelled",
      phase: "acquire",
      effect: "artifact_cached_state_unchanged",
    });
  });

  it("returns artifact_cached_state_unchanged during verify", () => {
    const result = classifyUpCancellation("verify", false, false);
    expect(result).toEqual({
      type: "cancelled",
      phase: "verify",
      effect: "artifact_cached_state_unchanged",
    });
  });

  it("returns spawned_process_cleaned when new server spawned but not committed", () => {
    const result = classifyUpCancellation("serve", false, true);
    expect(result).toEqual({
      type: "cancelled",
      phase: "serve",
      effect: "spawned_process_cleaned",
    });
  });

  it("returns partial when prior server stopped but replacement failed", () => {
    const result = classifyUpCancellation("serve", true, false);
    expect(result.type).toBe("partial");
    expect(result).toHaveProperty("effect", "prior_server_stopped_replacement_not_started");
    expect(result).toHaveProperty("remediation");
    expect((result as { remediation: string }).remediation).toContain("local-llmup up");
  });

  it("returns success at state-commit even if signal arrives late", () => {
    const result = classifyUpCancellation("state-commit", true, true);
    expect(result).toEqual({ type: "success", phase: "state-commit", effect: "state_committed" });
  });

  it("prioritizes prior_server_stopped over spawned_process_cleaned", () => {
    // Prior stopped + new not spawned → partial
    const result = classifyUpCancellation("prior-cleanup", true, false);
    expect(result.type).toBe("partial");
  });
});

describe("classifyDownCancellation", () => {
  it("returns unchanged before any mutation", () => {
    const result = classifyDownCancellation("locked-revalidate", false);
    expect(result).toEqual({
      type: "cancelled",
      phase: "locked-revalidate",
      effect: "unchanged",
    });
  });

  it("returns state_rollback_attempted when stop fails after state clear", () => {
    const result = classifyDownCancellation("stop-detach", true);
    expect(result.type).toBe("partial");
    expect(result).toHaveProperty("effect", "state_rollback_attempted");
    expect((result as { remediation: string }).remediation).toContain("down");
  });

  it("returns success at stop-detach when no rollback was needed", () => {
    const result = classifyDownCancellation("stop-detach", false);
    expect(result).toEqual({
      type: "success",
      phase: "stop-detach",
      effect: "state_committed",
    });
  });
});

describe("classifySwitchCancellation", () => {
  it("returns unchanged at locked-revalidate", () => {
    const result = classifySwitchCancellation("locked-revalidate");
    expect(result).toEqual({
      type: "cancelled",
      phase: "locked-revalidate",
      effect: "unchanged",
    });
  });

  it("returns artifact_cached during prepare or readiness", () => {
    expect(classifySwitchCancellation("prepare").effect).toBe(
      "artifact_cached_state_unchanged",
    );
    expect(classifySwitchCancellation("readiness").effect).toBe(
      "artifact_cached_state_unchanged",
    );
  });

  it("returns success at state-commit", () => {
    const result = classifySwitchCancellation("state-commit");
    expect(result).toEqual({
      type: "success",
      phase: "state-commit",
      effect: "state_committed",
    });
  });
});

describe("Remediation messages", () => {
  it("remediationForPriorStopped includes the model id and up command", () => {
    const msg = remediationForPriorStopped("llama3:8b");
    expect(msg).toContain("local-llmup up llama3:8b");
    expect(msg).toContain("prior server was stopped");
  });

  it("remediationForRollbackAttempted includes the model and down command", () => {
    const msg = remediationForRollbackAttempted("phi3:mini");
    expect(msg).toContain("phi3:mini");
    expect(msg).toContain("local-llmup down");
  });

  it("remediationForTargetCommittedSourceRetained includes migrate --move", () => {
    const msg = remediationForTargetCommittedSourceRetained();
    expect(msg).toContain("migrate --move");
    expect(msg).toContain("source was retained");
  });
});

describe("formatTermination", () => {
  it("formats success terminations without remediation", () => {
    const t: CommandTermination = {
      type: "success",
      phase: "state-commit",
      effect: "state_committed",
    };
    expect(formatTermination(t)).toContain("Completed successfully");
    expect(formatTermination(t)).toContain("state-commit");
  });

  it("formats cancelled terminations with effect", () => {
    const t: CommandTermination = {
      type: "cancelled",
      phase: "acquire",
      effect: "artifact_cached_state_unchanged",
    };
    expect(formatTermination(t)).toContain("Cancelled");
    expect(formatTermination(t)).toContain("artifact_cached_state_unchanged");
  });

  it("formats partial terminations with exact remediation — never generic success", () => {
    const t: CommandTermination = {
      type: "partial",
      phase: "serve",
      effect: "prior_server_stopped_replacement_not_started",
      remediation: "Run `local-llmup up model` to restore service.",
    };
    const formatted = formatTermination(t);
    expect(formatted).toContain("Partial completion");
    expect(formatted).toContain("local-llmup up model");
    expect(formatted).not.toContain("success");
  });

  it("formats failed terminations with code", () => {
    const t: CommandTermination = {
      type: "failed",
      phase: "readiness",
      effect: "spawned_process_cleaned",
      code: "timeout",
    };
    const formatted = formatTermination(t);
    expect(formatted).toContain("Failed");
    expect(formatted).toContain("timeout");
  });
});

describe("Repeated Ctrl+C safety contract", () => {
  it("CLEANUP_TIMEOUT_MS bounds how long cleanup can delay exit", () => {
    // The cleanup timeout is the explicit upper bound. Any cleanup path
    // that takes longer than this MUST be forcibly restored.
    expect(CLEANUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CLEANUP_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });

  it("LOCK_TIMEOUT_MS prevents indefinite deadlock", () => {
    // Lock timeout prevents waiting forever for a stale/dead holder.
    expect(LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LOCK_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("exit codes never collide with normal success (0) or general error (1)", () => {
    for (const code of Object.values(SIGNAL_EXIT_CODES)) {
      expect(code).toBeGreaterThan(128);
      expect(code).toBeLessThanOrEqual(255);
    }
  });
});
