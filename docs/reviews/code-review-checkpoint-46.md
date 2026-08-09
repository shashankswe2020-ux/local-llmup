# Code Review Checkpoint 46: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (checkpoint-45 remediation for lifecycle progress ownership, domain-boundary events, renderer fault isolation, authoritative stdout, lazy initialization, switch eligibility, and warning compatibility)
> **Test suite:** 1,358 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅, real llama.cpp seam smoke ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The checkpoint-45 safety and correctness defects are substantially remediated: progress no longer subscribes to input or advertises cancellation, command observers are advisory and fault-isolated at real execution boundaries, progress emit/unmount failures cannot replace committed outcomes, final result formatting precedes renderer teardown, switch choices exclude the current Ollama model and are empty for non-Ollama active backends, and the exact model-qualified `up` warning is restored. Production migration remains an approved, honest fail-closed unavailable screen, so this is correctly assessed as a partial U2b increment rather than being required to open insecure filesystem access. One auto-initialization branch still reports a fallback that did not happen and converts renderer initialization failure into user cancellation, and the remediation matrix is not regression-tested.

---

## Critical Issues

None.

## Important Issues

### 1. Do not report omitted-model renderer failure as both plain fallback and user cancellation

- **File:** `src/tui/lifecycle-entry.ts:475`
- **Problem:** In auto TUI mode, `loadRenderer()` always emits `renderer_init; continuing in plain mode` when renderer initialization fails. When `up` or `switch` has no explicit model, the caller then emits `renderer_pre_execution; no action was performed`, returns `cancelled`, and the CLI maps that result to exit 130. A runtime probe produced both contradictory notices with no `prepare()` or `execute()` call. This branch safely performs no domain action, but it neither continues in plain mode nor represents user cancellation; it violates the required “plain fallback only with explicit model” failure matrix and masks an initialization failure as SIGINT-style cancellation.
- **Fix:** Decide fallback eligibility before emitting the renderer-init notice. Pass whether a canonical model was explicitly supplied into the initialization boundary (or return a typed `renderer-unavailable` result): auto mode with an explicit model may emit the plain-fallback notice and execute once; auto mode with an omitted model must emit only the pre-execution failure notice, perform no picker/domain action, and return/throw a non-cancellation failure that the CLI maps to exit 1. Apply the same branch to `runInteractiveUp()` and `runInteractiveSwitch()`.

### 2. Add regression coverage for the checkpoint-45 remediation matrix

- **File:** `tests/tui/lifecycle-entry.test.ts:1`
- **Problem:** The lifecycle-entry suite still contains only three accessible `down` tests. No test exercises `up`/`switch`, auto versus explicit renderer initialization, picker import/mount/rejection, progress emit/unmount faults, post-commit authoritative stdout, switch choice filtering, or the omitted-model branch above. Command coverage checks an observer throw only for `up`; `switch`/`down` observer isolation and exact event order are unasserted. The `up` warning test still checks only a substring rather than the restored byte-compatible line. The full suite therefore passes without protecting most of the remediation requested after checkpoint 45.
- **Fix:** Add injected-fault table tests for all three lifecycle commands covering renderer load/review/progress mount/emit/unmount failures before execution and after commit; assert at-most-once execution and exactly-once authoritative stdout. Add auto/explicit × model-present/model-omitted × picker-failure cases, Ollama/non-Ollama/current-model switch choice cases, ordered command observer events with throwing observers, and an exact full-line `up` warning assertion including model id and newline.

## Suggestions

None.

## What's Done Well

- `LifecycleProgressScreen` no longer installs `useInput()` and no longer claims Ctrl+C cancellation; U2c remains the owner of cancellation/compensation semantics.
- `executePreparedUp()`, `executePreparedSwitch()`, and `executePreparedDown()` catch observer faults locally and emit progress at the actual acquire/verify/cleanup/serve/readiness/revalidation/state boundaries without moving domain logic into the presenter.
- The real progress renderer removes failing listeners, bounds retained events, ignores late emits, and swallows teardown faults. Command observers prevent injected `emit()` faults from escaping execution; stdout is written before the idempotent teardown path.
- `defaultSwitchDeps.listModels()` returns no targets for llama.cpp, MLX, or LM Studio active state and excludes the current model for Ollama.
- The plain fit warning again includes `for <model id>` and is byte-equivalent to the committed format for validated model/quant identifiers.
- The built production llama.cpp adapter passed verified cache acquisition, loopback serve/readiness, exact-marker chat (`U2B_REVIEW_SMOKE_OK`), unsupported-embedding rejection, ownership-safe stop, and port release on `127.0.0.1:18083` without touching the existing active Ollama state.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | Reviewed lifecycle screen/entry tests first, then CLI and `up`/`switch`/`down` command tests; independently reran 1,358/1,358 tests across 81 files. |
| Build verified   | ✅ | `npm run typecheck`, repository-wide `npm run lint`, `npm run build`, script-free package dry-run, and `git diff --check` all pass. |
| Security checked | ✅ | Progress does not subscribe to stdin or promise cancellation; observer/render teardown faults do not alter domain execution; migration remains fail-closed before store access. |
| Coverage         | ⚠️ | Existing tests do not exercise most checkpoint-45 renderer, fallback, picker, committed-output, switch-choice, or observer-fault branches. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Correct omitted-model auto renderer-init failure reporting and exit semantics | Task U2b before ship |
| 2 | Important | Add the checkpoint-45 lifecycle remediation regression matrix | Task U2b before ship |
