# Spec: local-llmup — Local AI Hardware Advisor

> Status: **Draft (v0.1)** — pending human approval and sub-agent review.
> Last updated: 2026-08-06
> Extends: [local-llmup.md](./local-llmup.md). This document does not replace the
> base spec; it adds an "advisor" capability layer on top of the existing
> hardware detection, memory-math, ranking, and `doctor` foundations.

## 1. Objective

Evolve `local-llmup` from a model **installer** into a **Local AI Hardware
Advisor**: a tool that answers the questions people actually ask on r/LocalLLM —
_"What can my machine run?"_, _"Where is my bottleneck?"_, and _"Do I need more
GPU or more RAM?"_ — with **personalized, quantitative, reproducible** answers.

The advisor reframes the product mission:

> Ollama's mission is to _run_ models. local-llmup's mission becomes to help
> people **build and grow the right local-AI machine**: detect hardware,
> recommend models, explain bottlenecks (VRAM vs RAM vs CPU), estimate
> tokens/sec, and compare upgrade paths.

### Target users

- Enthusiasts deciding whether/what to upgrade before buying hardware.
- Developers sizing a machine to a target model (e.g. "I want to run Kimi K3").
- Budget-constrained buyers who want the best local-AI build for a fixed spend.

### Non-goals (v1 of the advisor)

- Real-time marketplace scraping of used-GPU prices (see §7, Phase 5 — deferred).
- Live on-device benchmarking (throughput is **estimated**, not measured; see §5).
- Recommending or linking to specific vendors/retailers for purchase.

---

## 2. Design Principles (non-negotiable)

These exist because the advisor makes **claims about the physical world** (speed,
price, "can run"). Wrong claims erode trust faster than a missing feature.

1. **Every number is an estimate with a labeled range and a source.** No bare
   "20 tok/s". Always "~15–25 tok/s (estimated, model v3, 2026-08)".
2. **Determinism.** Advisor output is a pure function of `(HardwareProfile,
   Catalog, ComponentDB, reference date)`. Same inputs → identical output. All
   time-relative math uses a **fixed reference date** from the dataset, never the
   wall clock — same rule the ranker already uses for `recencyScore`.
3. **Estimates never masquerade as live facts.** Prices and component specs come
   from a **versioned, in-repo dataset** with a `generatedAt` date. Output shows
   that date. Stale data warns; it never silently presents old prices as current.
4. **Reuse the single source of truth.** "Does it fit?" continues to derive from
   `hardware/memory-math.ts`. The advisor must not re-implement memory sizing.
5. **Graceful degradation.** If a component/price dataset is missing or a probe
   fails, the advisor drops the affected phase with a clear message rather than
   guessing.
6. **No new runtime dependencies** without approval (base spec Boundaries hold).

---

## 3. Phased Scope

| Phase | Feature | Command surface | New data needed | v1? |
|---|---|---|---|---|
| 1 | Hardware Assessment + score | `doctor` (extended) | none | ✅ |
| 2 | "What can I run" pass/warn/fail | `recommend` (extended) / `can-run` | none | ✅ |
| 3 | Upgrade Planner (target a model) | `plan <model>` | ComponentDB + throughput model | ✅ (curated, static) |
| 4 | Budget Optimizer | `build --budget <n>` | ComponentDB + prices | ⚠️ v1.1 (static prices) |
| 5 | Marketplace (live used prices) | `hardware` | live price feed | ❌ deferred (see §7) |

---

## 4. Phase 1 — Hardware Assessment & AI Hardware Score

Extends the existing read-only `doctor` command. Adds a **quantified capability
score** and a **named primary bottleneck**.

### Behavior

1. Reuse `detectHardware()` → `HardwareProfile` (already implemented, timeout +
   conservative fallback).
2. Compute an **AI Hardware Score** (0–100) from a documented, unit-tested rubric
   over four sub-scores: **VRAM**, **RAM**, **compute** (CPU/GPU class), and
   **storage headroom**.
3. Identify the **primary bottleneck** = the lowest-weighted-normalized
   sub-score, surfaced as a typed `Bottleneck = "vram" | "ram" | "compute" |
   "storage"`.
4. Render alongside existing `doctor` checks.

### Illustrative output

```
$ local-llmup doctor
CPU:     Ryzen 7 7700X        ✅
RAM:     32 GB                 ⚠️  (headroom for ≤ ~30B Q4)
GPU:     RTX 3060 12 GB        ✅
Storage: 180 GB free          ⚠️
AI Hardware Score: 78/100
Primary bottleneck: VRAM
```

### Scoring rubric (must be a standalone, tested module)

- Lives in `advisor/score.ts`; weights in one constants block; sub-scores each
  normalize to `0..1`; final = weighted sum × 100, rounded.
