# Code Review Checkpoint 21: Task B12

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 7 August 2026
> **Scope:** Task B12 — backend surfacing in `recommend` / `can-run` (`--backend`, `--available-backends`). Uncommitted changes only.
> **Test suite:** 794 tests passing (50 files), typecheck ✅, build ✅, lint ✅ (scope files clean)

---

## Verdict: ✅ APPROVE

**Overview:** B12 surfaces which registered backends can serve each model and lets
users scope the throughput estimate to a runtime (`--backend`) and, opt-in, hide
models no installed backend can serve (`--available-backends`). The change is
well-isolated behind the injected `BackendRegistry`, honors the honesty gate
(unsourced `(class, backend)` pairs → `known:false` but still ranked), preserves
determinism (the default advice path never probes `isInstalled()`), keeps the
`can-run` exit-code contract intact, and is covered by focused new tests
(determinism, flag forwarding, invalid-backend rejection, honesty gate, JSON
schema). No Critical or Important findings; only Minor consistency/UX notes.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions (Minor)

### 1. `throughputBackend` is duplicated per-entry in `recommend` JSON, inconsistent with `can-run`

- **File:** [src/commands/recommend.ts](src/commands/recommend.ts#L455-L456)
- **Problem:** `throughputBackend` is a result-level fact (`RecommendationResult.throughputBackend`) — identical for every ranked row — yet it is emitted _inside_ each `ranked[]` entry. `can-run` emits the same field at the **top level** of its JSON object ([src/commands/can-run.ts](src/commands/can-run.ts#L166-L167)). A consumer parsing both surfaces sees the field in two different positions, and the recommend payload repeats the same string N times.
- **Fix:** Prefer a single top-level field to match `can-run` and remove the redundancy:
  ```ts
  return renderJson({
    hardware: {/* … */},
    throughputBackend: result.throughputBackend, // result-level, once
    ranked: result.entries.map((entry) => ({
      /* …no per-entry throughputBackend… */
      backends: [...entry.backends],
      ...sizingJsonFields(entry),
    })),
    /* … */
  });
  ```
  Keeping `backends` per-entry is correct (it varies per model). Only `throughputBackend` should move. Note this is a JSON-schema change, so update the affected `recommend` JSON test assertion in the same edit.

### 2. `recommend` text output never states which backend throughput is scoped to

- **File:** [src/commands/recommend.ts](src/commands/recommend.ts#L365-L372)
- **Problem:** When a user runs `recommend --backend mlx`, the `Est. tok/s` column is silently mlx-scoped, but nothing in the header/`modeNote` tells the reader that. `can-run` text is explicit — it appends `(throughput scoped to <backend>)` ([src/commands/can-run.ts](src/commands/can-run.ts#L148-L150)). The two human surfaces disagree on discoverability.
- **Fix:** Append the scope to `modeNote` (or the header) when a non-default backend is active, e.g. ` — throughput scoped to ${result.throughputBackend}`. Gate it on `result.throughputBackend !== "ollama"` to avoid noise on the default path.

### 3. `--available-backends` drops models with no visible count/note

- **File:** [src/commands/recommend.ts](src/commands/recommend.ts#L237-L250)
- **Problem:** Under `--available-backends`, both `entries` and `wontFit` are filtered so models with no installed servable backend vanish entirely from the report, with no "N models hidden (no installed backend)" note. A user who expects a familiar model and doesn't see it has no signal as to why. This is a UX transparency gap, not a correctness bug (the filter itself is correct).
- **Fix:** Optional. Emit a short footer when the flag is active and dropped ≥1 model, e.g. `Hidden: 3 model(s) with no installed backend (run without --available-backends to see all)`. Requires retaining the pre-filter count.

### 4. `registry.available()` — reachable via `--available-backends` — has no timeout on the install probe

- **File:** [src/backend/registry.ts](src/backend/registry.ts#L58-L69), reached from [src/commands/recommend.ts](src/commands/recommend.ts#L489-L493)
- **Problem:** `available()` awaits `adapter.isInstalled()`, which spawns `ollama --version` without an `AbortSignal`/deadline. A wedged binary would hang `recommend --available-backends` indefinitely. This is pre-existing registry behavior (also flagged for `version()` in Checkpoint 20 §2), but B12 makes it newly reachable from an advice command. Out of strict B12 scope, but worth tracking now that the surface exists.
- **Fix:** Bound `isInstalled()` with a short timeout in the adapter (mirroring the readiness probe), so registry consumers inherit a bounded probe. Track alongside the Checkpoint 20 `version()` timeout item.

### 5. `--backend` and `--available-backends` are orthogonal in a way that can surprise

- **File:** [src/commands/recommend.ts](src/commands/recommend.ts#L207-L250)
- **Problem:** `--backend mlx --available-backends` (with only ollama installed) filters visibility by the _installed_ set (ollama) while scoping throughput to the _requested_ backend (mlx, → `unknown`). The combination is internally consistent with each flag's definition, but a user could reasonably expect `--available-backends` to also consider whether the `--backend` runtime is installed. This is a documentation/UX nuance, not a defect.
- **Fix:** None required. Consider a one-line note in `--help`/docs clarifying the two flags are independent (one scopes throughput, the other scopes visibility).

### 6. Stray double blank line in `can-run.test.ts`

- **File:** [tests/commands/can-run.test.ts](tests/commands/can-run.test.ts#L169-L171)
- **Problem:** Two consecutive blank lines between the new `backend surfacing (B12)` block and `describe("runCanRun")`. Cosmetic; lint passes.
- **Fix:** Collapse to a single blank line.

## What's Done Well

- **Determinism proven, not asserted:** the "default output is byte-identical whether or not a backend is installed" test flips `isInstalled()` between two registries, compares raw stdout, _and_ asserts the probe never ran (`probed === false`). That directly locks the "advice path stays offline" invariant.
- **Honesty gate covered on both surfaces:** the `--backend mlx` tests confirm an unsourced `(class, backend)` pair yields `throughput.known === false` while the model is still ranked/answered — no fabricated number, no silent drop.
- **Clean boundary validation:** `parseBackendName` is a zod-enum guard that throws `ValidationError` at the CLI boundary, with a CLI test proving an invalid `--backend` sets `exitCode = 1` and never invokes `runRecommend`. The raw value never reaches a spawn.
- **Backward-compatible signatures:** `registry`/`availableBackendNames` and the `backend` arg are optional with sensible defaults, so the 13 existing `buildRecommendation`/`buildCanRunResult` call sites keep working untouched.
- **Advisory-only (`hf`) models handled correctly:** the test asserting an hf-only model reports `backends: []` yet still ranks confirms `backendsForModel` and the ranking honesty rule stay aligned.

## Verification Story

| Check            | Status | Notes                                                                                                                                                         |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 794 pass; new tests cover determinism, honesty gate, flag forwarding, invalid-backend rejection, JSON/text surfacing                                          |
| Build verified   | ✅     | `tsc` and `tsc --noEmit` clean                                                                                                                                |
| Lint             | ✅     | scope files clean (`eslint` no findings)                                                                                                                      |
| Security checked | ✅     | `--backend` zod-validated at boundary; value never reaches a shell; `--available-backends` spawns via arg array, loopback/offline; no network on default path |
| Coverage         | ✅     | Both `buildRecommendation`/`buildCanRunResult` and `runRecommend`/`runCanRun` paths exercised, incl. filter + renumber behavior                               |

## Action Items

| #   | Priority | Issue                                                                         | Target  |
| --- | -------- | ----------------------------------------------------------------------------- | ------- |
| 1   | Minor    | Move `throughputBackend` to top-level in `recommend` JSON to match `can-run`  | backlog |
| 2   | Minor    | Surface active `--backend` scope in `recommend` text output                   | backlog |
| 3   | Minor    | Add a "hidden N models" note when `--available-backends` drops entries        | backlog |
| 4   | Minor    | Bound `isInstalled()`/`version()` probes with a timeout (shared with CP20 §2) | backlog |
| 5   | Minor    | Document that `--backend` and `--available-backends` are independent          | backlog |
| 6   | Minor    | Remove stray double blank line in `can-run.test.ts`                           | backlog |
