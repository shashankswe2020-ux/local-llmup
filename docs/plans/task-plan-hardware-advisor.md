# Implementation Plan: local-llmup — Hardware Advisor

> Source spec: [docs/specs/hardware-advisor.md](../specs/hardware-advisor.md)
> Base plan: [docs/plans/task-plan-local-llmup.md](./task-plan-local-llmup.md) (ended at T31)
> Status: **Draft — pending human approval + sub-agent review**
> Last updated: 2026-08-06

## Overview

Extend `local-llmup` from installer to **Local AI Hardware Advisor** in three
independently shippable releases:

- **v1.0 (advisor core, T32–T39):** AI Hardware Score + bottleneck in `doctor`
  (Phase 1) and a `yes|slow|no` runnability verdict with absolute tok/s in
  `recommend`/`can-run` (Phase 2). **No pricing data** → zero maintenance
  liability, highest daily value.
- **v1.1 (planner, T40–T44):** priced ComponentDB, `plan <model>` upgrade paths
  (Phase 3), `build --budget <n>` (Phase 4).
- **v2 (deferred):** Phase 5 marketplace — not tasked here (see spec §8).

Every advisor computation lives in `src/advisor/` as a **pure function** of its
inputs; detection, catalog load, and I/O stay in the command layer
(dependency-injected, same pattern as `DoctorDeps`). No advisor module
re-implements memory sizing — all consume `hardware/memory-math.ts`.

## Blocking decisions (must be signed off before the noted tasks)

These map to spec §13. Defaults proposed; a task cannot start until its decision lands.

| # | Decision | Blocks | Proposed default |
|---|---|---|---|
| D1 | `COMFORT_FLOOR` tok/s (yes vs slow boundary) | T32, T37 | 10 tok/s |
| D2 | Throughput calibration source + attribution for `efficiency` constants | T35, T36 | curated from published community benchmarks, cited in `data/perf.json` |
| D3 | Score sub-weights (VRAM/RAM/compute/storage) | T32, T33 | 0.40 / 0.25 / 0.25 / 0.10 |
| D4 | Price staleness threshold + currency handling | T40 | 90 days; USD-labeled, currency-agnostic magnitude |
| D5 | Ship Phase 4 in v1.1 or hold for a price-maintenance owner | T43, T44 | hold until owner assigned |

## Architecture Decisions

- New `src/advisor/**` treated like `src/ranking/**` for coverage (≥80%
  lines/branches). Named exports, explicit return types, no `any`.
- Two datasets, split by liability:
  - `data/perf.json` (**v1.0**): bandwidth + efficiency per hardware class, **no
    prices** → needed for Phase 2 throughput, no staleness liability.
  - `data/components.json` (**v1.1**): extends perf with purchasable components +
    **dated price ranges** → Phase 3/4.
- Throughput is a **memory-bandwidth roofline**; output is always a **range**;
  unmatched hardware → `known:false` (never a fabricated number).
- Determinism: all time-relative math (price staleness) uses a dataset reference
  date, never the wall clock — same rule as the ranker's `recencyScore`.

## Dependency Graph

```
                    ┌───────────── v1.0 (advisor core) ─────────────┐
T31(done)►T32 advisor types+constants
   T32 ►T33 score+bottleneck ►T34 doctor integration            (Phase 1)
   T32 ►T35 perf dataset(load+match) ►T36 throughput ►T37 verdict
                                          T37 ►T38 can-run cmd
                                          T37 ►T39 recommend verdict col  (Phase 2)
── Checkpoint A: v1.0 shippable ──────────────────────────────────────────

                    ┌───────────── v1.1 (planner) ──────────────────┐
{T35,T32}►T40 ComponentDB(schema+data+staleness)
   {T40,T37}►T41 plan engine ►T42 plan cmd                        (Phase 3)
   {T40,T37}►T43 build engine ►T44 build cmd                      (Phase 4, D5-gated)
── Checkpoint B: v1.1 shippable ──────────────────────────────────────────
```

## Cross-cutting testing conventions (every task)

- **Pure core, injected I/O:** advisor modules take data as arguments; commands
  inject `detectHardware`/`loadCatalog`/`loadPerf` (fakes in tests). No network,
  fs, or GPU access in unit tests.
