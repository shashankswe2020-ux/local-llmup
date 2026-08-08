# Spec: local-llmup — Context-Window-Aware Sizing

> Status: **Shipped (v0.3.0)** — decisions D6–D11 implemented across tasks
> T-CW1–T-CW5; `recommend --context <n>` and `recommend --max-context` ship with
> KV cache sized from sourced attention geometry behind an honesty gate, and the
> no-flag path is unchanged. Approved v0.2 on 2026-08-06.
> Last updated: 2026-08-06
> Extends: [hardware-advisor.md](./hardware-advisor.md) and
> [local-llmup.md](./local-llmup.md). Adds a **context-length dimension** to the
> existing fit / verdict / recommend pipeline. Does not replace either base spec.

## 1. Objective

Today `recommend`, `can-run`, and `evaluateFit` answer "does it fit?" using a
**context-independent** memory footprint: resident weights plus a flat 15 %
runtime-overhead margin (`RUNTIME_OVERHEAD_FRACTION` in `hardware/memory-math.ts`).
That margin is a stand-in for "KV cache + activations + allocator slack" at some
unstated, small context. It is silent about the single biggest variable in
real-world memory pressure: **the context window**.

The KV cache grows **linearly with context length** and, at long contexts,
routinely exceeds the weight footprint. A model that fits comfortably at 4 K
tokens can OOM at 128 K. Users on r/LocalLLM ask this constantly: _"Can I run
Qwen3 14B at 32K context?"_ and _"What's the longest context my machine can hold
for this model?"_

This spec adds two `recommend` flags that answer exactly those questions:

- `local-llmup recommend --context <tokens>` — re-rank and re-verdict every model
  at a **specified** context window, sizing the KV cache explicitly.
- `local-llmup recommend --max-context` — report, per model, the **largest**
  context window this machine can hold (bounded by both memory and the model's
  own advertised `contextLength`).

### Target users

- Developers sizing a machine to a **workload** (long-context RAG, agents,
  large-document summarization), not just to a model name.
- Enthusiasts comparing models by usable context on fixed hardware.
- Anyone scripting a gate ("only run if it fits at my required context").

### Non-goals (v1 of this feature)

- KV-cache **quantization** selection (q8_0 / q4_0 KV). v1 sizes KV at **fp16**
  only; a `--kv-cache` flag is a documented follow-up (§9).
- Prompt-processing (prefill) memory spikes beyond the steady-state KV + weights.
- Per-layer or sliding-window attention modeling (e.g. Gemma's local/global
  layers) — v1 uses a single per-model KV-per-token figure; refinements are
  future work behind the same honesty gate.
- Changing the **default** (no-flag) behavior of `recommend`/`can-run` — see D7.

---

## 2. Design Principles (inherited, non-negotiable)

These are the advisor principles ([hardware-advisor.md](./hardware-advisor.md) §2)
applied to context sizing. The KV-cache number is **memory-safety-critical**:
under-estimating it makes the tool claim a model fits when it will OOM. That
raises the bar above the throughput estimate.

1. **Every number is sourced or honestly unknown.** KV-per-token is derived from
   real model **attention geometry** (layers × KV heads × head-dim), sourced from
   data — never guessed from parameter count. A model whose geometry is unknown
   reports context answers as **`unknown`**, exactly like the throughput honesty
   gate (`matchPerf` miss → `known:false`).
2. **Reuse the single source of truth.** Context sizing extends
   `hardware/memory-math.ts`; no command re-implements memory math. The
   context-aware footprint and the legacy footprint share one module.
3. **Determinism.** Output is a pure function of `(HardwareProfile, Catalog,
PerfDataset, context input)`. Same inputs → identical output.
4. **Backward compatibility.** With no context flag, `recommend`/`can-run` behave
   **byte-for-byte as today** (D7). The context path is strictly additive in v1.
5. **Graceful degradation.** If KV geometry is missing for a model, that model
   still ranks by weights (legacy path) and its context column reads `unknown` —
   the feature degrades per-row, never crashes the command.

---

## 3. The two commands

### 3.1 `recommend --context <tokens>`

