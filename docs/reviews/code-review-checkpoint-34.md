# Code Review Checkpoint 34: Task U1c

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-08
> **Scope:** Task U1c (controller/driver contracts and read-only command view-model adapters)
> **Test suite:** 1,226 tests passing (70 files), typecheck ✅, build ✅, lint ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The implementation establishes a useful typed driver boundary and immutable command snapshots, but controller cancellation/progress generation semantics and several evidence mappings do not meet the stated U1c acceptance contract.

---

## Critical Issues

None.

## Important Issues

### 1. Honor aborts that occur while completion is pending

- **File:** `src/tui/presenter.ts:225-227`
- **Problem:** The signal is checked before `ui.complete()`, but not after it. If cancellation occurs while the completion renderer is pending, the controller returns `completed` after the renderer resolves. This violates reliable cancellation and can report success after the user cancelled.
- **Fix:** Check `signal.aborted` immediately after awaiting `ui.complete()` and return `{ type: "cancelled" }`; add a synchronized regression test that aborts only after `complete()` has started.

### 2. Reject incomplete progress phases and known totals

- **File:** `src/tui/presenter.ts:129-151`, `src/tui/presenter.ts:218-220`
- **Problem:** `phase_completed` is accepted when the last known count is below its total, and a Back decision calls `resetGeneration()` which silently clears any nonterminal phases. Both paths permit unfinished work despite the progress protocol requirement.
- **Fix:** Require `completed === total` before accepting `phase_completed` when a total is known, and validate that every phase is terminal before resetting a generation on Back. Add regressions for `1/2 → phase_completed` and `phase_started → back`.

### 3. Isolate progress emitters by Back-loop generation

- **File:** `src/tui/presenter.ts:79-84`, `src/tui/presenter.ts:184-220`
- **Problem:** One stable emitter and phase map are reused across all generations. After Back clears the map, an asynchronous producer retaining the previous generation's emitter can publish stale events into the new generation; these events are forwarded rather than dropped.
- **Fix:** Create a generation-scoped boundary/context for each loop iteration, deactivate it before resetting on Back, and keep a separate execution/completion lifecycle guard. Add a test that retains generation 1's emitter and invokes it during generation 2.

### 4. Report catalog required bytes for the active memory kind

- **File:** `src/commands/catalog.ts:175-181`
- **Problem:** A non-fitting row always reports `quant.minRamBytes` as `requiredBytes`. On discrete-GPU hardware the fit engine uses VRAM, so the typed result and VM can display RAM requirements as VRAM evidence. `smallestQuant()` also selects by RAM even when VRAM is authoritative.
- **Fix:** Select and report the quant footprint using `usableMemoryKind(hw)` (`minVramBytes` for VRAM, `minRamBytes` for RAM), while retaining disk evidence separately where relevant. Add a non-fitting NVIDIA fixture whose RAM and VRAM requirements differ.

### 5. Preserve complete catalog evidence in the mapped VM

- **File:** `src/tui/types.ts:112-179`, `src/tui/read-only-view-models.ts:234-281`
- **Problem:** The mapping drops `CatalogResult.total`, collapses `refresh.skipped` and `refresh.capped` identifiers to counts, and omits catalog evidence such as `activeParams`, KV-geometry unknown/known state, and quant digest verification fields. The TUI cannot reconstruct shown/total counts or inspect integrity/unknown evidence from the mapped VM.
- **Fix:** Add the missing typed fields to `CatalogViewModel` and map them without parsing rendered text. Preserve complete bounded refresh ID arrays and explicit null/unknown states. Add equality-focused tests for each optional/integrity field.

### 6. Do not label a no-fit throughput result as a missing performance profile

- **File:** `src/commands/can-run.ts:121-132`, `src/tui/read-only-view-models.ts:191-209`
- **Problem:** Every unknown throughput result is produced with `unknownReason: "no-sourced-performance-profile"`, including `runnable: "no"`, while the mapped `throughput.reason` correctly says `not-evaluated-model-does-not-fit`. The adjacent `throughputEvidence` therefore contradicts the VM's typed unknown reason.
- **Fix:** Extend the producer reason union and emit `not-evaluated-model-does-not-fit` for no-fit verdicts, then pass that reason through once in the builder. Add a no-fit VM assertion covering both representations.