- Weights documented and asserted to sum to 1 (mirrors ranker's `weights.ts`).
- Rubric is **hardware-only** — independent of any specific model — so the score
  is stable across catalog refreshes.

### Acceptance criteria

- AC1: Given a fixed `HardwareProfile`, `computeHardwareScore` returns a stable
  integer 0–100 (unit test with ≥3 profiles: low-end, mid, high-end).
- AC2: `identifyBottleneck` returns the correct typed bottleneck for crafted
  profiles (VRAM-starved, RAM-starved, storage-starved, balanced).
- AC3: `doctor` exit-code behavior from the base spec is unchanged (score is
  additive; a low score does not, by itself, set a failing exit code).
- AC4: Weight-sum invariant test passes; changing a weight without rebalancing
  fails the suite.

---

## 5. Phase 2 — "What Can I Run" (pass / warn / fail)

Reframes `recommend` output into an at-a-glance runnability verdict per model,
and adds an explicit single-model query `can-run <model>`.

### Verdict model (three states, typed)

```
Runnable = "yes"   // fits() true AND estimatedTokPerSec >= COMFORT_FLOOR
         | "slow"  // fits() true BUT estimatedTokPerSec <  COMFORT_FLOOR
         | "no"    // fits() false  (reason: ram-bound | vram-bound | disk-bound)
```

### Illustrative output

```
✓ Llama 3.1 8B      ~42 tok/s
✓ Gemma 3 12B       ~31 tok/s
✓ Qwen3 14B         ~24 tok/s
⚠️ DeepSeek V3      ~3 tok/s   (fits, but slow on this hardware)
❌ Kimi K3 FP16                (won't fit — vram-bound)
```

### Throughput estimation (the hard part — specified explicitly)

Phase 2 needs an **absolute tok/s estimate**, not just the ranker's relative
`speedScore (0..1)`. This is a **new** module `advisor/throughput.ts`.

- **Methodology:** memory-bandwidth-bound roofline approximation. For
  autoregressive decode, tok/s is dominated by moving model weights through
  memory once per token:
  `estTokPerSec ≈ (effectiveBandwidthBytesPerSec / residentWeightBytes) × efficiency`
  where:
  - `residentWeightBytes` comes from `memory-math.ts` (shared source of truth;
    MoE uses **active** params for the decode-bandwidth term, unlike the memory
    footprint which uses total — this asymmetry is documented and tested).
  - `effectiveBandwidth` comes from the ComponentDB entry for the bounding pool
    (GPU VRAM bandwidth if `usableMemoryKind === "vram"`, else system RAM
    bandwidth).
  - `efficiency` is a per-hardware-class calibration constant (0..1) recorded in
    the dataset, derived from published community benchmarks, **not** invented.
- **Output is always a range**, not a point: `±30%` band by default, widened when
  the hardware class is uncalibrated.
- **Honesty gate:** if bandwidth or efficiency for the detected hardware is
  unknown, throughput is reported as `unknown` and the verdict downgrades `yes`→
  `slow?` rather than fabricating a number.

### Acceptance criteria

- AC5: `estimateTokPerSec` is a pure function; identical inputs → identical range.
- AC6: For a calibration set of known (hardware, model) → published tok/s pairs
  bundled as fixtures, the estimate's **range contains** the published value for
  ≥80% of fixtures (guards against a wildly wrong model).
- AC7: Unknown hardware class yields `unknown` (never a fabricated number) — tested.
- AC8: MoE decode uses active params while its memory footprint uses total params;
  a fixture asserts both branches.
- AC9: `can-run <model>` prints exactly one verdict + reason and sets a
  non-zero exit code only for `no` (scriptable gate).

---

## 6. Phase 3 — Upgrade Planner (`plan <model>`)

Answers: _"I want to run **X**. What's the cheapest / fastest / workstation path
from where I am now?"_ — the exact r/LocalLLM question.

### Behavior

1. Resolve `<model>` against the catalog (reuse existing resolver).
2. Establish **current** verdict via Phase 2 (`no` / `slow` / `yes`).
3. If already `yes`, say so and stop (no upsell).
4. Otherwise, search the **ComponentDB** for upgrade sets that move the verdict to
   `yes`, grouped into three intents:
   - 💰 **Cheapest** — minimum estimated cost that reaches `fits() === true`
     (may be `slow`).
   - ⚡ **Faster** — best estimated tok/s under a "reasonable single-box" cap.
   - 🏢 **Workstation** — highest estimated tok/s regardless of cost.
5. Add a **cloud-vs-local** advisory line when local upgrade cost exceeds a
   documented threshold relative to cloud cost for the same workload (cloud
   prices from the versioned dataset, clearly dated).

### Illustrative output

```
Want to run Kimi K3?
Current:  RTX 3060 12 GB · 32 GB RAM  →  ❌ won't fit (vram-bound)

💰 Cheapest     +96 GB RAM              ~2 tok/s     est. $180–260   (2026-08 prices)
⚡ Faster        RTX 5090 32 GB          ~20 tok/s    est. $1,900–2,200
🏢 Workstation   4× RTX PRO 6000         ~85 tok/s    est. $18k+
☁️  For this workload, cloud is likely cheaper than the workstation path.
```

### ComponentDB (new versioned dataset)

- `data/components.json`, Zod-validated, with `generatedAt` and `priceAsOf`.
- Entries: GPUs (VRAM, memory bandwidth, est. price range), RAM kits (capacity,
  type, price range), SSDs (capacity, gen, price range).
- **Prices are ranges, dated, and treated as estimates.** A staleness threshold
  (e.g. 90 days) triggers a visible warning.
- Curated + reviewed like the model catalog; a future enrichment job may propose
  updates via PR (mirrors the catalog refresh pattern — out of scope here).

### Acceptance criteria

- AC10: `plan` on an already-capable machine returns "already runs" and proposes
  nothing (no fabricated upsell).
- AC11: Each returned option, when its deltas are applied to the current profile,
  actually flips `fits()`/verdict to the claimed state (property-style test).
- AC12: "Cheapest" is genuinely the min-cost fitting set in the fixture DB;
  "Workstation" is genuinely the max estimated-throughput set (tested).
- AC13: All monetary output shows the `priceAsOf` date; stale fixtures emit a
  warning line.
- AC14: Cloud-vs-local advisory appears only above the documented threshold.

---

## 7. Phase 4 — Budget Optimizer (`build --budget <n>`) — v1.1

Answers: _"Best local-AI build for $N?"_

### Behavior

1. Parse `--budget` (validated positive integer, currency-agnostic magnitude).
2. Constrained selection over ComponentDB: maximize an objective (largest model
   at a good quant runnable at ≥ comfort tok/s) subject to `Σ price ≤ budget`.
3. Output a recommended GPU / RAM / SSD set plus the **models it unlocks** (via
   Phase 2 verdicts on the resulting synthetic profile).

### Illustrative output

```
$ local-llmup build --budget 3000
Budget: $3,000 (component prices as of 2026-08)
Recommended:
  GPU: RTX 5080 24 GB
  RAM: 128 GB DDR5
  SSD: 2 TB Gen4
Estimated total: $2,780–3,050
Unlocks:
  ✓ Qwen3 235B Q4    ~14 tok/s
  ✓ DeepSeek R1      ~11 tok/s
  ✓ Llama 4          ~18 tok/s
```

### Acceptance criteria

- AC15: Returned build's summed **upper** price bound ≤ budget (never recommends
  over budget on the optimistic edge) — tested against fixture DB.
