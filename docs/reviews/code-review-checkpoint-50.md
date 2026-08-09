# Code Review Checkpoint 50: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (final checkpoint-49 remediation review for pre-execution restoration, guarded progress mount, production runtime fallback, exact notices/output, and lifecycle regression coverage)
> **Test suite:** 1,365 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real llama.cpp up/down smoke reported passing

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The checkpoint-49 synchronous failure paths are substantially improved: accessible review and accepted-before-execute mount faults execute nothing with the exact pre-execution notice, and production listener/cleanup exceptions now reach an outer runtime boundary that preserves committed stdout. One renderer failure channel remains suppressed in production: Ink instance rejection/early exit is converted to cancellation during review and is not observed at all during progress, so the required exact notices and bounded plain-progress transition are still not guaranteed.

---

## Critical Issues

None.

## Important Issues

### 1. Propagate Ink instance failures instead of converting or ignoring them

- **File:** `src/tui/lifecycle-renderer.tsx:86`
- **Problem:** `mountLifecycleReview()` handles both fulfillment and rejection of `instance.waitUntilExit()` by resolving the decision as `cancelled`. A renderer crash before acceptance therefore returns a normal user cancellation: `visualReview()` never receives an error, emits no exact `renderer_pre_execution` notice, and cannot distinguish renderer failure from intent. In `mountLifecycleProgress()`, the `Instance` exit promise is never observed. If Ink rejects or exits unexpectedly while execution is in flight, its component can unsubscribe all listeners; later `emit()` calls then succeed against an empty listener set, so `createProgressFallback()` never restores/reports `renderer_runtime` or switches to bounded plain stderr events. The new tests cover injected session `emit()`/`unmount()` throws and accessible review rejection, but not these real production `Instance` failure channels.
- **Fix:** Preserve an explicit session failure state from `waitUntilExit()`. For review, reject `waitForDecision()` on an unexpected Ink rejection/exit before a decision, while still running idempotent cleanup, so the existing pre-execution boundary emits the exact notice and executes nothing. For progress, observe `waitUntilExit()` and make the next/current `emit()` or `unmount()` report that stored failure to `createProgressFallback()` exactly once; alternatively expose a failure callback/promise consumed by the outer boundary. Add production-level tests with an injectable renderer/instance seam proving review rejection produces the exact pre-execution notice and zero execution, and progress rejection produces one exact runtime notice, ordered bounded fallback events, one cleanup, and unchanged committed stdout.

## Suggestions

None.

## What's Done Well

- Picker/review dependency failures and `up`/`switch` progress-mount failures are now guarded before `execute()` and use the exact pre-execution notice.
- Synchronous production progress listener and cleanup failures are no longer swallowed; the outer boundary restores, emits the runtime notice once, and falls back to finite plain stderr labels.
- Authoritative stdout is committed once and remains intact even when renderer cleanup fails afterward.
- Command suites prove exact `up`, `switch`, and `down` event order while observer exceptions remain isolated from domain execution.
- Omitted-model paths, switch target filtering, empty eligible choices, and the complete requested-quant warning line are covered.
- Migration remains honestly unavailable without store access, consistent with the approved partial U2b scope.
- Independent verification passed all 1,365 tests across 81 files, typecheck, repository-wide lint, build, script-free package dry-run, and diff check; the reported real llama.cpp up/down smoke provides additional lifecycle evidence.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ❌ | Tests were reviewed first. Synchronous session emit/cleanup, accessible review failure, exact notices, mount guards, event order, filtering, omitted models, and warning output are covered; production Ink instance rejection/early-exit behavior is not. |
| Build verified   | ✅ | `npm run typecheck`, `npm run lint`, `npm run build`, `npm pack --ignore-scripts --dry-run`, and `git diff --check` pass. |
| Security checked | ✅ | Failed reviewed intent is not reconstructed, mount faults execute nothing, observer faults do not alter domain state, stdout remains authoritative, and migration performs no store access. |
| Coverage         | ⚠️ | 1,365 tests pass, but the real renderer still converts review-instance failure to cancellation and does not expose progress-instance failure to the fallback boundary. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Propagate review/progress Ink instance failures through the existing pre-execution/runtime boundaries | Task U2b before ship |
