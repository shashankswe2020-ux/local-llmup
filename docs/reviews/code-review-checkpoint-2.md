# Code Review Checkpoint 2: Task T19 (`down` and `ls` commands)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T19 — the `down` command (lock → read state → optional model match → stop owned / detach attached → clear state) and the `ls` command (read-only state render), plus the CLI wiring for both.
> **Test suite:** 314 tests passing (24 files), typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE

**Overview:** Both commands are small, fully dependency-injected, and meet the T19 acceptance criteria: `down` stops only `ownedByUs` daemons and is an idempotent no-op when nothing is owned; `ls` reflects the state record. No Critical or Important issues. The command's `stop → then clear state` ordering is the *safe* direction (a failure leaves a recoverable record rather than an orphaned process), control-character sanitization is applied on every externally-derived display string, and the lazy `createDefaultDeps()` factory resolves checkpoint‑1 Important #4 (import-time side effects) for these two files. Remaining findings are Minor/Nit: documenting the "detach + forget" semantic for attached daemons, a benign self-healing stale-record window, the `ls` spec gap (active-only vs. "list installed"), and a couple of cosmetic items.

---

## Critical Issues

None.

---

## Important Issues

None.

---

## Minor Issues

### 1. `down` on an attached daemon "detaches + forgets" — document the semantic and confirm it is intended (Focus Q1)
- **File:** `src/commands/down.ts` (attached branch — `deps.writeState(deps.config, createEmptyState())` then `Detached from ...`)
- **Problem:** When the active record is `ownedByUs: false` (a pre-existing daemon `up` attached to), `down` clears the state pointer and leaves the daemon running. This is defensible — local-llmup only manages lifecycles it owns, and the endpoint (`127.0.0.1:<port>`) is rediscoverable by re-running `up` — but it means `ls` immediately reports "No active model" even though a daemon the user was connected to is still serving. There is a small risk of "losing track of a still-serving endpoint" for the duration until the next `up`.
- **Assessment:** Behavior is correct and tested; the concern is UX/semantic clarity, not a defect. The alternative (leave the record intact and refuse to touch it) would prevent the user from ever clearing an attached pointer, which is worse.
- **Fix:** Document the "detach + forget" semantic in the command help text and/or spec so users understand `down` on an attached daemon is a bookkeeping detach, not a stop. Optionally, consider whether `ls` should retain a way to rediscover a known-but-detached endpoint (out of scope for T19).

### 2. Stale dead-daemon record if `writeState` throws after a successful `stop()` (Focus Q2)
- **File:** `src/commands/down.ts` (owned branch — `await deps.adapter.stop(...)` then `deps.writeState(deps.config, createEmptyState())`)
- **Problem:** The intentional decision to *not* clear state when `stop()` throws is correct (the daemon may still be alive, so the record must survive for a retry). However, the reverse window exists: if `stop()` succeeds and `writeState(createEmptyState())` then throws (disk full, permissions, validation), the state file retains an `active` record for a now-dead daemon. During that window `ls` shows a misleading `owned` entry.
- **Assessment:** Low severity and self-healing — a subsequent `down` calls `adapter.stop` on the dead pid, which is idempotent for `ESRCH` (no-op), then clears state. This is strictly less severe than checkpoint‑1 Important #2 (orphaned *owned process*) because no process leaks. The chosen ordering (stop first, clear second) is the safer one and should be preserved.
- **Fix:** Add a one-line comment documenting that the ordering is deliberate (clear only after a confirmed stop) and that the stale-record window is recoverable via the idempotent `stop`. No code change required.

### 3. `ls` shows only the active model, not "installed models" as the spec wording implies
- **File:** `src/commands/ls.ts` (single-row render of `active`)
- **Problem:** The spec describes `ls` as "List installed models + which is active (from state)." Because the `BackendAdapter` exposes no "list installed models" capability, `ls` renders only the single active state record (and "No active model." when empty). This satisfies the T19 acceptance ("`ls` reflects state") but under-delivers on the broader spec wording; a user may expect a catalog of installed models.
- **Fix:** Track a follow-up to add a backend "list installed" capability, and until then adjust the command help text to say it reports the active server (not an install inventory) so expectations match behavior.

### 4. `down <model>` skips model resolution/validation when no server is active
- **File:** `src/commands/down.ts` (the `active === null` short-circuit precedes the `options.model` resolve block)
- **Problem:** `down some-typo-model` with no active server prints "No active server to stop." and never resolves/validates the argument, whereas the same argument with an active server would surface `ModelResolutionError`/`ValidationError`. The feedback for the identical input differs based on unrelated state.
- **Assessment:** Acceptable — there is genuinely nothing to stop, so the no-op is defensible and avoids doing catalog I/O in the empty case. Flagged only for the inconsistency.
- **Fix:** Optional. If consistent feedback is desired, resolve `options.model` before the `active === null` check; otherwise leave as-is and document that the no-active short-circuit wins.

---

## Nits

