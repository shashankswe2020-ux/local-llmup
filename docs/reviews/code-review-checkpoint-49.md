# Code Review Checkpoint 49: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (final checkpoint-48 remediation review for runtime progress fallback, authoritative stdout, exact command events/output, switch filtering, and omitted-model failures)
> **Test suite:** 1,363 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real llama.cpp smoke reported passing

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The checkpoint-48 in-flight observer path is materially improved: a throwing progress emitter restores once, emits the exact runtime notice once, continues with plain progress, and cannot displace committed stdout; command event-order and warning assertions also pass. The lifecycle presenter still does not implement the complete specified renderer-fault boundary: picker/review and accepted-before-execute mount failures for `up`/`switch` escape without restoration or the exact pre-execution notice, while the production renderer suppresses its own progress listener and cleanup failures before the new fallback can observe them.

---

## Critical Issues

None.

## Important Issues

### 1. Complete the pre-execution boundary and propagate production renderer failures

- **File:** `src/tui/lifecycle-entry.ts:330`
- **Problem:** `chooseLifecycleModel()` and `reviewPrepared()` allow visual picker load/mount/wait and review mount/wait failures to escape directly. After acceptance, `runInteractiveUp()` and `runInteractiveSwitch()` call `mountLifecycleProgress()` outside a pre-execution fault boundary, unlike `runInteractiveDown()`. These paths execute no domain action, but they omit the required restore plus exact `renderer_pre_execution` notice and permit the CLI to expose the raw renderer error. Separately, `mountLifecycleProgress().emit()` catches listener failures and `unmount()` catches cleanup failures inside `src/tui/lifecycle-renderer.ts`, so the new `createProgressFallback()` cannot observe actual production listener/cleanup faults; its runtime transition is proven only with a synthetic session whose `emit()` throws. A cleanup-only fault also produces no `renderer_runtime` notice. This leaves the failure-state matrix in the TUI spec incomplete despite the valid 1,363-test gate.
- **Fix:** Route visual picker, review, and progress mount/wait through one presenter boundary that owns the session, restores it at most once, emits exactly `local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n`, and rethrows a sanitized/typed failure before `execute()`. Make the production progress session report listener/render/cleanup failure to the outer boundary instead of silently swallowing it, so that boundary can emit exactly one runtime notice and switch to bounded plain progress without changing the domain result. Add table-driven `up`/`switch`/`down` cases for picker/review/mount/wait, emit, and cleanup-only failures, asserting complete ordered stderr/stdout and zero or exactly-one execution as appropriate.

## Suggestions

None.

## What's Done Well

- `createProgressFallback()` restores the failed synthetic progress session once, writes the exact `renderer_runtime` notice once, and routes the failed and subsequent command events to finite plain stderr labels.
- The committed result is formatted to stdout before final cleanup, and observer/cleanup exceptions cannot replace a successful domain outcome.
- `up`, `switch`, and `down` tests verify exact successful command event order while deliberately throwing from observers; the complete fit-warning line is now asserted exactly.
- Switch choices exclude the active Ollama model and fail closed for single-model backends, while omitted-model initialization failures remain pre-domain.
- Migration remains honestly unavailable and performs no memory-store access, consistent with the approved partial U2b scope.
- Independent verification passed all 1,363 tests across 81 files, typecheck, repository-wide lint, build, script-free package dry-run, and diff check.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ❌ | Tests were reviewed first. Runtime synthetic emit/cleanup, exact command event order, warning text, switch filtering, and omitted-model paths are covered, but visual picker/review/mount and production cleanup-only faults are not. |
| Build verified   | ✅ | `npm run typecheck`, `npm run lint`, `npm run build`, `npm pack --ignore-scripts --dry-run`, and `git diff --check` pass. |
| Security checked | ✅ | Domain observers remain advisory, committed stdout remains authoritative, omitted intent is not reconstructed, switch filtering fails closed, and migration does not access stores. |
| Coverage         | ⚠️ | 1,363 tests pass, but the production renderer suppresses failures that the fallback boundary must observe, and several specified pre-execution renderer faults have no exact-notice regression coverage. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Complete pre-execution renderer handling and propagate real progress/cleanup faults to the outer fallback boundary | Task U2b before ship |
