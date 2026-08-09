# Security Audit Report #25

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 8 August 2026
> **Scope:** Current uncommitted U1c implementation only: `src/immutable.ts`, `src/tui/types.ts`, `src/tui/presenter.ts`, `src/tui/read-only-view-models.ts`, `src/tui/sanitize.ts`, `src/commands/recommend.ts`, `src/commands/can-run.ts`, `src/commands/catalog.ts`, `src/commands/doctor.ts`, `src/commands/ls.ts`, `src/ranking/fit.ts`, `src/advisor/verdict.ts`, and their U1c tests.
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 5     |
| Low      | 1     |
| Info     | 0     |

---

## Findings

### [MEDIUM-1] Malformed driver review decisions fail open into execution

- **Location:** `src/tui/presenter.ts:199-207`
- **Description:** The presenter trusts the TypeScript `UiReviewDecision` union at runtime. It checks only the known `cancelled` and `back` values; every other object falls through to `controller.execute()`. A buggy or JavaScript driver returning `{ type: "corrupt" }` therefore acts like acceptance. The same boundary does not schema-validate the overall `choose()` response before reading or returning it.
- **Impact:** A destructive controller can execute without a valid affirmative review decision. This defeats the fail-closed confirmation boundary for later `up`, `switch`, `down`, and `migrate` controllers.
- **Recommendation:** Strictly runtime-parse every driver response before branching. Use a discriminated union schema for exactly `accepted`, `back`, and `cancelled`; reject unknown keys and unknown discriminants. Branch exhaustively so only the exact parsed `accepted` variant can reach `execute()`. Add hostile-driver tests for unknown, null, missing-value, and extra-key responses.

### [MEDIUM-2] Mutable choice requests permit a post-check membership bypass

- **Location:** `src/tui/presenter.ts:181-195`
- **Description:** The presenter derives `actionable` as references to the controller's request items, then passes those same mutable runtime objects and array to `ui.choose()`. A buggy driver can mutate an item's `id` before returning it. Because the membership check reads the mutated objects, a previously unrequested identifier passes validation. A runtime probe changed `safe` to `../../unsafe;target`; the presenter accepted and returned the new identifier.
- **Impact:** A driver can substitute a command target after the presenter checks the request. If a controller relies on the advertised restricted-driver contract, the substituted identifier can select an unintended model or destructive target.
- **Recommendation:** Before awaiting the driver, runtime-validate the request, copy primitive allowed IDs into an immutable `Set<string>`, and pass a deep-frozen independent request snapshot. Validate the returned decision against the pre-await set, not mutable request objects. Add a regression where the driver mutates the item array and item IDs.

### [MEDIUM-3] Abort state masks cleanup and domain failures as successful cancellation

- **Location:** `src/tui/presenter.ts:219-227`
- **Description:** The catch block returns `cancelled` whenever `signal.aborted` is true, regardless of the rejected error. An integrity, rollback, state-commit, or cleanup failure racing with cancellation is therefore suppressed; `ui.fail()` is not called and the original error does not propagate. The existing test explicitly proves this broad behavior with an arbitrary `Error("aborted")`, rather than a typed cancellation error.
- **Impact:** The CLI can report ordinary cancellation even though cleanup failed or an irreversible/partial effect occurred. Operators may assume state is unchanged and omit required remediation.
- **Recommendation:** Treat only a typed cancellation/abort error as cancellation. Preserve cleanup, integrity, state, and other domain errors even when the signal is aborted, with cleanup failure taking precedence. Return an explicit termination/effect result for partial operations. Add races for abort plus cleanup failure, abort plus state-commit failure, and abort after irreversible effect.

### [MEDIUM-4] Restricted UI boundary is enforced only by erased TypeScript types

