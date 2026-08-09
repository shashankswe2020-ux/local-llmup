# Code Review Checkpoint 51: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (final post-checkpoint-50 review of asynchronous Ink failure propagation, lifecycle fault boundaries, exact notices, command progress, filtering, and approved partial migration behavior)
> **Test suite:** 1,366 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real runtime smoke reported passing

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** Rejected Ink review promises and asynchronous progress failures now reach the lifecycle boundary, and all automated gates pass. The boundary still has a reproducible pre-execution microtask race, leaks raw renderer error text after the exact notice, and does not treat or production-test unexpected fulfilled Ink exits, so checkpoint 50 is not fully resolved.

---

## Critical Issues

None.

## Important Issues

### 1. Remove the microtask gap between renderer readiness and domain execution

- **File:** `src/tui/lifecycle-entry.ts:542`
- **Problem:** `startExecution()` waits one microtask, sets `executionStarted = true`, and then resolves to its caller. Resolution schedules another microtask before `deps.execute()` is invoked. An Ink failure delivered in that gap is therefore classified as `renderer_runtime`, and the command still executes, although the controller has not called `execute()` yet. This violates the failure-state matrix requiring accepted-before-execute failures to emit `renderer_pre_execution` and perform no action. A nested-microtask reproduction against the built code completed the switch with `execute` called once and emitted the runtime notice.
- **Fix:** Make the boundary own invocation of the domain thunk, for example `runExecution(() => deps.execute(...))`: after the readiness microtask, check the stored failure, mark execution started, and invoke the thunk synchronously in that same continuation before yielding. Add a regression where `onFailure` uses nested microtasks and assert the exact pre-execution notice, rejection, and zero execution.

### 2. Suppress raw renderer errors after exact lifecycle notices

- **File:** `src/tui/lifecycle-entry.ts:546`
- **Problem:** Pre-execution boundaries write the exact notice and then rethrow the original renderer error. The command handlers subsequently print that raw message (for example, `switch: ink failed`) from `src/cli.ts:350`. The terminal UI spec requires exact notice text and states that raw renderer errors are never shown without an approved debug mode. Current tests assert only that the exact notice was one of the writes and explicitly expect the raw error rejection, so they do not catch the additional CLI output.
- **Fix:** Convert renderer faults to a stable typed/sentinel lifecycle failure that command handlers recognize without printing another message, or return a typed failed outcome after the lifecycle layer writes the notice. Add command-level assertions for the complete ordered stderr stream, proving it contains exactly the specified notice and no renderer message.

### 3. Treat unexpected fulfilled Ink exits as failures and test the real Instance channel

- **File:** `src/tui/lifecycle-renderer.tsx:93`
- **Problem:** Review `waitUntilExit()` fulfillment still becomes a normal cancellation, and progress `waitUntilExit()` observes rejection only. An unexpected fulfilled exit before a review decision or before owned progress unmount is therefore silently ignored rather than entering the pre-execution/runtime fault boundary. In addition, the new asynchronous failure test injects a synthetic `LifecycleProgressSession.onFailure()` callback; there is still no renderer/Instance seam proving that the production `waitUntilExit()` handlers propagate fulfillment/rejection, restore once, and preserve event order. This leaves checkpoint-50 issue #168 partially open.
- **Fix:** Track expected decision/unmount shutdown separately. Treat `waitUntilExit()` fulfillment as a failure when it occurs before that expected shutdown, for both review and progress, and route it through the same failure callback. Add an injectable render/Instance coordinator test covering fulfilled and rejected exits before execution and in flight, with exact notices, one unmount/cleanup, bounded plain progress, zero/one execution, and unchanged committed stdout.

## Suggestions

None.

## What's Done Well

- Ink review rejection is no longer converted into a cancellation, and progress sessions now expose asynchronous failure through `onFailure()`.
- Listener and cleanup failures are allowed to reach the outer fallback instead of being suppressed in the production progress session.
- Domain observers remain fault-isolated, and `up`, `switch`, and `down` event order is asserted without letting renderer exceptions alter product execution.
- Exact warning text, omitted-model behavior, switch active-model filtering, single-model fail-closed behavior, and approved unavailable migration behavior remain covered.
- Independent verification passed all 1,366 tests across 81 files, typecheck, repository-wide lint, build, script-free package dry-run, and diff check.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ❌ | Tests cover review rejection, synthetic pre-start failure, synchronous emit/cleanup failure, event order, filtering, omitted models, and exact warning text; they do not cover the nested-microtask race, complete CLI stderr, or production Ink Instance fulfillment/rejection. |
| Build verified   | ✅ | `npm run typecheck`, `npm run lint`, `npm run build`, `npm pack --ignore-scripts --dry-run`, and `git diff --check` pass. |
| Security checked | ✅ | No new input, network, secret, or process-ownership regression was found; migration remains fail-closed and performs no store access. |
| Coverage         | ⚠️ | 1,366 tests pass, but lifecycle fault coverage misses three observable boundary behaviors described above. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Eliminate the readiness-to-execute microtask race | Task U2b before ship |
| 2 | Important | Prevent raw renderer error leakage after exact notices | Task U2b before ship |
| 3 | Important | Handle and production-test unexpected fulfilled/rejected Ink exits | Task U2b before ship |
