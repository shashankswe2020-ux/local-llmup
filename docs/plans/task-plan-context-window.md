# Implementation Plan: local-llmup — Context-Window-Aware Sizing

> Source spec: [docs/specs/context-window-sizing.md](../specs/context-window-sizing.md)
> Extends: [task-plan-hardware-advisor.md](./task-plan-hardware-advisor.md) (advisor core T32–T39 shipped as v0.2.0)
> Status: **Approved — decisions D6–D11 signed off (defaults accepted 2026-08-06); ready to implement**
> Last updated: 2026-08-06

## Overview

Add a **context-length dimension** to `recommend` via two flags:
`--context <tokens>` (size KV cache at a chosen window and re-rank) and
`--max-context` (report the largest context each model can hold). The KV cache
grows linearly with context and, at long windows, exceeds the weight footprint —
the highest-value missing dimension in the "does it fit?" answer.

Every sizing computation is a **pure function** in `hardware/memory-math.ts`;
`recommend.ts` stays a thin renderer with injected I/O. The default (no-flag)
path is **unchanged** — the context path is strictly additive (spec Principle 4),
and the context footprint is **floored at the legacy footprint** so it can never
be more optimistic (spec §4.3).

## Blocking decisions (SIGNED OFF — defaults accepted 2026-08-06)

Continues the advisor register (D1–D5). See spec §5. All accepted with the
proposed defaults; implementation may proceed.

| # | Decision | Blocks | Accepted default | Status |
|---|---|---|---|---|
| D6 | KV-per-token source: per-model `kvBytesPerToken` (fp16), honesty-gated | T-CW1 | Option A (catalog field); params-heuristic rejected | ✅ Accepted |
| D7 | No-flag default legacy footprint + `ACTIVATION_OVERHEAD_FRACTION` + inversion floor | T-CW1 | Legacy unchanged; context path = `max(legacy, weights + KV + 5 %)` (never more optimistic) | ✅ Accepted |
| D8 | Add `context-bound` to `FitReason` | T-CW3 | Yes | ✅ Accepted |
| D9 | `--max-context`: headroom-adjusted budget, clamp-to-0, ranker quant, `model`/`hardware`/`unknown` label | T-CW4 | Yes | ✅ Accepted |
| D10 | KV precision fp16-only in v1 | T-CW1 | Yes; `--kv-cache` deferred | ✅ Accepted |
| D11 | Backfill formula scope: MHA/GQA only; explicit `head_dim`; MLA → honesty gate | T-CW2 | Yes | ✅ Accepted |

## Dependency graph

```
D6 ► T-CW1 kv sizing (memory-math: kvBytesPerToken, requiredMemoryAtContext w/ inversion floor, maxContextTokens)
  {T-CW1,D7,D11} ► T-CW2 catalog field + Zod schema + curated backfill (MHA/GQA only; data/models.json)
        {T-CW1,T-CW2,D8} ► T-CW3 evaluateFitAtContext (+ context-bound) + rankModels context seam + verdict passthrough
                 {T-CW3,D9} ► T-CW4 recommend --context / --max-context (columns, JSON, validation)
                        T-CW4 ► T-CW5 docs: README + site + spec status flip
── Checkpoint: context-window sizing shippable (v0.3.0) ──
```

Sequential by construction (each task depends on the prior). No parallelism —
the chain is short and every task builds on the pure functions below it.

## Cross-cutting conventions (every task)

- Pure core, injected I/O; no network/fs/GPU in unit tests.
- **Backward-compat guard (AC-CW9) is four-channel:** golden text equality +
  deep-equal JSON + identical key set + a codepath spy proving the no-flag path
  calls the legacy footprint fn and never the context fns.
- Honesty gate: missing `kvBytesPerToken` → `unknown`, never a fabricated number
  (AC-CW6) — a *memory-safety* control, tested at the unit level (authoritative)
  and once at the command level (rendering/no-crash only).