Re-evaluates fit, verdict, throughput, and ranking with the KV cache sized for
`<tokens>`. The memory budget check becomes:

```
requiredAtContext(model, quant, tokens) = weightBytes(model, quant)
                                        + kvCacheBytes(model, tokens, fp16)
                                        + activationOverhead(model, quant)
   fits ⇔ requiredAtContext ≤ usableMemory × (1 − HEADROOM)   (unchanged budget rule)
```

A model can now leave the "fits" set for a **new** reason: it fit at the default
context but the requested KV cache pushes it over budget. The won't-fit `reason`
stays `ram-bound` / `vram-bound` (it _is_ a memory shortfall), so no new failure
taxonomy is needed for the memory case. A **separate** reason covers the case
where the requested context exceeds what the model itself supports (D8).

**Illustrative output** (labeled illustrative; numbers are examples):

```
$ local-llmup recommend --context 32768
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable) at 32,768-token context:

Rank  Model         Params  Quant   Weights  KV@32K   Est. Mem  Verdict  Est. tok/s  Score
   1  llama3.1:8b      8B    Q4_K_M  5.2 GiB  4.0 GiB   9.2 GiB  ✓ yes        28–52    0.41
   2  qwen3:14b       14B    Q4_K_M  9.6 GiB  3.5 GiB  13.1 GiB  ✓ yes        22–41    0.50
   3  gemma3:12b      12B    Q4_K_M  7.8 GiB  6.0 GiB  13.8 GiB  ⚠️ slow       8–15    0.47

Won't fit at 32,768 tokens (1):
  ❌ qwen3:30b-a3b  (ram-bound: KV cache at 32K exceeds memory)

Note: KV cache sized at fp16. Models without published attention geometry show
"unknown" and are ranked by weights only.
```

### 3.2 `recommend --max-context`

For each fitting model, report the **largest** context window the machine can
hold. Because KV scales linearly with tokens, the memory-bound maximum is a
closed form. Two rules are load-bearing for safety (both from review):

```
budget          = usableMemory × (1 − HEADROOM)          // SAME headroom-adjusted budget as evaluateFit
memoryMaxTokens = max(0, floor( (budget − weightBytes − activationSlack) / kvBytesPerToken_fp16 ))
reportedMax     = min( memoryMaxTokens, model.contextLength )   // never exceed the model's own limit
```

- **Budget is headroom-adjusted** (`usable × (1 − HEADROOM)`), never raw usable —
  using raw usable would inflate the reported max and risk OOM (review S5).
- **Clamp to 0** when the weights alone exceed the budget (`memoryMaxTokens` would
  go negative) — such a model is excluded from `--max-context` (review S4).
- **Quant selection:** `--max-context` sizes with the **same quant the ranker
  selected** for that model (the highest-quality quant that fits) — consistent
  with the `recommend` table. A lower quant would raise the ceiling; a one-line
  note says so (review S3).

Report `reportedMax` and label the **binding** bound with an enumerated value —
`model` (advertised cap; more RAM won't help), `hardware` (memory; more RAM/VRAM
would raise it), or `unknown` (no geometry). A tie (`contextLength ==
memoryMaxTokens`) labels `model`, since the model cap is the true ceiling.

**Illustrative output:**

```
$ local-llmup recommend --max-context
Max usable context per model on arm64/darwin (34.0 GiB ram usable):

Rank  Model         Params  Quant   Max Context  Bound By    Verdict
   1  llama3.1:8b      8B    Q4_K_M      128,000  model cap   ✓ yes
   2  qwen3:14b       14B    Q4_K_M       96,000  hardware    ✓ yes
   3  gemma3:12b      12B    Q4_K_M       40,000  hardware    ✓ yes
   4  qwen3:30b-a3b   30B    Q4_K_M            —   unknown     (no attention geometry)

"model cap" = limited by the model's advertised context; more RAM won't help.
"hardware"  = limited by memory; more RAM/VRAM would raise this.
```

`--context` and `--max-context` are **mutually exclusive** (D-validation in §8).

---

## 4. The core: context-aware memory model

### 4.1 KV cache formula

