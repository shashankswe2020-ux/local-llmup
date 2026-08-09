# Code Review Checkpoint 52: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (final checkpoint-51 follow-up review of lifecycle readiness barriers, async progress-instance failure handling, exact notices, guarded progress mount, and renderer fault ordering)
> **Test suite:** 1,366 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real llama.cpp up/down seam smoke previously reported passing

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The follow-up resolves the previously reported pre-start race: async progress-instance rejection now reaches the readiness barrier before domain execution, and in-flight renderer failures preserve committed stdout while falling back to bounded plain stderr progress. Two contract gaps remain before ship: the CLI still prints raw renderer error text after the exact lifecycle notice, and the production progress renderer still ignores unexpected fulfilled Ink exits.

---

## Critical Issues

None.

## Important Issues

### 1. Stop leaking raw renderer errors after exact lifecycle notices

- **File:** `src/cli.ts:266`
- **Problem:** The lifecycle layer already writes the spec-mandated exact pre-execution/runtime notice and then rethrows the original renderer error. The top-level `up`/`down`/`switch` handlers still print `up: ...`, `down: ...`, and `switch: ...` from that raw error at [src/cli.ts](src/cli.ts#L266), [src/cli.ts](src/cli.ts#L296), and [src/cli.ts](src/cli.ts#L350). The spec explicitly says raw renderer errors are never shown once the lifecycle boundary has emitted the exact notice, so current stderr output is too verbose and contract-breaking.
- **Fix:** Convert lifecycle renderer failures into a typed sentinel/outcome that command registration treats as already-reported, or swallow/re-map those errors at the lifecycle boundary before they reach the generic CLI catch. Add command-level stderr assertions proving the ordered stream contains exactly the lifecycle notice and no trailing renderer message.

### 2. Treat unexpected fulfilled progress exits as renderer failures

- **File:** `src/tui/lifecycle-renderer.tsx:156`
- **Problem:** `mountLifecycleProgress()` observes only `waitUntilExit()` rejection. If the Ink instance fulfills before the expected owned unmount, the progress session silently disappears and the outer lifecycle boundary never receives a failure signal. That leaves one production renderer-exit path outside the spec matrix for both the pre-execution and in-flight phases.
- **Fix:** Track expected shutdown explicitly and handle both fulfillment and rejection from `waitUntilExit()`. Before expected unmount, route fulfillment through the same `onFailure` callback path used for rejection so the readiness barrier can emit `renderer_pre_execution` with no action, and in-flight execution can emit `renderer_runtime` plus bounded plain stderr progress. Add a production-seam test that drives a fulfilled progress exit before start and during execution.

## Suggestions

None.

## What's Done Well

- The earlier accepted-before-execute microtask race is gone: the readiness barrier now classifies queued progress-session failure before domain execution as `renderer_pre_execution` and executes nothing.
- In-flight progress failure now restores once, emits the exact runtime notice, preserves committed stdout, and falls back to bounded plain stderr labels.
- Progress mount for `up` and `switch` is guarded before execute, and the new tests cover omitted-model failures, switch filtering, exact warning output, and event ordering under throwing observers.
- Verification is disciplined: the full suite, typecheck, repository-wide lint, build, pack dry-run, and diff hygiene all pass.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | Reviewed tests first, including [tests/tui/lifecycle-entry.test.ts](tests/tui/lifecycle-entry.test.ts#L1), [tests/tui/lifecycle-screens.test.ts](tests/tui/lifecycle-screens.test.ts#L1), and CLI routing coverage in [tests/cli-tui.test.ts](tests/cli-tui.test.ts#L1). Coverage still misses full command-level stderr assertions and fulfilled progress-instance exits. |
| Build verified   | ✅ | `npm test -- --reporter=dot`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm pack --ignore-scripts --dry-run`, and `git diff --check` pass on the current tree. |
| Security checked | ✅ | No new input-validation, network-exposure, or process-ownership regression was found; migration remains approved unavailable/partial and fail-closed. |
| Coverage         | ⚠️ | 1,366 tests pass, but one user-visible stderr contract and one production renderer-exit path remain unverified and currently incorrect. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Prevent duplicate raw renderer stderr after exact lifecycle notices | Task U2b before ship |
| 2 | Important | Handle unexpected fulfilled progress-instance exits as renderer failures | Task U2b before ship |