- **Frozen clock** for any staleness/date logic (T40+), pinned to dataset dates.
- **Calibration fixtures** (T36): published `(hardware, model) → tok/s` pairs;
  assert the estimated **range contains** the published value.
- **Property re-validation** (T41/T43): every proposed upgrade/build is fed back
  through `verdict`/`evaluateFit`; a recommendation is invalid unless the tool's
  own engine agrees.
- **Exit-code matrix:** extend the existing table-driven command test with
  `can-run`, `plan`, `build`.
- **Registry parity:** each new command updates the `COMMANDS` registry; the
  existing `--help`/registry test must pass.

---

## Task List

### Release v1.0 — Advisor Core

#### T32: Advisor shared types + constants ✅ done
**Description:** Add advisor domain types to `types.ts` (dependency-free) and a
single `advisor/weights.ts` constants module.
**Acceptance:**
- [x] `types.ts` exports `Bottleneck`, `Runnable`, `ThroughputEstimate`,
  `HardwareScore`, `ComponentPrice` (per spec §9).
- [x] `advisor/weights.ts` exports score sub-weights (asserted to sum to 1) and
  `COMFORT_FLOOR` (D1); documented like `ranking/weights.ts`.
- [x] Weight-sum invariant test present.
**Verify:** `npm run typecheck && npm test tests/advisor/weights`
**Deps:** T31, D1, D3 **Files:** `src/types.ts`, `src/advisor/weights.ts`, `tests/advisor/weights.test.ts` **Scope:** XS

#### T33: Phase 1 — AI Hardware Score + bottleneck (pure) ✅ done
**Description:** `advisor/score.ts` — `computeHardwareScore(hw)` → `HardwareScore`
and `identifyBottleneck(hw)` → `Bottleneck`. Hardware-only (model-independent).
**Acceptance (AC1–AC4):**
- [x] Fixed profile → stable integer 0–100 (≥3 profiles: low/mid/high).
- [x] Correct typed bottleneck for VRAM/RAM/storage-starved + balanced profiles.
- [x] Sub-scores each normalize to `0..1`; final = weighted sum × 100, rounded.
- [x] Weight-sum invariant enforced (from T32).
**Verify:** `npm test tests/advisor/score`
**Deps:** T32 **Files:** `src/advisor/score.ts`, `tests/advisor/score.test.ts` **Scope:** S

#### T34: Phase 1 — `doctor` integration ✅ done
**Description:** Render `AI Hardware Score: N/100` + `Primary bottleneck: …`
alongside existing `doctor` checks, via injected deps.
**Acceptance (AC3):**
- [x] Score + bottleneck lines appended to `doctor` output.
- [x] Exit-code behavior unchanged — a low score does **not** set a failing exit.
- [x] `--json` includes `hardwareScore` + `bottleneck`.
**Verify:** `npm test tests/commands/doctor`
**Deps:** T33 **Files:** `src/commands/doctor.ts`, `tests/commands/doctor.test.ts` **Scope:** S

#### T35: Phase 2 — hardware performance dataset (load + match) ✅ done
**Description:** `advisor/perf-data.ts` — Zod schema + loader for `data/perf.json`
(bandwidth + efficiency per hardware class, **no prices**), plus a matcher
`matchPerf(hw)` → entry or `undefined` (detected `vendor`+`vramBytes`/RAM class →
bandwidth/efficiency; no match → `undefined`, driving the honesty gate).
**Acceptance:**
- [x] Schema rejects missing/negative bandwidth or out-of-range efficiency.
- [x] `data/perf.json` seeded with a curated, **cited** initial set (D2).
- [x] `matchPerf` returns `undefined` for unknown hardware (tested).
**Verify:** `npm test tests/advisor/perf-data`
**Deps:** T32, D2 **Files:** `src/advisor/perf-data.ts`, `data/perf.json`, `tests/advisor/perf-data.test.ts` **Scope:** S