- AC16: The "unlocks" list is computed by running Phase 2 verdicts on the
  synthetic post-build profile (no hand-authored claims).
- AC17: Infeasible budgets (below cheapest viable set) return a clear "no viable
  build under $N; minimum viable ≈ $M" message, not an empty result or crash.

---

## 8. Phase 5 — Marketplace (`hardware`) — DEFERRED

Live used-GPU listings/prices (e.g. "Used RTX 4090 — $1,200 · +240% gain").

**Explicitly deferred from the roadmap this spec commits to**, for reasons that
are engineering, not cosmetic:

- **Data source risk:** scraping marketplaces likely violates ToS; third-party
  price APIs have cost, rate limits, and licensing constraints.
- **Freshness/liability:** live prices go stale in hours; presenting them as
  current invites the exact trust failure Principle 3 forbids.
- **Dependency creep:** a live feed adds network + a runtime dependency, against
  base-spec Boundaries.

**If pursued later**, it must be a **pluggable, opt-in data provider** behind an
interface (like `BackendAdapter`), with an offline default that uses the same
versioned ComponentDB. No provider ships enabled by default in v1.

---

## 9. Architecture & Module Layout

New code lives under `src/advisor/` (one concern per file, named exports only,
explicit return types, no `any` — base conventions hold):

```
src/advisor/
  score.ts        # Phase 1: AI Hardware Score + bottleneck (pure)
  throughput.ts   # Phase 2/3/4: tok/s roofline estimator (pure)
  verdict.ts      # Phase 2: yes|slow|no from fits() + throughput (pure)
  plan.ts         # Phase 3: upgrade-set search over ComponentDB (pure)
  build.ts        # Phase 4: budget-constrained selection (pure)
  components.ts   # ComponentDB load + Zod schema + staleness check
src/commands/
  can-run.ts      # thin CLI wrapper → verdict
  plan.ts         # thin CLI wrapper → plan
  build.ts        # thin CLI wrapper → build (v1.1)
data/
  components.json # versioned ComponentDB (generatedAt, priceAsOf)
```