### 1. `down` hardcodes `ownedByUs: true` when building the `ServeHandle`
- **File:** `src/commands/down.ts` (owned branch — `{ endpoint: active.endpoint, pid: active.pid, port: active.port, ownedByUs: true }`)
- Inside `if (active.ownedByUs)` the literal `true` is correct but redundant. Passing `active.ownedByUs` (or constructing the handle directly from the `active` fields) reads more clearly and keeps the handle in lockstep with the record it derives from.

### 2. `down` no-op status routed to stdout
- **File:** `src/commands/down.ts` (`deps.write("No active server to stop.\n")`)
- The "No active server to stop." status goes to stdout. It is consistent with the other `down` status lines (`Stopped`/`Detached`) also on stdout, so this is a judgment call; noting it only because these are status/diagnostic messages rather than result *data*. Fine to leave for consistency.

---

## What's Done Well

- **Safe teardown ordering:** In the owned branch, state is cleared **only after** `stop()` resolves. A failure therefore leaves a recoverable record rather than orphaning an owned process — the correct direction, and it is explicitly tested (BackendError propagates, state preserved).
- **Idempotency is real and tested:** No-active → no-op; two consecutive `down` invocations stop once and leave state null; the attached case never calls `stop`. All exercised against the real state layer (temp home + real `withLock`/`readState`/`writeState`) with only the adapter faked — high-fidelity coverage.
- **Consistent sanitization:** Every externally-derived display string is `stripControl`'d — `label`/`endpoint` in `down`, and every cell in `ls` via `renderTable` — and CLI-level error handlers `stripControl` messages before writing to stderr.
- **Lazy default deps:** Both files use a `createDefaultDeps()` factory invoked as a default parameter, so `loadConfig()`/`new OllamaAdapter()` run only when the command actually executes — resolving checkpoint‑1 Important #4 for these commands and keeping imports side-effect-free.
- **Clean stdout/stderr split:** Result/status → stdout; errors → stderr with an exit code, wired uniformly in `registerDown`/`registerLs`.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | No-active no-op, owned stop + clear, attached detach + clear, `down <model>` match/mismatch, BackendError propagation with state preserved, idempotency across two runs; `ls` empty/owned/attached/fresh-home. Real state layer, faked adapter. |
| Build verified | ✅ | `tsc` clean; `tsc --noEmit` clean. |
| Lint | ✅ | `eslint .` clean. |
| Security checked | ✅ | `stripControl` on all displayed model/endpoint strings and every table cell; error messages sanitized at CLI; unsanitized `active.endpoint` correctly passed only to `adapter.stop` (not displayed); `stop` guarded against the `kill(0)` group-signal footgun (ties to open checkpoint‑1 item #1). |
| Concurrency | ✅ | `down` mutates under `withLock`; `ls` is lock-free but safe — atomic temp+rename writes mean `readState` sees a complete old or new file, never a torn read (Focus Q3: no torn read possible). |
| Coverage | ✅ | Both commands' paths well covered. The `writeState`-fails-after-`stop` window (Minor #2) is untested but benign/self-healing. |

---

## Open items carried from Checkpoint 1

| # (ckpt 1) | Priority | Status | Relevance to T19 |
|---|----------|--------|------------------|
| 1 | Important | Open | `down`/`stop` still rely on the `ownedByUs && pid > 0` guard rather than a schema-enforced invariant; discriminated-union `ServerState` would make `down`'s owned branch safe by construction. |
| 2 | Important | Open (up.ts) | Not in T19 scope; T19's `down` uses the symmetric-but-safer ordering. |
| 4 | Important | Resolved for T19 | `down`/`ls` use the lazy `createDefaultDeps()` factory. `up.ts` may still carry the module-level constant. |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Minor | Document `down`'s "detach + forget" semantic for attached daemons (help/spec) | backlog |
| 2 | Minor | Comment the deliberate stop→clear ordering and note the recoverable stale-record window | backlog |
| 3 | Minor | `ls` reports active-only; track a backend "list installed" capability and align help text | backlog |
| 4 | Minor | Consider resolving `down <model>` before the no-active short-circuit for consistent feedback | backlog |
| 5 | Nit | Use `active.ownedByUs` instead of hardcoded `true` in the `ServeHandle` construction | backlog |
| 6 | Nit | Reconsider stdout vs. stderr for the `down` no-op status line | backlog |

---

### On the focus questions

1. **Attached "detach + forget"** — Correct and low-risk. The state is a single-slot pointer to a rediscoverable local endpoint; forgetting an unowned daemon is the right scope (local-llmup manages only what it owns). Document the semantic so `ls` showing nothing afterward is not surprising. (Minor #1)
2. **State not cleared when `stop()` throws** — Correct. Keeping the record on failure allows a retry to find the (possibly still-alive) daemon. The only inconsistency window is the reverse (stop succeeds, `writeState` fails), which is benign and self-heals via the idempotent `ESRCH` no-op. (Minor #2)
3. **Lock-free `ls`** — Acceptable. Atomic temp+rename writes guarantee `readState` observes a complete file; no torn read is possible, so a lock would add nothing. (No finding.)
4. **Error handling / ordering / routing** — Ordering is the safe direction; stdout/stderr split is correct; sanitization is consistent. Only the Minor/Nit items above.
