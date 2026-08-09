# Code Review Checkpoint 35: Task U1c

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-08
> **Scope:** Task U1c (restricted controller/driver contracts, immutable read-only command results, and command-specific view-model adapters)
> **Test suite:** 1,233 tests passing (70 files), typecheck ✅, build ✅, lint ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** U1c establishes a useful restricted controller type and immutable result projections while preserving the tested noninteractive output. It is not ready to ship because cancellation/progress generation behavior remains incorrect and several command-specific view models lose or contradict authoritative evidence.

---

## Critical Issues

None.

## Important Issues

### 1. Observe cancellation after asynchronous completion rendering

- **File:** `src/tui/presenter.ts:406-409`
- **Problem:** The controller checks the signal before `complete()`, but not after it. An abort while completion rendering is pending therefore returns `completed`; a synchronized runtime probe reproduced `abort-during-complete completed`.
- **Fix:** Check `signal.aborted` immediately after `await ui.complete(...)` and return `{ type: "cancelled" }`. Add a test that aborts only after `complete()` starts and resolves it afterward.

### 2. Reject incomplete progress generations

- **File:** `src/tui/presenter.ts:328-350`, `src/tui/presenter.ts:399-403`
- **Problem:** `phase_completed` is accepted when the last known count is below its total, and Back clears unterminated phases without validation. Runtime probing confirmed that `1/2 → phase_completed` returns `completed`. This weakens the strict progress state machine and allows incomplete work to appear terminal.
- **Fix:** When a known total exists, require `completed === total` before `phase_completed`. Before Back resets a generation, require all started phases to be terminal; retain failure as a valid terminal state. Add regressions for both paths.

### 3. Isolate retained progress emitters by controller generation

- **File:** `src/tui/presenter.ts:263-350`, `src/tui/presenter.ts:369-403`
- **Problem:** One stable emitter is reused across every Back loop. Resetting the map does not invalidate a retained generation-1 emitter, so it can inject stale events into generation 2. A runtime probe reproduced a stale `phase_started` event after Back. The spec requires monotonically increasing generations and dropping progress from older generations.
- **Fix:** Create a generation-scoped boundary/context for every loop iteration, deactivate it before Back, and retain a separate execution/completion lifecycle guard. Test a retained generation-1 emitter invoked during generation 2.

### 4. Use the active memory kind for non-fitting catalog rows

- **File:** `src/commands/catalog.ts:95-109`, `src/commands/catalog.ts:180-183`
- **Problem:** Non-fitting rows always select and report `minRamBytes`. On discrete-GPU hardware, fit is evaluated against VRAM, so the selected quant and displayed required bytes can contradict the `vram-bound` verdict.
- **Fix:** Select the most-forgiving quant and required footprint using `usableMemoryKind(hw)`: `minVramBytes` for VRAM and `minRamBytes` for RAM. Keep disk bytes as separate evidence. Add an NVIDIA fixture where RAM and VRAM footprints order differently.

### 5. Preserve complete catalog evidence and shown/total state

- **File:** `src/tui/types.ts:131-176`, `src/tui/read-only-view-models.ts:271-321`
- **Problem:** `CatalogViewModel` omits `CatalogResult.total`; replaces `refresh.skipped` and `refresh.capped` IDs with counts; and drops `activeParams`, KV-geometry known/unknown state, and quant integrity fields (`sha256`, `digestVerified`). The driver cannot present shown/total, inspect omitted refresh entries, or preserve integrity and unknown evidence.
- **Fix:** Add these typed fields with explicit optional/null states and map the complete bounded arrays and quant evidence without parsing labels. Add equality-focused tests for all optional and integrity fields.

### 6. Preserve Doctor hardware score evidence

- **File:** `src/tui/types.ts:112-129`, `src/tui/read-only-view-models.ts:247-268`
- **Problem:** The authoritative `HardwareScore.sub` axes are discarded; only total and bottleneck reach the driver. This prevents the TUI from explaining how the score was derived.
- **Fix:** Add a frozen typed sub-score record to `DoctorViewModel`, preserve all four axes, and retain `null` when detection failed. Test both known and unavailable scores.

### 7. Preserve recommendation hardware evidence

