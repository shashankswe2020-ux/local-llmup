# Code Review Checkpoint 19: Task B10

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B10 — Embedding capability gating: vector-less capture + `meta.json` flag across `capture` / `chat` / `migrate`
> **Test suite:** 759 tests passing (49 files), typecheck ✅, build ✅, lint ✅ on changed files (2 pre-existing errors in `site/main.js` are outside this diff)

---

## Verdict: ✅ APPROVE

**Overview:** B10 makes the embedding path `canEmbed`-aware. When the serving/target backend cannot embed, capture and migration proceed **vector-less** — no embedder is consulted, no vectors are fabricated, no hard failure — and the store's `meta.json` records `embeddingUnsupported: true` so the absence is legibly intentional. The gate is decided at the command layer from `adapter.capabilities.canEmbed` and passed to the memory layer as an explicit flag, keeping backend logic out of `src/memory/`. All three acceptance criteria are met and covered by tests. Two minor observations, none blocking.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. `meta.embedding` and `embeddingUnsupported` can coexist in the capture path
- **File:** [src/memory/capture.ts](../../src/memory/capture.ts#L307-L314)
- **Observation:** `markEmbeddingUnsupported` writes `{ ...meta, embeddingUnsupported: true }`, preserving any pre-existing `meta.embedding`. If a store built an index under an embed-capable backend and is later captured under a non-embed backend, `meta.json` ends with both `embedding` (a stale index descriptor) *and* `embeddingUnsupported: true` — a semantically ambiguous pair. In `migrate` the two are mutually exclusive (`planMigration` sets `embedding: undefined` whenever `embeddingUnsupported` is true, and `stageMigration` rebuilds `meta` from scratch), so this can only arise via `captureExchange`'s read-modify-write. Probability is low (a given model's serving backend rarely flips embedding capability, and it only becomes reachable once a second, non-embed backend serves an already-indexed model in B12+), and no reader consumes the flag yet, so nothing breaks today.
- **Recommendation:** Decide the intended invariant now while the surface is small. Either drop the stale index when flagging unsupported:
  ```ts
  function markEmbeddingUnsupported(config: Config, store: MemoryStore): void {
    const meta = readMemoryMeta(store.dir, store.modelId);
    if (meta.embeddingUnsupported === true && meta.embedding === undefined) {
      return;
    }
    const { embedding: _dropped, ...rest } = meta;
    writeMemoryMeta(config, store.dir, { ...rest, embeddingUnsupported: true });
  }
  ```
  …or document the coexistence semantics explicitly (flag wins; a future reader must ignore `embedding` when `embeddingUnsupported` is set). Leaving it as-is is defensible but leaves the invariant implicit.

### 2. Summary `embeddingStrategy: "none"` conflates "nothing to carry" with "target can't embed"
- **File:** [src/memory/migrate.ts](../../src/memory/migrate.ts#L368-L389)
- **Observation:** Both an empty source index and an unsupported target produce `embedding: undefined` and `summary.embeddingStrategy === "none"`. A consumer of the run summary can't distinguish "source had no vectors" from "target backend cannot embed." The real distinction is preserved in `meta.json` (`embeddingUnsupported`), so this is cosmetic, but the human-facing summary line loses the reason.
- **Recommendation:** Optional — surface the reason in `formatSummary` when `plan.embeddingUnsupported` is set (e.g. `embeddings: none (backend cannot embed)`), so the CLI output matches what `meta.json` records.

### 3. No symmetric chat-level assertion for the `canEmbed: true` byte-identical path
- **File:** [tests/commands/chat.test.ts](../../tests/commands/chat.test.ts#L192-L207)
- **Observation:** The new chat test asserts `embeddingUnsupported === true` when `canEmbed: false`, and `tests/memory/capture.test.ts` proves the meta flag is absent on the embed-capable path. There is no explicit command-level assertion that the `canEmbed: true` path passes `embeddingUnsupported === undefined` to `captureExchange`.
- **Recommendation:** Optional — add a mirror assertion (default harness, `expect(options.embeddingUnsupported).toBeUndefined()`) to fully lock the "byte-identical" claim at the command boundary.

## What's Done Well

- **Clean layering.** The gate is read from `adapter.capabilities.canEmbed` in the command layer and handed to the memory layer as a plain `embeddingUnsupported` flag; `src/memory/` never touches the adapter. This respects the BackendAdapter abstraction boundary exactly as the project principles require.
- **Honesty-gate-consistent schema.** `embeddingUnsupported: z.literal(true).optional()` models absence-means-supported and refuses to ever persist `false` — the flag can only assert an intentional absence, never a fabricated or contradictory "we tried and it's off" state. Strict schema rejects any other value.
- **Fail-open without fabrication.** `captureExchange` skips `prepareEmbedding` entirely under the flag (short-circuit before the `await`), so no fake vectors and no network call; the fallible embedding step remains fully bypassed rather than swallowed.
- **Ordering preserved.** `markEmbeddingUnsupported` runs after turns/facts are persisted and early-returns once flagged, so the embed-capable path is genuinely unchanged and the per-turn cost is at most one tiny `meta.json` read.
- **Symmetric, targeted tests** across capture (flag set, embedder ignored, capable path not flagged), chat (options wiring), migrate command (no `vectors.jsonl`, meta flagged), and migrate planner (index dropped, strategy `none`).

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 5 new tests reviewed; cover capture/chat/migrate/planner. Coverage strong; one optional symmetric assertion (Suggestion 3). |
| Tests pass | ✅ | 759/759 across 49 files. |
| Typecheck | ✅ | `tsc --noEmit` clean; conditional-spread option objects and inline `EmbeddingResult` shape type-check. |
| Build verified | ✅ | `tsc` build clean. |
| Lint | ✅ | Changed files lint clean; 2 pre-existing `no-undef` errors in `site/main.js` are unrelated to this diff. |
| Security checked | ✅ | No new external input; flag validated by strict Zod; meta write uses existing atomic `writeMemoryMeta` with `assertWithinRoot` containment. No secrets/network/shell. |
| Coverage | ✅ | Acceptance criteria 1–3 each have a proving test. |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Suggestion | Resolve `embedding` + `embeddingUnsupported` coexistence invariant in capture (drop stale index or document semantics) | backlog |
| 2 | Suggestion | Surface "backend cannot embed" reason in migrate run summary | backlog |
| 3 | Suggestion | Add symmetric `canEmbed:true` assertion in chat test | backlog |