- **Location:** `src/tui/presenter.ts:196`, `src/tui/presenter.ts:212-215`, `src/tui/types.ts:322-327`
- **Description:** `UiControllerDriver` restricts the controller at compile time, but the presenter spreads the controller-supplied review request directly into the full driver and sends the completion view model without strict runtime validation or projection. Extra runtime properties, unsanitized strings forged through casts/JavaScript, or capability-bearing objects can cross into the UI despite not appearing in the interface. Branding `TerminalText` and `SafeActionId` does not survive at runtime.
- **Impact:** A buggy in-process controller or completion adapter can leak backend, filesystem, state, path, token, or process capabilities/data to the UI and can reintroduce terminal-control content outside the intended sanitizer boundary.
- **Recommendation:** Define strict runtime schemas for review requests and each command view model. Reconstruct allowlisted plain-data DTOs rather than spreading controller objects, reject unknown keys, verify terminal text invariants, deep-clone/freeze the projected value, and reject non-plain objects/functions/symbols. Add tests that inject extra adapter/config/path/auth fields and forged unsanitized branded strings.

### [MEDIUM-5] Progress bridge forwards unbounded event floods without coalescing

- **Location:** `src/tui/presenter.ts:73-145`
- **Description:** The progress state machine validates individual events, but every valid progress or message event is synchronously forwarded to `ui.emit()`. There is no per-generation event/message bound, byte budget, or progress coalescing at the presenter boundary. A buggy controller can emit an arbitrarily large number of monotonic events while staying valid.
- **Impact:** Event floods can monopolize the event loop, grow renderer state/queues, obscure final transitions, and make cancellation appear unresponsive. This violates the specified bounded/coalesced progress contract.
- **Recommendation:** Coalesce replaceable progress updates to at most 30 frames per second, enforce bounded message count/bytes with the existing terminal-message limits, reserve delivery for terminal phase transitions, and stop accepting events immediately on abort or generation change. Add a high-volume test that proves bounded driver calls and retained state.

### [LOW-1] View-model collections have no aggregate resource bound

- **Location:** `src/tui/read-only-view-models.ts:134-182`, `src/tui/read-only-view-models.ts:234-282`
- **Description:** Individual strings are bounded, but recommendation rows, catalog rows, GPUs, capabilities, quantizations, sources, and MLX files are mapped without count or aggregate-byte limits. The catalog and hardware schemas used upstream also leave several arrays unbounded. A locally corrupted or unexpectedly large validated payload can therefore create a very large immutable snapshot before a renderer's frame limit is applied.
- **Impact:** Memory and CPU exhaustion are possible during clone, sanitization, freezing, and rendering. Exploitation requires control of local catalog/driver data, so impact is limited.
- **Recommendation:** Add explicit schema maxima and view-model caps aligned with the supported 1,000-row target, cap nested collections, compute an aggregate DTO budget before cloning, and fail closed or expose a typed truncation summary. Add boundary tests at and above every count/byte cap.

---

## Positive Observations

- Terminal text sanitization visibly escapes C0/C1 controls, bidi/default-ignorable characters, line separators, and invalid surrogates; it applies byte, column, frame, input, and retained-message limits.
- Canonical model identifiers are separated from display text, and command handoff is withheld when the model ID fails the process-argument allowlist or contains a `..` path segment.
- Read-only view models project plain data rather than backend adapters, filesystem APIs, state readers, process handles, model paths, or auth tokens.
- Command result snapshots are independently cloned and deeply frozen, preventing ordinary source-object mutation after construction.
- Unknown throughput remains unknown and cannot become an affirmative `yes` verdict.
- The focused U1c suite passes all 155 tests, type checking passes, production dependencies have zero known vulnerabilities, sensitive environment files are ignored, and no `.env` or `tokens.json` history was found.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| 1 | Medium | Malformed review decision executes | Strictly runtime-parse decisions and require exact acceptance |
| 2 | Medium | Choice membership TOCTOU | Snapshot/freeze requests and validate against a pre-await ID set |
| 3 | Medium | Abort masks cleanup/domain failures | Distinguish typed cancellation and preserve failure precedence |
| 4 | Medium | Type-only restricted driver boundary | Strictly project and runtime-validate all UI-bound DTOs |
| 5 | Medium | Unbounded progress flood | Coalesce and cap events/messages while retaining final transitions |
| 6 | Low | Unbounded aggregate view models | Cap rows, nested collections, and total DTO size |
