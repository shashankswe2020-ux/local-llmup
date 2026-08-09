# Code Review Checkpoint 37: Task U1d

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U1d (final re-review after second remediation: read-only visual/accessibility screens, picker, renderer failure paths, help compatibility, and terminal input handling)
> **Test suite:** 1,303 tests passing (77 files), typecheck ✅, build ✅, lint ✅, pack ✅, diff ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The second remediation fixes the parsed help contract, authoritative stdout handoff, accessible document/nested-evidence bounds, visual evidence including MLX artifact bytes, and the primary list-screen Home/End decoder. U1d is not ready to ship because pre-execution picker failures are not handled deterministically, explicit post-collection renderer failures discard successful results, the picker still misinterprets fragmented navigation as Escape, and accessible help advertises unavailable actions.

---

## Critical Issues

None.

## Important Issues

### 1. Make picker renderer failures observable and emit the exact pre-execution notice for every mode

- **File:** `src/tui/model-picker.tsx:84-101`, `src/tui/read-only-entry.ts:47-68`
- **Problem:** `waitForDecision()` waits only on the decision promise. If Ink rejects or exits before `decide()` runs, the rejection is swallowed and the command can wait forever. When a picker import/mount/wait failure is observed, only implicit mode emits the required `renderer_pre_execution` notice; explicit `--tui` rethrows and the CLI emits a raw command-prefixed error instead of the exact spec notice. Both paths occur before model acceptance and domain work.
- **Fix:** Race the decision against `instance.waitUntilExit()`, reject when the renderer exits without a decision, and always restore/unmount in `finally`. In `runInteractiveCanRun()`, classify every pre-acceptance renderer failure identically: restore, write exactly `local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n`, set exit 1, and return without collecting. Add synchronized implicit and explicit import/mount/runtime-failure tests, including a renderer exit before selection.

### 2. Preserve successful read-only results after explicit final-render failure

- **File:** `src/tui/read-only-command.ts:110-139`
- **Problem:** After `collect()` has succeeded, a mount or `waitUntilExit()` failure rethrows when `mode.explicit` is true. This suppresses the authoritative plain stdout result and exposes the implementation error through the CLI. The spec's post-domain/final-render row requires restoration, the exact `renderer_runtime` notice, and one existing final result regardless of whether TUI selection was explicit.
- **Fix:** Restrict explicit fail-closed behavior to lazy import/pre-domain initialization. Once collection succeeds, catch renderer failures for both explicit and automatic modes, unmount/restore first, emit exactly `local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n`, and write `formatPlain(result)` once. Replace the test that currently expects explicit post-collection rejection with assertions for the stable notice and preserved stdout.

### 3. Apply stateful Home/End decoding and delayed Escape handling to the model picker

- **File:** `src/tui/model-picker.tsx:26-48`
- **Problem:** The main list screens use the stateful decoder and delayed standalone Escape handling, but the can-run picker still relies directly on Ink's `key.escape` and only supports `g`/`G`. A fragmented Home/End sequence begins with Escape, so the picker cancels before the remaining bytes arrive; the global Home/End mapping is also absent.
- **Fix:** Share the list-screen decoder integration with the picker: feed raw chunks into a stateful `createUiKeyDecoder()`, delay standalone Escape, cancel that timer when a complete Home/End sequence arrives, and map `first`/`last` to picker selection. Keep only controls that are implemented in the footer/help. Add fragmented CSI and SS3 Home/End tests plus standalone Escape cancellation and cleanup tests.

### 4. Generate accessible help from the controls valid for the current screen and state

- **File:** `src/tui/read-only-accessible.ts:269-291`
- **Problem:** Pressing `?` on every screen prints search, numbered details, and `p print next command`. Those actions are unavailable on static can-run/doctor/ls screens, search/details are unavailable there, and `p` is also unavailable for catalog and for recommendation results with no command. Entering an advertised key then returns `Unknown command`.
- **Fix:** Build help text from `screen` and `viewModel.command`: static screens advertise only help/quit, catalog advertises search/details/help/quit, and recommend advertises `p` only when a command exists. Add table-driven tests that execute every advertised control for every screen and an empty-recommendation fixture.

## Suggestions

None.

## What's Done Well

- Actual parsed top-level and can-run help now hide all four compatibility flags while preserving their runtime parsing.
- Accessible documents are capped below the 256 KiB frame budget; list and nested evidence are capped with omission/refinement notices.
- Visual catalog evidence includes MLX manifest byte counts, digest evidence, and bounded source/quantization details.
- The main visual list screens use stable selection, stateful fragmented Home/End decoding, delayed standalone Escape, bounded virtualization, and latest-frame-oriented tests.
- The cooked line reader incrementally caps lines, bounds queued lines/bytes, applies backpressure, and resumes streams it paused during close/drain.
- The real built no-color pseudo-TTY smoke rendered recommendation content and exited cleanly; real top-level and can-run help grep checks passed.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | U1d renderer, accessible, picker, cooked-reader, screen, and CLI tests reviewed first; 1,303/1,303 pass across 77 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, pack dry-run, and `git diff --check` pass. |
| Security checked | ⚠️ | Bounds/backpressure are substantially improved; picker renderer failure can still hang before domain execution. |
| Coverage         | ⚠️ | Missing explicit picker-failure matrix, renderer-exit-before-decision, explicit post-collection fallback, picker fragmented Home/End, and per-screen accessible-help tests. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Make picker failures observable and emit exact `renderer_pre_execution` notice | Task U1d |
| 2 | Important | Preserve final result on explicit post-collection renderer failure | Task U1d |
| 3 | Important | Add stateful fragmented Home/End and delayed Escape to picker | Task U1d |
| 4 | Important | Advertise only valid accessible controls | Task U1d |
