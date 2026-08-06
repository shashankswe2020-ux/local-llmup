# Code Review Checkpoint 17: Task B8 — `backendsForModel` + source-key→`ModelFormat` map

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-06
> **Scope:** Task B8 (Phase 1 of the pluggable-backends plan) — two uncommitted files. `src/catalog/backends.ts` exports `formatsForModel(model)` (maps a `CatalogModel.source`'s keys → servable `ModelFormat[]` via the ordered `SOURCE_KEY_FORMATS` table: `ollama→ollama`, `gguf→gguf`, `mlx→mlx`; `hf` advisory-only → no format) and `backendsForModel(model, registry)` (registered adapters whose `capabilities.formats` intersect the model's mapped formats, in registration order). `tests/catalog/backends.test.ts` adds 15 unit tests.
> **Test suite:** 735/735 passing (49 files); typecheck ✅; lint ✅ (on both B8 files); build ✅.

---

## Verdict: ✅ APPROVE

**Overview:** A clean, correct, minimal mapping layer. Every B8 acceptance criterion is met and directly tested: an Ollama-only model returns `["ollama"]` (annotated, never dropped), a `gguf`+`ollama` model returns both `ollama` and `llamacpp` (when registered), and an `hf`-only model matches no backend. The module is *pure* — every import is `import type`, so `backends.ts` carries zero runtime coupling into `src/catalog` and cannot introduce a `catalog → backend` cycle. No Critical or Important findings. Three low-priority Suggestions below.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. The dedup guard in `formatsForModel` is currently unreachable
- **File:** `src/catalog/backends.ts:31-35`
- `!formats.includes(format)` can never be false given `SOURCE_KEY_FORMATS` maps each source key to a **distinct** `ModelFormat` (`ollama`/`gguf`/`mlx`). The guard is harmless defensive code, but it reads as if duplicate formats are expected. Either drop it (the table's distinctness is the real invariant) or add a one-line comment noting it guards a hypothetical future where two source keys share a format. Minor.

### 2. No compile-time exhaustiveness over `ModelSource` keys
- **File:** `src/catalog/backends.ts:19-23`
- `SOURCE_KEY_FORMATS` is a value-level table, so adding a new servable source key to `ModelSource` (e.g. a future `awq`) and forgetting to add a row here would silently make that source **advisory-only** (non-servable) with no type error — a latent maintenance trap. `hf` is intentionally excluded, so full exhaustiveness cannot be trivially enforced, but a type-level reminder helps. Consider a `satisfies`-based guard or a comment coupling the table to `ModelSource` so the next editor is prompted to classify any new key as servable-vs-advisory. The existing JSDoc ("`safetensors` has no source key today", "`hf` is intentionally absent") partially covers this. Minor.

### 3. Missing a positive `mlx → mlx` case in `backendsForModel`
- **File:** `tests/catalog/backends.test.ts:98-141`
- `backendsForModel` is exercised for `ollama`, `gguf+ollama`, `hf`-only, an unregistered `gguf` backend, and registration-order — thorough. But there is no case asserting an `mlx`-source model resolves to the `mlx` adapter (the `mlx` path is only covered in `formatsForModel`). Adding `backendsForModel(modelWithSource({ mlx: validMlx }), registry).map(a => a.name)` → `["mlx"]` closes the last format's end-to-end path. Optional; coverage is already strong.

## What's Done Well

- **Zero runtime coupling.** Every import in `backends.ts` is `import type` — `BackendAdapter`, `BackendRegistry`, and the `types.ts` shapes all erase at compile time. The module is a set of pure functions over trusted, Zod-validated (B7) domain data, so placing it under `src/catalog` introduces no dependency cycle and no side effects. Exactly the right shape for advice-path code.
- **Determinism is baked in.** `SOURCE_KEY_FORMATS` fixes a canonical output order, and `backendsForModel` derives its order from `registry.all()` (registration order) rather than source order — proven by the `createRegistry([llamacpp, ollama])` test that asserts `["llamacpp", "ollama"]` regardless of the `{ollama, gguf}` source ordering. This keeps `recommend`/`can-run` reproducible.
- **The honesty gate is honored structurally.** `hf` maps to no format and no backend, but the model is never dropped — it simply reports an empty servable set, matching "annotated, never dropped." The advisory-vs-servable distinction is documented at the module, table, and function level.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 15 tests; all three AC directly asserted, plus registration-order, unregistered-backend omission, multi-source canonical order, and `hf`-ignored-when-other-sources-present. |
| Build verified | ✅ | `tsc` clean; `npm test` 735/735; typecheck clean; ESLint clean on both files. |
| Security checked | ✅ | Pure mapping over B7-validated trusted data; no network/fs/child-process/input parsing. No injection surface. |
| Coverage | ✅ | Both exported functions fully exercised; only a `mlx→mlx` positive path in `backendsForModel` is missing (Suggestion 3). |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Suggestion | Drop or comment the unreachable dedup guard in `formatsForModel` | backlog |
| 2 | Suggestion | Add a type-level exhaustiveness reminder coupling `SOURCE_KEY_FORMATS` to `ModelSource` | backlog |
| 3 | Suggestion | Add a `mlx → mlx` positive case to `backendsForModel` tests | backlog |