- **File:** `src/tui/types.ts:88-97`, `src/tui/read-only-view-models.ts:164-172`
- **Problem:** The recommendation VM compresses the authoritative hardware profile to `arch/platform` and one formatted usable-memory string, dropping total/free RAM, free disk, and GPU vendor/VRAM evidence. The read-only screen cannot explain fit against the detected machine from its mapped DTO.
- **Fix:** Add a typed hardware evidence object containing the bounded numeric profile plus memory kind/usable bytes, and map it directly. Test RAM, disk, and multiple GPUs.

### 8. Keep no-fit throughput provenance internally consistent

- **File:** `src/commands/can-run.ts:121-128`, `src/tui/read-only-view-models.ts:224-243`
- **Problem:** A no-fit result records `throughputEvidence.unknownReason` as `no-sourced-performance-profile`, while the VM's typed throughput reason is `not-evaluated-model-does-not-fit`. The two adjacent evidence representations contradict each other.
- **Fix:** Extend the producer's reason union, emit `not-evaluated-model-does-not-fit` for `runnable: "no"`, and pass the producer reason through once in the builder. Add a no-fit assertion covering both fields.

### 9. Return the typed recommendation result from the command producer

- **File:** `src/commands/recommend.ts:508-531`
- **Problem:** `runRecommend()` still returns `Promise<void>`, unlike the other U1c read-only producers. A controller cannot invoke the existing command use case and pass its immutable result to `buildRecommendViewModel()` without recomputing domain work, contrary to the typed-result inventory.
- **Fix:** Return `Promise<RecommendationResult>` and return the already-built result after writing the unchanged formatter output. Add a test for the returned deeply immutable result.

## Suggestions

### 1. Tighten generic command-argv validation

- **File:** `src/tui/presenter.ts:26`, `src/tui/presenter.ts:167-177`
- The generic canonical pattern accepts leading `-`, uppercase characters, and `=`. Current recommendation handoff is protected earlier by `isSafeModelId`, but the runtime `argv` projection itself would accept option-like arguments such as `--help`. Validate command and positional slots with command-specific schemas, or at minimum reject leading `-` for canonical positional identifiers.

### 2. Reuse the shared immutable snapshot helper

- **File:** `src/tui/read-only-view-models.ts:38-42`
- The local recursive freezer duplicates `src/immutable.ts`. Reuse the shared immutable projection utility, or export a shared deep-freeze primitive, so result and VM immutability semantics cannot drift.

## What's Done Well

- `UiControllerDriver` exposes only mode, choice, and review capabilities; backend/state/filesystem dependency bags do not cross the driver type boundary.
- Driver choices and review decisions are runtime-validated with strict Zod schemas, and projected requests are sanitized, bounded, and frozen before crossing the boundary.
- Command-specific `complete()` typing correctly correlates each screen key with its mapped view model.
- Read-only command snapshots are independently cloned and deeply frozen in the covered paths.
- The full 1,233-test suite, typecheck, repository lint, and build pass; golden compatibility tests confirm unchanged tested plain/JSON output.
- Collection/node/progress caps prevent unbounded view-model and event growth in the covered paths.

## Verification Story

| Check            | Status | Notes |
| ---------------- | ------ | ----- |
| Tests reviewed   | ✅ | U1c controller/view-model tests and changed command tests reviewed first; full suite passes 1,233/1,233 across 70 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, and TypeScript build pass. |
| Security checked | ⚠️ | Sanitization and restricted capability shape are strong; generic runtime argv validation remains broader than model-id safety. |
| Coverage         | ⚠️ | Missing synchronized tests for completion abort, known-total completion, unfinished Back, stale emitters, and complete evidence preservation. |

## Action Items

| #   | Priority | Issue | Target |
| --- | -------- | ----- | ------ |
| 1 | Important | Observe cancellation after completion rendering | Task U1c |
| 2 | Important | Reject incomplete progress generations | Task U1c |
| 3 | Important | Isolate retained emitters by generation | Task U1c |
| 4 | Important | Use active memory kind for catalog requirements | Task U1c |
| 5 | Important | Preserve complete catalog evidence | Task U1c |
| 6 | Important | Preserve Doctor score sub-scores | Task U1c |
| 7 | Important | Preserve recommendation hardware evidence | Task U1c |
| 8 | Important | Correct no-fit throughput provenance | Task U1c |
| 9 | Important | Return typed result from `runRecommend()` | Task U1c |
| 10 | Suggestion | Tighten generic argv validation | Backlog before executable handoff |
| 11 | Suggestion | Reuse shared immutable helper | Backlog |
