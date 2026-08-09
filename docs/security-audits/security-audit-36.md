# Security Audit Report #36

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** TUI cancellation/compensation model (`src/tui/cancellation.ts`, `src/state/state.ts` DEFAULT_LOCK_TIMEOUT_MS export, `tests/tui/cancellation.test.ts`)
> **Dependencies:** 6 known vulnerabilities (all in devDependencies: vite/vitest/esbuild — no production exposure)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 1     |
| Info     | 2     |

---

## Findings

### [LOW-1] CLEANUP_TIMEOUT_MS (30s) allows delayed exit on repeated Ctrl+C

- **Location:** `src/tui/cancellation.ts:13`
- **Description:** The `CLEANUP_TIMEOUT_MS` constant is 30 seconds. If a future consumer blocks the process exit for this entire duration during cleanup (e.g., waiting for a network call or process teardown), the user is unable to forcibly exit without sending SIGKILL from another terminal. This is a mild availability concern—not exploitable remotely, but a user-experience denial-of-service if cleanup code hangs.
- **Impact:** A user sending repeated SIGINT/SIGTERM may experience up to 30 seconds of unresponsive CLI before forced exit occurs. No data loss or privilege escalation.
- **Recommendation:** Document that the consuming code MUST install a second-signal handler that calls `process.exit(exitCodeForSignal(signal))` immediately on the second identical signal, bypassing the cleanup timeout. Example pattern:

```typescript
let signalCount = 0;
const handler = (sig: string) => {
  signalCount++;
  if (signalCount >= 2) process.exit(exitCodeForSignal(sig) ?? 1);
  // ...normal cleanup with CLEANUP_TIMEOUT_MS deadline...
};
```

The test already asserts the bound (`CLEANUP_TIMEOUT_MS <= 300_000`), but a tighter contract of "second signal = immediate exit" should be enforced in the TUI integration layer.

---

### [INFO-1] Remediation messages embed user-controlled model IDs without escaping

- **Location:** `src/tui/cancellation.ts:70-78`
- **Description:** `remediationForPriorStopped(modelId)` and `remediationForRollbackAttempted(modelId)` interpolate the model ID into a remediation string. If these strings were ever rendered in a web context (HTML, Markdown renderer with JS execution), a crafted model ID could inject content. However, in the current architecture these messages are printed to a terminal via stdout, where injection is not exploitable.
- **Impact:** None in current usage (CLI terminal output). Informational for future-proofing if remediation messages are ever surfaced in a web UI or rendered HTML.
- **Recommendation:** No action required now. If these messages are ever rendered in HTML, apply output encoding. The existing Zod validation on model IDs (`z.string().min(1)`) in the catalog schema already constrains the character set for legitimate models.

---

### [INFO-2] Lock timeout is exposed as a module-level constant but not user-configurable

- **Location:** `src/state/state.ts:224`, `src/tui/cancellation.ts:16`
- **Description:** `DEFAULT_LOCK_TIMEOUT_MS` (10s) is a hardcoded constant. It cannot be exploited for DoS because: (1) the lock is a local file protected by filesystem permissions (`0o600`), (2) only the current user can create/hold the lock, and (3) stale locks from dead processes are automatically reclaimed via the `reclaimStaleLock` mechanism. An attacker with local access could theoretically hold the lock to block CLI operations for up to 10 seconds, but that requires same-user filesystem access (at which point the attacker already has full control).
- **Impact:** None beyond normal single-user CLI semantics.
- **Recommendation:** No change needed. The current design is correct: bounded timeout + stale-lock reclaim + atomic rename-based reclaim prevents both deadlock and double-entry.

---

## Positive Observations

- **Pure function design:** The entire `cancellation.ts` module is stateless — no side effects, no I/O, no process manipulation. Classification functions are pure data transformers, eliminating race conditions by construction.
- **Signal exit codes are frozen:** `Object.freeze` prevents runtime mutation of the signal-to-exit-code mapping.
- **Type-safe discrimination:** The `CommandTermination` discriminated union makes it impossible to represent inconsistent states (e.g., a "success" with a remediation message).
- **Lock safety:** The `withLock` implementation uses `O_EXCL` atomic creation, PID-based liveness checks, and rename-based reclaim — a textbook correct advisory lock for single-host CLI tools.
- **Test contract enforcement:** The test suite explicitly asserts upper bounds on timeouts (`CLEANUP_TIMEOUT_MS <= 300_000`, `LOCK_TIMEOUT_MS <= 60_000`), preventing accidental regressions that could introduce availability issues.
- **No signal handler registration in the module:** The cancellation module defines semantics but does NOT call `process.on('SIGINT', ...)` itself, delegating signal registration to the TUI integration layer. This avoids global side effects on import.

---

## Security Questions Answered

| Question | Answer |
| --- | --- |
| Can repeated signals bypass ownership checks or force unsafe exit? | **No.** The module does not register signal handlers. It only classifies termination state. The consuming layer must implement the handler, and ownership checks are in `state.ts` (PID + executable + start time validation). |
| Are there injection vectors in remediation messages? | **Not exploitable.** Messages are terminal-only strings. Model IDs are Zod-validated at catalog load time. |
| Can the lock timeout be exploited for DoS? | **No.** 10s bounded timeout + stale-lock reclaim + same-user-only filesystem access. |
| Is signal handling safe from race conditions? | **Yes by design.** The module is pure; no mutable state, no I/O, no signal registration. Race conditions are structurally impossible in this layer. |

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
| --- | --- | --- | --- |
| 1 | Low | Cleanup timeout allows 30s blocked exit | Enforce second-signal immediate exit in TUI integration layer |
| 2 | Info | Remediation messages interpolate model IDs | No action; apply encoding if ever rendered as HTML |
| 3 | Info | Lock timeout not user-configurable | No action; design is correct |
