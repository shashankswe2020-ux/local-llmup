# Code Review Checkpoint 47: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (checkpoint-46 remediation for omitted-model renderer failure semantics and lifecycle regression coverage)
> **Test suite:** 1,361 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real llama.cpp up/down smoke reported passing

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The checkpoint-46 implementation defect is corrected: auto-TUI renderer initialization failure with an omitted `up` or `switch` model now emits only the pre-execution notice, throws to the CLI's ordinary error path, and cannot call picker, preparation, or execution. The implementation also keeps renderer callbacks advisory after execution begins, emits progress from real command orchestration boundaries, filters switch targets before presentation, and leaves migration honestly fail-closed. The checkpoint-46 regression-coverage action remains materially incomplete, including a false-positive renderer-emission test, so these safety properties are not yet protected well enough to ship.

---

## Critical Issues

None.

## Important Issues

### 1. Complete the checkpoint-46 lifecycle regression matrix and make the renderer-fault test exercise its observer

- **File:** `tests/tui/lifecycle-entry.test.ts:49`
- **Problem:** The shared `execute` mock ignores the observer argument. Consequently, the test named “preserves committed stdout when progress emission and cleanup fail” never calls the throwing `emit()` implementation and proves only that unmount failure is swallowed. Coverage is limited to `down`; there is no equivalent committed-output test for `up` or `switch`, no command test asserting ordered observer events at actual acquire/verify/cleanup/serve/readiness/revalidation/commit/rollback boundaries, no throwing-observer coverage for `switch` or `down`, and no default switch-target test proving current-Ollama exclusion plus non-Ollama emptiness. The omitted-model test covers only direct `up` entry behavior, not `switch` or CLI exit-1/error mapping. The exact restored `up` warning is still asserted only by substring. Thus all 1,361 tests can pass if several checkpoint-46 guarantees regress.
- **Fix:** Make the lifecycle entry mock invoke its supplied observer before resolving, assert the throwing `emit()` was reached, and table-test `up`/`switch`/`down` mount, emit, and unmount faults with at-most-once execution and exactly-once authoritative stdout after commit. Add ordered observer assertions in all three command suites, including rollback/failure paths and throwing observers. Exercise both omitted-model commands through CLI routing and assert one `renderer_pre_execution` notice, no fallback/cancellation semantics, no domain call, and exit 1. Extract or inject switch-choice construction so tests verify current Ollama exclusion and empty choices for llama.cpp, MLX, and LM Studio. Replace the fit-warning substring assertion with the exact complete line including model id and newline.

## Suggestions

None.

## What's Done Well

- `loadRenderer()` receives fallback eligibility before it emits a notice; omitted-model auto failures now throw before picker, preparation, or execution and no longer masquerade as cancellation.
- `executePreparedUp()`, `executePreparedSwitch()`, and `executePreparedDown()` emit advisory events at the real acquire, verification, cleanup, serve, readiness, locked-revalidation, state-write, stop/detach, and rollback boundaries; observer exceptions are locally contained.
- Authoritative stdout is written immediately after the committed typed result, while progress unmount is idempotently fault-contained afterward. Renderer callbacks invoked from command observers cannot replace the domain result.
- Default switch choices exclude the active Ollama model and return no picker targets for non-Ollama active backends; explicit invalid targets still fail through `prepareSwitch()` before pull or state mutation.
- The migration screen remains an approved unavailable path and throws `MemoryError` without reading or mutating a memory store, so partial U2b does not weaken U2a containment.
- Independent verification passed 1,361/1,361 tests across 81 files, typecheck, repository-wide lint, build, script-free package dry-run, and diff check.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ❌ | Tests were reviewed first; the new omitted-model test is valid, but the renderer-emission test never invokes the observer and the requested cross-command matrix is absent. |
| Build verified   | ✅ | `npm run typecheck`, `npm run lint`, `npm run build`, `npm pack --ignore-scripts --dry-run`, and `git diff --check` pass. |
| Security checked | ✅ | Omitted intent cannot be reconstructed after renderer failure; observer/render teardown faults do not alter committed domain execution; switch eligibility fails closed; migration performs no store access. |
| Coverage         | ⚠️ | 1,361 tests pass, but post-commit emit isolation, command event order/failures, default switch filtering, switch omitted-model CLI mapping, and exact warning compatibility are not regression-protected. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Complete the checkpoint-46 lifecycle fault, event-order, switch-filter, omitted-model CLI, and exact-output regression matrix | Task U2b before ship |