- Memory-safety invariants (inversion floor, headroom budget, floor, clamp,
  boundary) tested as **unit** arithmetic invariants; wiring/rendering gets one
  command test each.
- Determinism test for every renderer, across text AND JSON (AC-CW10).
- Registry parity + `--help` test unaffected (no new command, only flags).
- Run the full suite after every task; never mix formatting with behavior.

---

## Task list

### T-CW1: KV cache sizing math (pure) — **D6, D7, D10** ✅ DONE (2026-08-06)
**Description:** In `hardware/memory-math.ts` add pure functions:
`kvBytesPerToken(model)` (reads the sourced fp16 figure, `undefined` when absent),
`requiredMemoryAtContext(model, quant, tokens)` = `max(legacyFootprint, weights +
KV(tokens) + ceil(weights × ACTIVATION_OVERHEAD_FRACTION))` (the `max` floor kills
the inversion footgun), and `maxContextTokens(model, quant, budgetBytes)`
(closed-form inverse, **floored**, **clamped to 0**; budget is the caller's
headroom-adjusted value). Add `ACTIVATION_OVERHEAD_FRACTION` as a named constant.
No I/O; reuses the existing weight/param helpers.
**Acceptance (AC-CW1–3, CW11, CW13–16, CW20):**
- [x] `kvCacheBytes(tokens)` exactly linear + one formula-anchored exact case (128 KiB/tok × 32K = 4 GiB); `tokens=0` → 0.
- [x] `requiredMemoryAtContext` = `max(legacy, weights + KV + slack)`; inversion guard `≥ legacy ∀ t` (CW14).
- [x] `maxContextTokens` exact inverse under supplied budget (CW3); floors (CW13); clamps to 0 when the **legacy footprint** exceeds budget, not merely weights+slack (CW16); honors the supplied adjusted budget (CW15).
- [x] Missing `kvBytesPerToken` → `undefined` sentinel, not a guess (CW6-unit); present-but-invalid → `ValidationError`.
- [x] Ceiling `--context` value sizes without numeric overflow; safe-integer product guard (CW20).
- [x] `weightBytes` extracted as the shared resident-weight source of truth; legacy path byte-for-byte unchanged.
**Verify:** `npm test tests/hardware/memory-math` — **584 tests pass**, typecheck/build/lint clean.
**Review:** code-reviewer found C1 (maxContextTokens clamped on weights+slack, not the legacy floor → could report an unreachable ceiling / OOM). Fixed: clamp now tests `requiredMemoryBytes > budget`; added I1 per-token validation + N1/N2 guards; regression tests added.
**Deps:** D6, D7, D10 **Files:** `src/hardware/memory-math.ts`, `src/types.ts` (`kvBytesPerToken?`), `tests/hardware/memory-math.test.ts` **Scope:** M