- **Purity boundary:** everything in `src/advisor/` is a pure function of its
  inputs. Detection, catalog load, and I/O stay in commands (dependency-injected,
  same pattern as `DoctorDeps`), so the advisor is fully unit-testable with
  fixtures and never touches the network in tests.
- **Reuse, don't fork:** `score`, `throughput`, `verdict`, `plan`, `build` all
  consume `memory-math.ts` for sizing. No parallel memory formula is permitted.

### Types (added to `types.ts`, dependency-free)

```
type Bottleneck = "vram" | "ram" | "compute" | "storage";
type Runnable   = "yes" | "slow" | "no";
interface ThroughputEstimate { lowTokPerSec: number; highTokPerSec: number; known: boolean; }
interface HardwareScore { total: number; sub: Record<Bottleneck,number>; bottleneck: Bottleneck; }
interface ComponentPrice { lowUsd: number; highUsd: number; asOf: string; }  // ISO date
```

---

## 10. CLI Surface additions

| Command | One-liner | Purpose | Phase |
|---|---|---|---|
| `doctor` | `local-llmup doctor` | now also prints AI Hardware Score + bottleneck | 1 |
| `can-run` | `local-llmup can-run <model>` | single-model yes/slow/no verdict + reason | 2 |
| `plan` | `local-llmup plan <model>` | upgrade paths to run a target model | 3 |
| `build` | `local-llmup build --budget <n>` | best build for a budget | 4 (v1.1) |
| `hardware` | _(deferred)_ | live marketplace advisor | 5 (deferred) |

All support `--json` for scripting (consistent with existing commands).

---

## 11. Security, Privacy & Trust

- **No hardware fingerprint leaves the machine.** All advisor math is local; the
  ComponentDB ships in the package. (Consistent with base spec: no telemetry.)
- **Untrusted input validation:** `--budget`, model ids, and `components.json`
  are Zod-validated at the boundary; component ids constrained to a safe charset.
- **No purchase links / affiliate URLs** in v1 (avoids trust + policy issues and
  the base-spec rule against generating vendor URLs).
- **Estimate labeling** (Principle 1 & 3) is a *security-of-trust* requirement,
  not just UX: throughput ranges and dated prices are mandatory in output.

---

## 12. Testing Strategy

- **TDD**, Vitest, mock all I/O — never hit a real registry, network, or GPU.
- **Fixtures:**
  - `hardware profiles`: low/mid/high + degenerate (no GPU, unknown vendor).
  - `throughput calibration set`: published (hw, model) → tok/s pairs; AC6 range
    containment ≥80%.
  - `ComponentDB fixture`: small deterministic DB for `plan`/`build` tests.
- **Property-style checks:** every `plan`/`build` recommendation is re-validated
  by feeding the synthetic post-upgrade profile back through `verdict`/`fits()`
  (AC11, AC16) — the tool must never claim a build works unless its own verdict
  engine agrees.
- **Determinism tests:** advisor output stable across runs given fixed reference
  date + datasets.
- Coverage targets from base spec apply (`src/advisor/**` treated like
  `src/ranking/**`: ≥80% lines/branches).

---

## 13. Open Questions / Decisions Needed

1. **Throughput calibration provenance.** Which community benchmark sources seed
   `efficiency` constants, and how are they versioned/attributed? (Blocks AC6.)
2. **Price maintenance cadence.** Manual curation vs. a future enrichment PR bot
   for `components.json`; staleness threshold value (proposed: 90 days).
3. **Currency handling.** v1 assumes a single currency magnitude; do we localize
   or stay currency-agnostic with a `--currency` label only?
4. **Comfort tok/s floor.** The `COMFORT_FLOOR` constant separating `yes` vs
   `slow` — proposed default ~10 tok/s; needs sign-off.
5. **Scope gate for Phase 4** — ship in v1 or hold to v1.1 until ComponentDB
   pricing has a maintenance owner?

---

## 14. Rollout

1. **v1.0 (advisor core):** Phase 1 (`doctor` score) + Phase 2 (`can-run`,
   `recommend` verdicts). No pricing data — pure capability + throughput. Lowest
   risk, highest daily value, no maintenance liability.
2. **v1.1 (planner):** Phase 3 (`plan`) + ComponentDB (specs first, prices
   dated). Phase 4 (`build`) once a price-maintenance owner is assigned.
3. **v2 (marketplace):** Phase 5 behind an opt-in provider interface, only if the
   ToS/data-freshness questions in §8 are resolved.

Each phase is independently shippable and independently testable.