### 7. Preserve Doctor hardware score sub-scores

- **File:** `src/tui/types.ts:99-110`, `src/tui/read-only-view-models.ts:213-231`
- **Problem:** `DoctorReport.hardwareScore.sub` contains the four evidence axes used to derive the total and bottleneck, but the VM retains only total and bottleneck. The read-only UI cannot show the evidence behind the score.
- **Fix:** Add a frozen typed sub-score record to `DoctorViewModel`, map all four axes, and retain null when hardware detection failed. Add known-score and unknown-score mapping tests.

### 8. Preserve recommendation hardware evidence

- **File:** `src/tui/types.ts:76-83`, `src/tui/read-only-view-models.ts:134-143`
- **Problem:** `RecommendationResult.hardware` contains total/free RAM, GPU vendor/VRAM, and free disk, but the VM compresses it to a bounded `arch/platform` string plus usable memory. The detailed fit evidence is lost before the UI driver receives the result.
- **Fix:** Replace the summary-only fields with a typed hardware evidence object (or add one) matching the bounded catalog hardware VM and map all numeric values and sanitized enum labels. Add a mapping test for RAM, disk, and multiple GPUs.

### 9. Return the typed recommendation result from the command producer

- **File:** `src/commands/recommend.ts:508-531`
- **Problem:** Unlike the other read-only commands in scope, `runRecommend()` still returns `Promise<void>`. A read-only controller cannot execute the established command producer and hand its typed result to `buildRecommendViewModel()` without duplicating the command orchestration or recomputing evidence.
- **Fix:** Return the immutable `RecommendationResult` after writing the existing formatter output, preserving byte-identical plain/JSON behavior. Add a command test asserting the returned result and its deep immutability.

## Suggestions

### 1. Reuse the shared deep-freeze helper

- **File:** `src/tui/read-only-view-models.ts:27-31`
- The local `freezeDeep()` duplicates `src/immutable.ts`. Build each VM through `immutableSnapshot()` or export one shared freeze utility so immutability semantics cannot diverge.

## What's Done Well

- The controller receives `UiControllerDriver`, not command dependencies, which establishes the intended backend/state/filesystem separation by type shape.
- `complete()` correlates screen keys with command-specific VM types, and actionable command argv retains validated canonical identifiers independently of bounded display text.
- Existing plain/JSON formatters remain in command code, and full tests, typecheck, lint, and build pass.
- Command snapshots and mapped VMs are deeply frozen in the covered paths.

## Verification Story

| Check            | Status | Notes |
| ---------------- | ------ | ----- |
| Tests reviewed   | ✅ | Scoped tests reviewed first; full suite passes 1,226/1,226 across 70 files. Manual probes reproduced incomplete-total acceptance, stale Back-generation events, and abort-during-completion returning completed. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, and build all pass. |
| Security checked | ✅ | Driver/controller capability shape and terminal/action sanitization reviewed; no direct injection or dependency escape found. |
| Coverage         | ⚠️ | Missing synchronized coverage for completion abort, unfinished totals/phases, stale Back-generation emitters, and complete evidence preservation. |

## Action Items

| #   | Priority | Issue | Target |
| --- | -------- | ----- | ------ |
| 1 | Important | Honor aborts while completion is pending | Task U1c |
| 2 | Important | Reject incomplete progress phases/totals | Task U1c |
| 3 | Important | Isolate progress emitters by generation | Task U1c |
| 4 | Important | Use active memory kind for catalog required bytes | Task U1c |
| 5 | Important | Preserve complete catalog evidence | Task U1c |
| 6 | Important | Correct no-fit throughput unknown reason | Task U1c |
| 7 | Important | Preserve Doctor score sub-scores | Task U1c |
| 8 | Important | Preserve recommendation hardware evidence | Task U1c |
| 9 | Important | Return typed recommendation result | Task U1c |
| 10 | Suggestion | Reuse shared deep-freeze helper | Backlog |