#### T36: Phase 2 — throughput estimator (pure) ✅ done
**Description:** `advisor/throughput.ts` — `estimateTokPerSec(model, quant, hw, perf)`
→ `ThroughputEstimate` via bandwidth roofline; MoE decode uses **active** params
while footprint stays total (from `memory-math.ts`); ±30% band by default.
**Acceptance (AC5–AC8):**
- [x] Pure: identical inputs → identical range.
- [x] Calibration fixtures: range contains published value for ≥80% of pairs.
- [x] Unknown hardware (`matchPerf` miss) → `{ known:false }`, no number.
- [x] MoE fixture asserts active-params decode term vs total-params footprint.
**Verify:** `npm test tests/advisor/throughput`
**Deps:** T35 **Files:** `src/advisor/throughput.ts`, `tests/advisor/throughput.test.ts`, `tests/advisor/fixtures/calibration.json` **Scope:** M

#### T37: Phase 2 — runnability verdict (pure) ✅ done
**Description:** `advisor/verdict.ts` — `verdict(model, hw, perf)` → `Runnable`
combining `evaluateFit` (reuse `ranking/fit.ts`) with throughput vs `COMFORT_FLOOR`.
**Acceptance:**
- [x] `no` when `evaluateFit` fails (carries `ram|vram|disk-bound` reason).
- [x] `slow` when fits but est. tok/s < `COMFORT_FLOOR`; `yes` when ≥.
- [x] Unknown throughput downgrades `yes`→ `slow?` per spec honesty gate.
**Verify:** `npm test tests/advisor/verdict`
**Deps:** T36, D1 **Files:** `src/advisor/verdict.ts`, `tests/advisor/verdict.test.ts` **Scope:** S

#### T38: Phase 2 — `can-run <model>` command ✅ done
**Description:** Thin CLI wrapper: resolve model (reuse resolver) → detect → verdict.
**Acceptance (AC9):**
- [x] Prints exactly one verdict + reason + tok/s range.
- [x] Non-zero exit **only** for `no` (scriptable gate); `--json` supported.
- [x] Registered in `COMMANDS`; help/registry test passes.
**Verify:** `npm test tests/commands/can-run tests/cli`
**Deps:** T37 **Files:** `src/commands/can-run.ts`, `src/cli.ts`, `tests/commands/can-run.test.ts` **Scope:** S

#### T39: Phase 2 — `recommend` verdict column
**Description:** Add a `✓ / ⚠️ / ❌` verdict + tok/s range column to `recommend`
output (and its `--json`), computed via `verdict`.
**Acceptance:**
- [ ] Ranked rows show verdict + est. tok/s; won't-fit section shows `❌ + reason`.
- [ ] `--json` gains `verdict` + `estTokPerSec` per row.
- [ ] Ranking order/determinism from base spec unchanged.
**Verify:** `npm test tests/commands/recommend tests/ranking`
**Deps:** T37 **Files:** `src/commands/recommend.ts` (or rank renderer), `src/output.ts`, +tests **Scope:** S

> **Checkpoint A (v1.0):** `doctor` shows score+bottleneck; `recommend`/`can-run`
> give `yes|slow|no` + tok/s. No prices anywhere. `npm run build && npm run
> typecheck && npm run lint && npm test` all clean; coverage gate green.

---

### Release v1.1 — Planner

#### T40: ComponentDB (schema + data + staleness)
**Description:** `advisor/components.ts` — Zod schema + loader for
`data/components.json` (extends perf entries with purchasable GPUs/RAM/SSDs +
**dated price ranges**, `generatedAt`, `priceAsOf`) + `isStale(db, refDate)`.
**Acceptance:**
- [ ] Schema rejects missing bandwidth/price/date; prices are `{lowUsd,highUsd,asOf}`.
- [ ] `isStale` true past threshold (D4), using a frozen reference date.
- [ ] Seed `data/components.json` curated + dated.
**Verify:** `npm test tests/advisor/components`
**Deps:** T35, D4 **Files:** `src/advisor/components.ts`, `data/components.json`, `tests/advisor/components.test.ts` **Scope:** M