```
kvBytesPerToken_fp16 = 2 (K and V) × nLayers × nKvHeads × headDim × 2 bytes
kvCacheBytes(tokens, fp16) = kvBytesPerToken_fp16 × tokens
```

`nKvHeads` (not `nHeads`) is load-bearing: modern catalog models (Llama 3.x,
Qwen2.5/3, Gemma) use **grouped-query attention (GQA)**, where `nKvHeads ≪
nHeads`. Estimating KV from parameter count would over-count KV by 4–8× for
exactly the most popular models — which is why v1 sources geometry from data, not
from params (Principle 1). Example (Llama 3.1 8B: 32 layers, 8 KV heads, head-dim
128): `2 × 32 × 8 × 128 × 2 = 131,072 B/token` ≈ 128 KiB/token → **4 GiB at 32 K**,
**16 GiB at 128 K** — larger than the 5.2 GiB weights. This is the whole point.

### 4.2 Where the geometry comes from (D6)

The three attention numbers reduce to **one** derived figure per model:
`kvBytesPerToken` at fp16. The recommended design stores that single figure so
the runtime never re-derives geometry and the catalog stays the single source of
truth (mirrors how `minRamBytes` is precomputed):

- **Option A (recommended):** add an optional `kvBytesPerToken` (fp16, integer
  bytes) to `CatalogModel`, populated by curation/enrichment from published
  config (`config.json`: `num_hidden_layers`, `num_key_value_heads`,
  `head_dim`/`hidden_size`). Absent → honesty gate (`unknown`). Memory-safe:
  a missing number never silently defaults to an optimistic guess.
- **Option B (rejected):** approximate geometry from parameter count. Rejected —
  GQA makes it wrong by multiples for the popular models, and the error is on the
  **unsafe** side (under-estimating KV → false "fits").

**Curation rules for the generic formula (D11 — memory-safety-critical):**

- **`head_dim` must be read explicitly when the model config publishes it.**
  Modern models (Llama 3.2, Gemma 2/3, several Qwen3) set `head_dim`
  _independently_ of `hidden_size / num_attention_heads`. Deriving
  `hidden_size/nHeads` when an explicit `head_dim` exists can **under-count** KV
  → false "fits" (review S2). Fall back to `hidden_size/nHeads` only when no
  explicit `head_dim` is published.
- **MLA and other non-standard attention are NOT backfilled with the generic
  formula.** DeepSeek-V2/V3 use Multi-head Latent Attention: KV is a compressed
  latent, so `2 × layers × kvHeads × headDim × 2` over-estimates by ~5–10× — a
  _sourced-but-wrong_ number that violates the honesty principle (review S1).
  Until a correct per-model MLA figure is curated, such models carry **no**
  `kvBytesPerToken` and fall to the honesty gate (`unknown`). The generic
  formula applies **only** to standard MHA/GQA models.

MoE note: KV cache depends only on **attention** geometry, independent of the
expert/total-vs-active asymmetry. `kvBytesPerToken` is sourced per model
regardless of MoE vs dense; MoE models are not special-cased here.

### 4.3 Avoiding double-counting AND the inversion footgun (D7)

The current footprint adds a flat 15 % overhead that _implicitly_ included some
KV. When the KV cache is modeled **explicitly**, that 15 % must not double-count
it — but naively using a _smaller_ overhead on the context path creates a worse
bug (review B2): at a **small** `--context`, `weights + smallKV + smallSlack`
could be **less** than the legacy footprint, flipping a legacy won't-fit model to
"fits" (unsafe) and shrinking every model's "Est. Mem" when a small context is
named (confusing).

**The context footprint is therefore floored at the legacy footprint** so it can
never be more optimistic than the calibrated default path:

```
ACTIVATION_OVERHEAD_FRACTION = 0.05   // small activation/allocator slack over weights (D7, sourced default)
explicit = weightBytes + kvCacheBytes(tokens, fp16) + ceil(weightBytes × ACTIVATION_OVERHEAD_FRACTION)
requiredAtContext(model, quant, tokens) = max( legacyFootprint(model, quant), explicit )
```

Properties this guarantees:

- **Monotone-conservative:** `requiredAtContext(m, q, t) ≥ legacyFootprint(m, q)`
  for all `t ≥ 0` — a legacy won't-fit model can never become "fits" under any
  `--context` (review B2; AC-CW14).
- **No double-count:** at long context the explicit KV dominates and the `max`
  selects `explicit`; the legacy 15 % is not added on top.
- **Backward-compat (Principle 4):** the no-flag path calls the **legacy**
  `requiredMemoryBytes` unchanged — `requiredMemoryAtContext` is invoked _only_
  when a context flag is present. The `max()` floor makes the two consistent
  without re-baselining any existing fixture.
- The floor only binds at _small_ context; at the `--max-context` maximum the KV
  term dominates, so the closed-form inverse (§3.2) remains exact there
  (AC-CW3).

`ACTIVATION_OVERHEAD_FRACTION` is a named constant with a sourced, conservative
default (D7); unifying both paths behind a `DEFAULT_ADVISORY_CONTEXT` remains a
documented follow-up (§9).

---

## 5. Blocking decisions (SIGNED OFF — proposed defaults accepted 2026-08-06)

Continues the advisor decision register (D1–D5 in the base plan). All six
decisions below are **accepted with the proposed defaults**; implementation may
proceed against them.

| #   | Decision                                                           | Blocks       | Accepted default                                                                                                                                                                                                                                                                                             | Status      |
| --- | ------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| D6  | KV-per-token data source                                           | T-CW1        | **Option A**: per-model `kvBytesPerToken` (fp16) in catalog, honesty-gated; params-heuristic rejected.                                                                                                                                                                                                       | ✅ Accepted |
| D7  | No-flag default + `ACTIVATION_OVERHEAD_FRACTION` + inversion floor | T-CW1, T-CW2 | Keep legacy flat-15 % footprint on the no-flag path **unchanged**; context path = `max(legacyFootprint, weights + KV(tokens) + 5 % weights)` so it is never more optimistic than legacy (§4.3). Full unification deferred.                                                                                   | ✅ Accepted |
| D8  | New `FitReason` for `--context > model.contextLength`              | T-CW3        | Add `context-bound` to the `FitReason` union (distinct from memory shortfall).                                                                                                                                                                                                                               | ✅ Accepted |
| D9  | `--max-context` reporting                                          | T-CW4        | Report `min(memoryMaxTokens, model.contextLength)` against the **headroom-adjusted** budget; clamp to 0 when weights exceed budget; size with the ranker-selected quant; enumerated binding label `model` / `hardware` / `unknown`; raw floored token count (illustrative tables may round for readability). | ✅ Accepted |
| D10 | KV precision in v1                                                 | T-CW1        | **fp16 only**; `--kv-cache q8_0/q4_0` deferred (halve/quarter the per-token bytes) with its own honesty note.                                                                                                                                                                                                | ✅ Accepted |
| D11 | Backfill formula scope (attention family)                          | T-CW2        | Generic `2×L×kvHeads×headDim×2` applies **only** to MHA/GQA; read explicit `head_dim` when published; MLA (DeepSeek) and other non-standard attention → no `kvBytesPerToken` (honesty gate) until a correct figure is curated.                                                                               | ✅ Accepted |

---

## 6. Architecture & module layout

Additive, reuse-first. New pure sizing lives beside the existing memory math.

```
src/hardware/
  memory-math.ts     # + kvBytesPerToken(model), requiredMemoryAtContext(model, quant, tokens),
                     #   maxContextTokens(model, quant, budgetBytes)  — all pure, no I/O
src/ranking/
  fit.ts             # + evaluateFitAtContext(model, hw, tokens) reusing evaluateFit's budget rule;
                     #   FitReason gains "context-bound" (D8)
  rank.ts            # + optional `context` in RankOptions → routes rankModels through
                     #   evaluateFitAtContext so --context actually RE-RANKS, not just re-verdicts (review B3)
src/advisor/
  verdict.ts         # + evaluateVerdict accepts an optional context; throughput unaffected by context in v1
src/commands/
  recommend.ts       # + --context / --max-context parsing, columns, JSON fields (thin; delegates to pure fns)
data/
  models.json        # + optional kvBytesPerToken per model (curated/enriched); absence = honesty gate
```

