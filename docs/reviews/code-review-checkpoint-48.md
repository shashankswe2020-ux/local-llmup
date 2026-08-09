# Code Review Checkpoint 48: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (final checkpoint-47 remediation review for lifecycle observer faults, event order, switch filtering, omitted-model failures, empty targets, and output compatibility)
> **Test suite:** 1,363 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real llama.cpp prepare/execute up/down smoke reported passing

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The checkpoint-47 false-positive observer test is corrected, all three command suites now prove exact successful-path event order while throwing observers cannot alter domain success, omitted-model `up` and `switch` renderer failures fail before preparation, and switch filtering/empty-target behavior is directly covered. The remaining renderer-fault contract and its regression matrix are still incomplete: runtime render failures are silently swallowed rather than transitioned to the specified restored plain-progress mode, pre-execution progress mount/emit faults do not consistently emit the required notice, and the claimed exact warning assertions remain substring checks.

---

## Critical Issues

None.

## Important Issues

### 1. Complete the renderer-fault state transition and assert exact output contracts

- **File:** `src/tui/lifecycle-entry.ts:530`
- **Problem:** The three synthetic `up` progress emissions and progress mounting occur before domain execution without a renderer-fault boundary; a throw there escapes as a raw command error rather than restoring and writing the exact `renderer_pre_execution` notice. Once execution starts, `executePreparedUp()`, `executePreparedSwitch()`, and `executePreparedDown()` catch observer exceptions internally, so the lifecycle presenter cannot detect a failed renderer, unmount it, emit the exact one-time `renderer_runtime` notice, or switch subsequent events to bounded plain stderr progress as required by the TUI failure matrix. The new committed-output test now genuinely calls a throwing observer, but only for `down`, and it asserts neither notice nor fallback progress. Omitted-model tests use `toContain("renderer_pre_execution")`, and the fit-warning test still uses `toContain(...)` without the `up: ` prefix, continuation text, or terminal newline; therefore the request's “exact warning text” claim is not established. Mount/review/picker rejection and equivalent committed-output behavior for `up` and `switch` also remain untested, so issue #165's checkpoint-47 action is only partially resolved.
- **Fix:** Add one lifecycle presentation fault boundary that tracks pre-execution versus in-flight/committed state. Before `execute()`, catch renderer load/mount/review/picker/synthetic-emit failures, restore/unmount once, write exactly `local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n`, and perform no domain call. During execution, let observer delivery report failure to that boundary (without affecting the command), unmount once, write exactly `local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n`, route later progress to bounded plain stderr, and preserve exactly one authoritative stdout result after commit. Table-test `up`/`switch`/`down` mount, emit, unmount, and rejection faults; use equality assertions for complete stderr/stdout strings. Change the fit-warning assertion to equality against `up: requested quant Q4_K_M for llama3.1:8b may not fit this hardware (ram-bound); continuing because it was explicitly requested\n`.

## Suggestions

None.

## What's Done Well

- The lifecycle-entry regression now invokes the observer passed to `execute()` and proves both the throwing `emit()` and throwing cleanup path cannot suppress committed stdout.
- `up`, `switch`, and `down` command tests collect exact successful-path events from real orchestration boundaries, deliberately throw on every observer call, and still verify successful typed domain results.
- Omitted-model auto-TUI initialization failures are covered for both `up` and `switch`, with no preparation and no misleading plain-fallback notice.
- `filterSwitchModelChoices()` is directly tested as a pure policy, and the empty eligible-target path exits before preparation.
- Migration remains honestly unavailable and fail-closed before memory-store access, consistent with the approved partial U2b scope.
- Independent verification passed 1,363/1,363 tests across 81 files, typecheck, repository-wide lint, build, script-free package dry-run, and diff check.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ❌ | Tests were reviewed first. The new observer and successful event-order cases are valid, but exact notice/output checks and the cross-command renderer-fault matrix remain incomplete. |
| Build verified   | ✅ | `npm run typecheck`, `npm run lint`, `npm run build`, `npm pack --ignore-scripts --dry-run`, and `git diff --check` pass. |
| Security checked | ✅ | Observer failures cannot replace successful command execution; omitted intent is not reconstructed; switch eligibility remains fail-closed; migration performs no store access. |
| Coverage         | ⚠️ | 1,363 tests pass, but renderer runtime restoration/plain fallback, pre-execution mount/emit failures, exact warnings, and committed-output parity for `up`/`switch` are not protected. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Complete renderer-fault state transitions and exact cross-command output regression coverage | Task U2b before ship |