### T-CW2: Catalog `kvBytesPerToken` field + schema + curated backfill — **D8, D11**
**Description:** Add optional `kvBytesPerToken` (positive integer, fp16 B/token) to
`CatalogModel` + Zod schema (reject ≤0 / non-integer / non-finite). Backfill a
first tranche of popular **MHA/GQA** models in `data/models.json` from published
attention geometry (`2 × layers × kvHeads × headDim × 2`), reading **explicit
`head_dim`** when the config publishes it (fall back to `hidden_size/nHeads` only
when absent — under-counting is unsafe). **MLA models (DeepSeek) and any
non-standard attention are left absent** (honesty gate) until a correct figure is
curated. Keep the legacy footprint path untouched (D7).
**Acceptance:**
- [x] Schema accepts the optional field, rejects invalid values (≤0 / non-integer / non-finite) at the boundary.
- [x] Backfilled MHA/GQA models (17: Llama 3.x, Qwen2.5 + coder, Mistral) carry a geometry-derived `kvBytesPerToken`; a machine-checked geometry ledger in the test asserts `value == 2×2×L×kv×hd`.
- [x] MLA (DeepSeek-V2/V3, R1-671B) and sliding-window (Gemma 2/3) carry **no** `kvBytesPerToken` (→ `unknown`), never the wrong generic number.
- [x] Curated via the bootstrap pipeline (`KV_BYTES_PER_TOKEN_FP16` table), `data/models.json` regenerated; `enrich` preserves it across refresh (mirrors `benchmarkProxy`). No-flag footprint unchanged.
**Verify:** `npm test tests/catalog tests/hardware/memory-math` — **599 tests pass**, typecheck/build/lint clean.
**Review:** code-reviewer APPROVE. Verified all 17 figures arithmetically + against published configs (incl. the D11 explicit-`head_dim` traps for Nemo/Small). Addressed Important finding (replaced tautological test with a derived geometry ledger) + N3 (pinned Mistral upstream revisions). Offline caveat: geometry cross-checked from model knowledge, not a live HF fetch.
**Note:** In-flight branch `copilot/context-window-model-sizing` inspected — stale (predates v0.2.0 advisor work), nothing to reconcile.
**Deps:** T-CW1, D8, D11 **Files:** `src/catalog/schema.ts`, `src/catalog/bootstrap.ts`, `src/catalog/enrich.ts`, `data/models.json`, tests **Scope:** M ✅ DONE (2026-08-06)