- **`rank.ts` is the real re-ranking seam.** `buildRecommendation` ranks via
  `rankModels` → `evaluateFit`, and `fitScore` consumes `requiredBytes`. Threading
  context only through `verdict.ts` would re-verdict but **not** re-rank (review
  B3). `--context` therefore routes an optional context into `rankModels` so the
  fit score reflects the context-sized footprint.
- **Purity boundary preserved:** all sizing is a pure function of
  `(model, quant, tokens, budget)`. `recommend.ts` stays a thin renderer +
  dependency-injected I/O (same `RecommendDeps` pattern).
- **No new runtime dependency.** Zod already validates the catalog; the new
  optional field extends the existing schema.

---

## 7. Types & schema additions

```ts
// src/types.ts — CatalogModel gains one optional, dependency-free field:
readonly kvBytesPerToken?: number | undefined;   // fp16 KV bytes per token; absent → context "unknown"

// src/ranking/fit.ts — FitReason extended (D8):
export type FitReason = "ram-bound" | "vram-bound" | "disk-bound" | "context-bound";
```

Catalog Zod schema: `kvBytesPerToken` optional, **positive integer** when present
(reject ≤ 0 / non-finite / non-integer at the boundary).

---

## 8. CLI surface & input validation

| Flag                 | Type    | Validation                                                                                                                                                                                                                                                                                                                                                                                                                        | Behavior                                     |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `--context <tokens>` | integer | Positive integer; Zod-coerced at boundary; reject `0`, negatives, non-numeric, non-integer, and overflow-unsafe magnitudes with a clear non-zero-exit error. The ceiling is set **at or above the largest advertised `contextLength` in the catalog** (e.g. 100,000,000) so legitimate 10M-window models (Llama 4 Scout) are accepted; the per-model semantic cap is carried by `context-bound`, not the input guard (review N4). | Size KV at `<tokens>`; re-rank + re-verdict. |
| `--max-context`      | boolean | May not be combined with `--context` (clear error, non-zero exit).                                                                                                                                                                                                                                                                                                                                                                | Report per-model max context.                |

- Both remain compatible with `--json` and `--task` (consistent with existing
  `recommend`).
- `--context` **larger than a model's** `contextLength` → that model is won't-fit
  with reason `context-bound` (the model cannot serve that context at all),
  distinct from a memory shortfall (D8).
- Security: `--context` is untrusted numeric input parsed at the boundary; no
  interpolation into shell or paths; validated by Zod like all existing options.

---

## 9. Deferred / follow-ups (explicitly out of v1 scope)

- `--kv-cache <fp16|q8_0|q4_0>` — scale `kvBytesPerToken` by precision (D10). Adds
  an honesty note that quantized KV trades quality for context length.
- `can-run <model> --context <tokens>` — the same context sizing applied to the
  single-model verdict. Natural next task once the pure functions land.
- Unifying the legacy flat-overhead footprint with the context-parameterized
  footprint via a `DEFAULT_ADVISORY_CONTEXT` (D7 follow-up), re-baselining fixtures.
- Sliding-window / hybrid-attention per-layer KV modeling (Gemma local/global).

---

## 10. Testing strategy

TDD, Vitest, all I/O mocked — never hit a real registry, network, or GPU
(inherited conventions). Additional context-specific coverage:

- **Pure sizing unit tests** (`tests/hardware/memory-math.test.ts`):
  - `kvBytesPerToken` returns the sourced figure; `requiredMemoryAtContext`
    grows **linearly** with tokens; `maxContextTokens` is its exact inverse
    (round-trip: sizing at `maxContextTokens` is ≤ budget, `+1` token exceeds it).
  - Missing `kvBytesPerToken` → context sizing returns an `unknown` sentinel, not
    a fabricated number (honesty gate).
- **Fit at context** (`tests/ranking/fit.test.ts`): a model that fits at default
  context but not at 128 K flips to won't-fit with a **memory** reason;
  `--context > model.contextLength` yields `context-bound`.
