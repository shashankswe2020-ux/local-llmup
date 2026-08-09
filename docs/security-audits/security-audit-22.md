# Security Audit Report #22

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 8 August 2026
> **Scope:** Security audit of the implementation plan in docs/specs/terminal-user-interface.md, focused on terminal injection safety, mode/flag validation fail-closed behavior, cancellation/cleanup safety, snapshot revalidation/race conditions, and Ink/React dependency risk.
> **Dependencies:** 6 known vulnerabilities (`npm audit` result, dev toolchain only); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 1     |
| Medium   | 4     |
| Low      | 0     |
| Info     | 1     |

---

## Findings

### [HIGH-1] Cancellation cleanup has no mandatory hard timeout/escalation contract

- **Location:** `docs/specs/terminal-user-interface.md:1057`
- **Description:** The plan requires waiting for cleanup after Ctrl+C and forbids bypassing cleanup, but it does not require a bounded cleanup deadline and deterministic escalation path if a backend operation hangs while handling cancellation.
- **Impact:** A hung cleanup path can keep the command in a non-terminating state, potentially with runtime/state locks held, blocking operator recovery and follow-up safety actions.
- **Proof of concept:** Start `up` against a backend stub that never resolves its cancellation path. Trigger Ctrl+C during `serve` or `readiness`; command remains in cancelling state indefinitely without guaranteed bounded exit.
- **Recommendation:** Add a required per-phase cleanup deadline and escalation matrix, for example: restore terminal immediately, enforce `CLEANUP_TIMEOUT_MS`, perform ownership-safe best-effort stop, release locks in `finally`, then exit with `partial` + remediation if cleanup deadline is exceeded.

### [MEDIUM-1] Printed next-command handoff can become shell-injection copy/paste risk

- **Location:** `docs/specs/terminal-user-interface.md:542`
- **Description:** The plan prints exact next commands (for example `local-llmup up <id>`) but does not require shell-safe quoting for model identifiers in displayed handoff commands.
- **Impact:** If a malformed model id reaches display (catalog regression, corrupted state, or future schema relaxation), copied commands could execute unintended shell syntax.
- **Recommendation:** Require command handoff to be rendered as argv-safe tokens with strict identifier validation. If any identifier fails the model-id allowlist, do not print executable command text; print a diagnostic with escaped value.

### [MEDIUM-2] Mode incompatibility failures require stable reason codes but no normative enum

- **Location:** `docs/specs/terminal-user-interface.md:349`
- **Description:** The plan requires `--tui` incompatibilities to fail with stable reason codes, but no explicit `TuiIneligibilityCode` enum/contract is defined.
- **Impact:** Different commands can drift into inconsistent fail-open/fallback behavior, weakening guarantees that incompatible requests always fail before side effects.
- **Recommendation:** Define and freeze a typed reason-code enum (for example `not_tty`, `term_dumb`, `ci`, `undersize`, `json_conflict`, `pipe_conflict`, `renderer_init_failed`) and require exhaustive mapping tests for every mode-table branch.

### [MEDIUM-3] Lock ordering and lock timeout policy is not explicit for cross-command race paths

- **Location:** `docs/specs/terminal-user-interface.md:846`
- **Description:** The plan mandates locked revalidation, but it does not define global lock ordering/timeouts across concurrent `up`, `switch`, `down`, and `migrate` flows.
- **Impact:** Concurrent operations may deadlock or starve under contention, degrading availability and increasing partial-operation risk.
- **Recommendation:** Define a global lock acquisition order and bounded lock wait policy with deterministic error code (`state-race` or `timeout`) and mandatory release/rollback behavior.

### [MEDIUM-4] Ink/React supply-chain controls are strong but missing a required CI enforcement gate

- **Location:** `docs/specs/terminal-user-interface.md:926`
- **Description:** The plan requests manual dependency review and no postinstall/native artifacts, but does not require CI-enforced policy checks that fail builds on script/native/provenance violations for the runtime dependency graph.
- **Impact:** Future lockfile drift can silently introduce risky transitive behavior despite initial approval.
- **Recommendation:** Add a mandatory CI gate that verifies runtime dependency graph invariants: no install scripts, no native addons/binaries, license allowlist, SBOM/provenance check, and `npm audit --omit=dev` must remain zero.

### [INFO-1] Terminal sanitizer assurance would benefit from property-based fuzzing

- **Location:** `docs/specs/terminal-user-interface.md:1130`
- **Description:** The fixture matrix is strong, but there is no explicit property/fuzz test requirement for sanitizer invariants.
- **Impact:** Edge cases in combined Unicode/control-byte payloads may be missed by fixed vectors.
- **Recommendation:** Add property tests proving sanitizer output invariants: no control bytes, bounded UTF-8 length, grapheme-safe truncation, and idempotence under repeated sanitization.

---

## Positive Observations

- The plan already includes robust fail-closed intent in key areas: lazy renderer loading, explicit mode precedence, typed confirmation snapshots, locked revalidation, and terminal content sanitization with explicit bounds.
- The plan explicitly preserves noninteractive/plain/JSON contracts and avoids side-effect re-execution after renderer failures.
- Runtime dependency decisions are already gated by explicit human approval and U0 validation criteria.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                              | Recommendation |
| --- | -------- | ---------------------------------------------------- | -------------- |
| 1   | High     | Unbounded cancellation cleanup path                  | Add cleanup timeout + escalation + deterministic partial exit contract |
| 2   | Medium   | Command handoff copy/paste injection risk            | Enforce argv-safe rendering and strict id validation for printed commands |
| 3   | Medium   | Missing normative ineligibility reason-code contract | Add frozen enum + exhaustive mode-table mapping tests |
| 4   | Medium   | Lock ordering/timeout undefined under contention     | Define global lock order + bounded lock wait + deterministic fail path |
| 5   | Medium   | Dependency policy lacks mandatory CI enforcement     | Add CI graph-policy gate for scripts/native/licenses/provenance/audit |