#### T41: Phase 3 — upgrade planner engine (pure)
**Description:** `advisor/plan.ts` — `planUpgrades(model, hw, db)` → cheapest /
faster / workstation option sets + cloud-vs-local advisory.
**Acceptance (AC10–AC14):**
- [ ] Already-capable machine → "already runs", proposes nothing.
- [ ] Each option's deltas applied to `hw` flip verdict to claimed state (property test).
- [ ] "Cheapest" = min-cost fitting set; "Workstation" = max est. throughput.
- [ ] Monetary output carries `priceAsOf`; stale DB emits warning.
- [ ] Cloud-vs-local line only above documented threshold.
**Verify:** `npm test tests/advisor/plan`
**Deps:** T40, T37 **Files:** `src/advisor/plan.ts`, `tests/advisor/plan.test.ts` **Scope:** M

#### T42: Phase 3 — `plan <model>` command
**Description:** CLI wrapper: resolve → detect → `planUpgrades` → render.
**Acceptance:**
- [ ] Renders current verdict + three tiers with tok/s + dated price ranges.
- [ ] `--json` supported; registered in `COMMANDS`; help test passes.
**Verify:** `npm test tests/commands/plan tests/cli`
**Deps:** T41 **Files:** `src/commands/plan.ts`, `src/cli.ts`, `tests/commands/plan.test.ts` **Scope:** S

#### T43: Phase 4 — budget optimizer engine (pure) — D5-gated
**Description:** `advisor/build.ts` — `optimizeBuild(budget, db, catalog)` →
recommended GPU/RAM/SSD set + unlocked models (via `verdict` on synthetic profile).
**Acceptance (AC15–AC17):**
- [ ] Summed **upper** price bound ≤ budget (never over-budget on optimistic edge).
- [ ] "Unlocks" list computed by running `verdict` on the synthetic post-build profile.
- [ ] Infeasible budget → clear "minimum viable ≈ $M" message, no crash.
**Verify:** `npm test tests/advisor/build`
**Deps:** T40, T37, D5 **Files:** `src/advisor/build.ts`, `tests/advisor/build.test.ts` **Scope:** M

#### T44: Phase 4 — `build --budget <n>` command — D5-gated
**Description:** CLI wrapper: validate `--budget` (Zod) → detect → `optimizeBuild`.
**Acceptance:**
- [ ] Rejects non-positive/non-numeric budget with a clear error (non-zero exit).
- [ ] Renders build + estimated total range + unlocks; `--json` supported.
- [ ] Registered in `COMMANDS`; help test passes.
**Verify:** `npm test tests/commands/build tests/cli`
**Deps:** T43, D5 **Files:** `src/commands/build.ts`, `src/cli.ts`, `tests/commands/build.test.ts` **Scope:** S

> **Checkpoint B (v1.1):** `plan`/`build` operate over a dated ComponentDB with
> ranged prices; every recommendation is self-validated by the verdict engine.
> Full suite + coverage gate green; README + `docs/specs/hardware-advisor.md`
> status flipped to reflect shipped phases.

---

### Deferred (not tasked)

- **Phase 5 — `hardware` marketplace** (spec §8): requires an opt-in, pluggable
  live price provider behind an interface, and resolution of ToS/data-freshness
  questions. No task until that gate is cleared.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Throughput estimates wrong → lost trust | Always a range; ≥80% calibration containment gate (AC6); unknown→no number (AC7). |
| Price staleness | Dated dataset + `isStale` warning (T40); v1.0 ships with **no** prices. |
| Detection can't identify exact GPU/bandwidth | `matchPerf` returns `undefined` → honesty gate, not a guess (T35). |
| Recommendation claims a build works but it doesn't | Property re-validation through the verdict engine (AC11, AC16). |
| Scope creep from Phase 4 pricing maintenance | D5 gate holds T43/T44 until an owner is assigned. |

## Files to deliver (summary)

- Engines: `src/advisor/{weights,score,perf-data,throughput,verdict,components,plan,build}.ts`
- Commands: `src/commands/{can-run,plan,build}.ts` + `doctor.ts`/`recommend.ts` edits + `cli.ts`
- Data: `data/perf.json` (v1.0), `data/components.json` (v1.1)
- Types: `src/types.ts` additions
- Tests mirroring each module under `tests/advisor/` and `tests/commands/`