- **Backward-compat guard:** with no context flag, `recommend`/`can-run`/`fit`
  output is unchanged (existing fixtures pass untouched — Principle 4).
- **Command tests** (`tests/commands/recommend.test.ts`): `--context` and
  `--max-context` columns + `--json` fields; mutual-exclusion error; invalid
  `--context` rejected with non-zero exit; determinism across runs.
- Coverage: `src/hardware/**` and new `src/ranking`/`src/advisor` paths held to
  the ≥80 % lines/branches advisor bar.

### Acceptance criteria (all verifiable)

Grouped by level. Memory-safety invariants (CW3, CW11, CW13–CW16) are the highest
priority — each guards a way the tool could falsely claim a model fits.

**Pure sizing math (unit):**

- **AC-CW1:** `kvCacheBytes(tokens)` is exactly linear — `tokens = 0` → 0;
  doubling `tokens` doubles KV bytes; **plus** one formula-anchored exact case
  (known geometry → exact byte count, not just self-consistency). (unit test)
- **AC-CW2:** `requiredMemoryAtContext(m, q, t) = max(legacyFootprint(m, q),
weights + kvCacheBytes(t) + ceil(weights × ACTIVATION_OVERHEAD_FRACTION))` with
  `ACTIVATION_OVERHEAD_FRACTION` a named constant. A spy proves the **no-flag**
  path calls the legacy `requiredMemoryBytes` and **never** calls
  `requiredMemoryAtContext`/`kvCacheBytes`. (unit test + codepath spy)
- **AC-CW3:** `maxContextTokens` is the exact inverse under the
  **headroom-adjusted** budget `B = usable × (1 − HEADROOM)`: sizing at the
  returned max is `≤ B`, and one token more is `> B`. (property-style test)
- **AC-CW11:** Budget boundary is inclusive: a footprint landing exactly on `B`
  **fits**; `B + 1` byte does not. (unit test — craft geometry to hit the byte
  boundary)
- **AC-CW13:** `maxContextTokens` **floors** (never rounds up): when the
  real-valued inverse is fractional, `size(maxContextTokens) ≤ B` strictly.
  (unit test)
- **AC-CW14:** Inversion guard — `requiredMemoryAtContext(m, q, t) ≥
legacyFootprint(m, q)` for all `t ≥ 0`; a legacy won't-fit model never becomes
  "fits" under any `--context` (tested at the smallest nonzero `t`). (unit test)
- **AC-CW15:** `maxContextTokens` uses the headroom-adjusted budget; a profile
  where raw vs adjusted differ enough to change the answer proves the adjusted
  budget is used. (unit test)
- **AC-CW16:** Clamp-to-0 — `weights > B` → `maxContextTokens === 0`, never
  negative, no crash. (unit test)
- **AC-CW20:** `--context` at the accepted ceiling sizes without numeric
  overflow and yields a coherent won't-fit on realistic hardware. (unit test)

**Fit / verdict (unit):**

- **AC-CW4:** A model with known `kvBytesPerToken` that fits at the default
  context but whose KV at `--context 131072` exceeds budget → won't-fit with a
  `ram-bound`/`vram-bound` reason, asserted **not** `context-bound`. (fit test)
- **AC-CW5:** `--context` exceeding a model's advertised `contextLength` →
  `context-bound`. (fit test)
- **AC-CW12:** Context cap is inclusive: `--context === model.contextLength`
  **fits** (memory permitting); `contextLength + 1` → `context-bound`. (fit test)
- **AC-CW6 (unit half):** Missing `kvBytesPerToken` → the sizing/fit path returns
  an `unknown` sentinel (`known:false`), never a fabricated number. (unit test —
  honesty gate, authoritative)

**Command / rendering (one thin test each — wiring, not re-testing invariants):**

- **AC-CW6 (command half):** An `unknown`-geometry model renders literal
  `unknown` in the context/max-context column, is **not** dropped, and still ranks
  by weights. (command test)