### T-CW3: `evaluateFitAtContext` + `context-bound` + rank seam (pure) — **D8**
**Description:** Add `evaluateFitAtContext(model, hw, tokens)` reusing
`evaluateFit`'s budget rule but with `requiredMemoryAtContext`. Extend `FitReason`
with `context-bound` (returned when `tokens > model.contextLength`; boundary
inclusive — `tokens == contextLength` fits). **Thread an optional `context`
through `RankOptions`/`rankModels`** so `--context` actually **re-ranks** (fit
score reflects the context-sized footprint), not just re-verdicts (review B3).
Wire the optional context through `verdict` (throughput unaffected in v1).
**Acceptance (AC-CW4, CW5, CW12, CW6-unit):**
- [x] Fits at default context but not at 128 K → won't-fit, **memory** reason (not context-bound) (CW4).
- [x] `tokens > model.contextLength` → `context-bound`; `tokens == contextLength` fits (CW5, CW12).
- [x] `rankModels` with context routes through `evaluateFitAtContext`; `requiredBytes`/fit score reflect the context footprint (re-ranks, not just re-verdicts — B3).
- [x] Unknown `kvBytesPerToken` → context evaluation falls back to weights-based fit; model still ranks (CW6). Cap check runs first, so over-cap unknown-geometry is still `context-bound`.
**Verify:** `npm test tests/ranking tests/advisor/verdict` — **611 tests pass**, typecheck/build/lint clean.
**Review:** code-reviewer APPROVE (no Critical/Important). Confirmed the `evaluateFit` refactor is byte-identical, the fixed-context quant monotonicity holds, and no other exhaustive `FitReason` map breaks (added `context-bound` to can-run's `REASON_LABEL`). Applied two nice-to-haves: fail-loud invariant instead of a silent `??` fallback in the known-geometry callback (memory-safety defense-in-depth), and tightened the verdict throughput doc. Deferred to T-CW4: friendly `context-bound` label in `recommend`'s won't-fit section.
**Deps:** T-CW1, T-CW2, D8 **Files:** `src/ranking/fit.ts`, `src/ranking/rank.ts`, `src/advisor/verdict.ts`, `src/commands/can-run.ts`, tests **Scope:** M ✅ DONE (2026-08-06)

### T-CW4: `recommend --context` / `--max-context` (command) — **D9**
**Description:** Parse `--context <int>` and `--max-context` (mutually exclusive;
Zod-validated integer, ceiling ≥ largest catalog `contextLength`). `--context`:
add Weights / KV@N columns, re-rank + verdict; won't-fit shows the memory or
`context-bound` reason. `--max-context`: add Max Context + Bound-By columns via
`maxContextTokens` (headroom-adjusted budget, clamp-to-0, ranker-selected quant),
clamped to `model.contextLength`, labeled `model`/`hardware`/`unknown`. `--json`
gains fields **additively** (incl. `"kvPrecision":"fp16"`). Thin renderer;
delegates to pure fns.
**Acceptance (AC-CW6-cmd, CW7, CW8, CW10, CW17–19):**
- [ ] `--context` columns + JSON; won't-fit reasons correct.
- [ ] `--max-context` reports `min(memoryMaxTokens, model cap)` + binding label; smaller quant → larger max (CW19).
- [ ] Mutual-exclusion + invalid `--context` (`0`, negative, non-numeric, non-integer, over ceiling) → clear error, non-zero exit (CW8).
- [ ] `unknown` rows never crash; mixed known/unknown rank + JSON order stable (CW17); JSON additive-only (CW18); deterministic text+JSON (CW10).
**Verify:** `npm test tests/commands/recommend tests/cli`
**Deps:** T-CW3, D9 **Files:** `src/commands/recommend.ts`, `src/output.ts` (if new columns), tests **Scope:** M

### T-CW5: Docs — README + site + spec status
**Description:** Document both flags (README commands/examples, site feature/setup
card) and flip `context-window-sizing.md` status to reflect shipped scope.
**Acceptance:**
- [ ] README shows `--context` and `--max-context` usage + example output.
- [ ] Site mentions context-aware sizing; example refreshed.
- [ ] `packs only publish-safe files` shipping test still passes.
**Verify:** `npm test tests/shipping`
**Deps:** T-CW4 **Files:** `README.md`, `site/index.html`, `docs/specs/context-window-sizing.md` **Scope:** S

> **Checkpoint (v0.3.0):** `recommend --context <n>` and `recommend --max-context`
> ship; KV cache sized from sourced geometry with an honesty gate; no-flag behavior
> unchanged. `npm run build && npm run typecheck && npm run lint && npm test` all
> green; coverage gate met.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| KV under-estimated → false "fits" (OOM) | Source geometry from data (D6/Option A); GQA-correct; missing → `unknown`, never a guess (AC-CW6). |
| Small `--context` flips won't-fit → fits (inversion) | Context footprint floored at legacy via `max()`; monotone-≥-legacy invariant (D7, AC-CW14). |
| `--context` re-verdicts but doesn't re-rank | Thread context through `rankModels`/`RankOptions` (T-CW3, review B3). |
| MLA (DeepSeek) / independent `head_dim` → wrong sourced number | Generic formula only for MHA/GQA; explicit `head_dim`; MLA → honesty gate (D11, T-CW2). |
| `--max-context` inflated by ignoring headroom or negative | Headroom-adjusted budget + clamp-to-0 + floor (D9, AC-CW13/15/16). |
| Double-counting KV with legacy 15 % overhead | `max(legacy, explicit)` selects one, never sums; no-flag path unchanged (D7, AC-CW9). |
| Conflicting in-flight branch schema | Reconcile `copilot/context-window-model-sizing` before T-CW2 (spec §12.1). |
| Catalog backfill effort | Backfill top-N MHA/GQA first; remainder degrades to `unknown` gracefully. |

## Files to deliver (summary)

- Math: `src/hardware/memory-math.ts` (+3 pure fns, `ACTIVATION_OVERHEAD_FRACTION`)
- Fit/rank/verdict: `src/ranking/fit.ts` (+`context-bound`), `src/ranking/rank.ts` (context seam), `src/advisor/verdict.ts`
- Command: `src/commands/recommend.ts` (+2 flags, columns, JSON)
- Types/data: `src/types.ts` (`kvBytesPerToken?`), catalog Zod schema, `data/models.json` backfill (MHA/GQA)
- Docs: `README.md`, `site/index.html`, spec status
- Tests mirroring each module under `tests/`