- **AC-CW7:** `--max-context` reports `min(memoryMaxTokens, model.contextLength)`
  against the headroom-adjusted budget, sized with the ranker-selected quant, and
  labels the binding bound with the enumerated value `model` / `hardware` /
  `unknown` (tie → `model`). (command test)
- **AC-CW17:** In a mixed fixture (known + unknown geometry), rank order is stable
  and the `--json` array order matches the table order. (command test)
- **AC-CW18:** JSON is additive-only — no-flag JSON contains **none** of the new
  fields; `--context`/`--max-context` add fields (including `"kvPrecision":
"fp16"`) and change nothing else. Asserted by key-set diff, not just values.
  (command test)
- **AC-CW8:** `--context` + `--max-context` together → clear error, non-zero exit;
  each invalid `--context` (`0`, negative, non-numeric, non-integer, above the
  ceiling) → clear error, non-zero exit (enumerated one `it` each). (command test)
- **AC-CW19:** `--max-context` for the same model at a smaller quant reports a
  larger max context (documents quant-dependence). (command/unit test)

**Cross-cutting:**

- **AC-CW9 (four-channel backward-compat guard):** With no new flag —
  (a) **text**: byte-for-byte equal to a pre-feature golden for every existing
  `recommend`/`can-run` fixture; (b) **json**: deep-equal to baseline **and**
  identical key set; (c) **codepath**: the legacy footprint fn is called and the
  context fns are not (spy); (d) the existing suite passes untouched. (regression)
- **AC-CW10:** Deterministic — identical `(hardware, catalog, perf, context
input)` → identical **text and JSON**; no `Date.now()`/`Math.random` leak
  (stable across a mocked clock boundary). (determinism test)

> **Throughput honesty note (review N2):** tok/s in v1 is context-independent
> (short-context decode). Long context measurably lowers decode speed, so the
> output carries a one-line note that the tok/s range assumes short-context
> decode. Modeling context-dependent throughput is deferred.

---

## 11. Security, privacy & trust

- **Untrusted input:** `--context` is validated at the boundary (positive
  integer, bounded magnitude) with Zod; rejected values fail closed with a
  non-zero exit. No value is interpolated into shells, paths, or the network.
- **No network, no telemetry:** all sizing is local and pure; the catalog ships
  in-package. Consistent with base-spec boundaries.
- **Memory-safety framing:** the honesty gate here is a _safety_ control — an
  absent/invalid `kvBytesPerToken` must degrade to `unknown`, never to an
  optimistic default that could tell a user a model fits when it will OOM.

---

## 12. Open questions / coordination

The blocking decisions (D6–D11) are **signed off** (§5). The items below are the
remaining coordination/follow-up notes, not gates on starting implementation.

1. **In-flight branch (coordination — do before T-CW2).** A remote branch
   `copilot/context-window-model-sizing` appears to explore this area. Diff it
   against this spec and reconcile: adopt any already-sourced geometry data, and
   align the field name (`kvBytesPerToken`) and `FitReason` addition to avoid a
   conflicting schema. (Could not be inspected while drafting — flagged for the
   implementer.)
2. **`ACTIVATION_OVERHEAD_FRACTION` (D7 — accepted at 5 %).** Locked at 5 % of
   weights; the `max(legacy, …)` floor guarantees conservatism at any value
   ≤ 15 %. Optional post-hoc calibration against real resident-set measurements
   may refine the constant later but is **not** a gate on T-CW1.
3. **MLA figures (D11 — accepted, gate honesty).** DeepSeek/MLA models start on
   the honesty gate (`unknown`). Curating correct per-model MLA KV figures (so
   they leave `unknown`) is a documented follow-up.
4. **Catalog backfill scope (D6 — accepted, top-N first).** First pass backfills
   the top-N popular MHA/GQA models; the rest degrade to `unknown` until
   enriched. Exact model list is chosen during T-CW2.
5. **KV precision (D10 — accepted fp16-only).** v1 is fp16-only; `--kv-cache`
   deferred (§9).

---

## 13. Task breakdown (companion plan)

Detailed, dependency-ordered tasks live in
[../plans/task-plan-context-window.md](../plans/task-plan-context-window.md)
(T-CW1 … T-CW5), gated on decisions D6–D11.
