# Code Review Checkpoint 8: Task 25 (memory migration logic)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T25 — the pure, disk-free migration _logic_ (`src/memory/migrate.ts`, `tests/memory/migrate-logic.test.ts`). Computes a `MigrationPlan` from source memory + target context/embedding params: context remap (summarize/truncate/none) and embedding carry (reuse/re-embed/none). Staging to disk (T26) and command wiring (T27) are explicitly OUT OF SCOPE. Spec §3.3.
> **Test suite:** 385 tests passing (30 files), typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE (with follow-ups)

**Overview:** `planMigration` is a clean, well-factored, side-effect-free planner that meets the T25 acceptance. Context remap correctly reserves system + facts first, greedily keeps the newest turns that fit (no off-by-one), and folds the overflow into a single leading summary turn — via the injected `Summarizer` when present (with `stripControl` on its model-sourced output), else a deterministic truncation marker. Facts pass through byte-identically; the embedding 4-way matrix fires re-embed only on a differing `(model, dimension)` space and validates the returned vectors exactly as `capture.ts` does. The backend is reached only through injected callbacks, so the module imports no adapter and stays trivially testable. No blocking defects. The one finding worth landing before T26 stages this to disk is that the injected summary turn's own token cost is never charged against the target budget, so a large summary can push the carried context back over the window the remap exists to satisfy.

---

## Critical Issues

None.

---

## Important Issues

### 1. The injected summary turn is uncounted, so a remap can still overflow the target context

- **File:** `src/memory/migrate.ts` — `planContextRemap`, the `available`/`running` keep loop and the `[summaryTurn, ...kept]` return.
- **Problem:** The budget math reserves `system + facts` and then keeps the newest turns whose combined cost `<= available`. But the synthetic `summaryTurn` that is _prepended_ to `kept` is never charged against `available`. On the `truncate` path the marker (`[N earlier turns omitted during migration]`) is tiny and bounded, so this is harmless. On the `summarize` path the content is `Summary of prior conversation: ${summary}` where `summary` is the **target model's free-form output** — unbounded, and produced with no length constraint. The result is that `reserved + keptCost + summaryCost` can exceed `targetContextLength`, i.e. the remap whose entire purpose is to _fit_ the target window can hand back a plan that doesn't fit. The acceptance tests don't catch this because they only assert the summarizer is called with the overflow and that one turn survives — never that the total fits. Spec §3.3 calls for a _"compact 'prior summary' turn,"_ and "compact" is exactly the property missing here.
- **Fix:** Reserve a summary budget up front and bound the summary to it. Charge a fixed reserve for the summary slot before the keep loop, and truncate the summarizer output to fit:
  ```ts
  const SUMMARY_RESERVE = 256; // tokens; tune to spec
  const willSummarize = reserved + totalTurnCost > targetContextLength;
  const available = Math.max(
    0,
    targetContextLength - reserved - (willSummarize ? SUMMARY_RESERVE : 0),
  );
  // ...after producing `summary`:
  const maxSummaryChars = SUMMARY_RESERVE * 4;
  const bounded = summary.length > maxSummaryChars ? summary.slice(0, maxSummaryChars) : summary;
  ```
  At minimum, count `estimateTokens(summaryTurn.content)` and, if it pushes the plan over `targetContextLength`, either shrink the summary or drop one more `kept` turn. A test should assert `reserved + Σ estimateTokens(plan.turns[i].content) <= targetContextLength` for the summarize path (including a deliberately long summarizer output).

---

## Suggestions

### 1. Replace the `embedder as MigrationEmbedder` cast with an explicit guard

- **File:** `src/memory/migrate.ts` — `planEmbedding`, `const active = embedder as MigrationEmbedder;`
- The cast is _currently_ sound: `strategy === "reembed"` implies `target !== undefined` (via `decideEmbeddingStrategy`), which implies `embedder !== undefined`. But that invariant lives in a _different_ function, so the safety is non-local — a future edit to `decideEmbeddingStrategy` (e.g. returning `"reembed"` for a `target === undefined` "best-effort" case) would silently turn this into a runtime `undefined.embed` deref. Prefer a local guard that both narrows the type (removing the `as`, which the project otherwise avoids) and documents the invariant:
  ```ts
  if (embedder === undefined) {
    throw new MemoryError("re-embed strategy requires a target embedder");
  }
  // embedder is now MigrationEmbedder; no cast needed
  ```

### 2. Ignoring the embedder's returned `dimension` diverges from `capture.ts`

- **File:** `src/memory/migrate.ts` — `planEmbedding` validates `vector.length !== active.dimension` (the _declared_ dimension) and never inspects `result.dimension`.
- `capture.ts` keys its identical validation off `result.dimension` (the value the embedder _reports for this call_) and pins that. Here `result.dimension` is read from the `embed` contract but then completely unused, so a lying embedder that declares `dimension: 2`, returns `dimension: 5`, and yields length-2 vectors is accepted and pinned as `2`. For parity and defense, assert the two agree before trusting either:
  ```ts
  if (result.dimension !== active.dimension) {
    throw new MemoryError(
      `embedder declared dimension ${active.dimension} but returned ${result.dimension}`,
    );
  }
  ```

### 3. `reuse` shares the source chunk/vector arrays by reference into the plan

- **File:** `src/memory/migrate.ts` — `planEmbedding` reuse branch returns `{ chunks: source.chunks, vectors: source.vectors }`.
- The plan aliases the caller's `SourceEmbedding` arrays rather than copying them. All the interfaces are `readonly`, so the compiler forbids mutation _through the plan_, and the plan is immediately staged (T26) — so this is a theoretical hazard, not a live bug. Worth a one-line comment recording the intentional zero-copy (`// reuse: alias source arrays; readonly + immediate staging make this safe`), or a shallow copy if T26 will ever mutate the arrays in place. `factsText` is a string and thus already immutable, so the "byte-identical facts" guarantee is unaffected.

### 4. The injected `role: "system"` turn round-trips into `conversation.jsonl`, which `capture.ts` never writes

- **File:** `src/memory/migrate.ts` — `summaryTurn = { role: "system", ... }` merged into `turns`.
- `capture.ts` only ever emits `user`/`assistant` turns; the persona/system prompt lives in the separate `systemPrompt` field, not the turn stream. Injecting a `system` turn is a reasonable representation, but two downstream consequences are worth confirming before T26/T27 land: (a) whichever reader T27 wires to load source memory must accept a `system`-role turn on the way back in, and (b) migrating an _already-migrated_ store re-reads that summary turn as an ordinary turn, so a second remap can summarize the summary (summary-of-summary compounding). Consider tagging the synthetic turn distinctly (e.g. a `synthetic: true` flag, or excluding prior summary turns from re-summarization) so repeated migrations degrade gracefully.

### 5. Re-embed sends every chunk text in a single unbounded `embed()` call

- **File:** `src/memory/migrate.ts` — `const texts = source.chunks.map((chunk) => chunk.text); const result = await active.embed(texts);`
- A migrated store can hold far more chunks than a single `chat` exchange (which `capture.ts` embeds one exchange at a time), so this can hand the backend an arbitrarily large batch. Functionally correct, but consider chunking the input into fixed-size batches to bound request size and memory for large indices. Low priority until real index sizes are known.

### 6. Minor naming

- **File:** `src/memory/migrate.ts` — `const active = embedder ...` reads opaquely at the use sites. `targetEmbedder` or `resolvedEmbedder` states intent. (Moot if Suggestion 1 is adopted, since the guard narrows `embedder` in place.)

---

## What's Done Well

- **Dependency-injected backend.** `Summarizer` and `MigrationEmbedder` are injected callbacks; the module imports no adapter, exactly honoring the spec's _"reaches the backend only through the BackendAdapter interface"_ boundary while staying pure and disk-free.
- **Security boundary is right.** The summarizer's model-sourced output is `stripControl`'d before it enters a turn, while the deterministic marker (not model-sourced) is left as-is. Facts are carried as opaque bytes and never rendered here.
- **Correct greedy fit with clean edges.** The newest-first keep loop breaks _before_ incrementing, so kept cost never exceeds `available` (no off-by-one); the `keptCount === 0` case (a single newest turn larger than the whole budget) correctly summarizes everything, and empty `turns` / all-fit both short-circuit to `strategy: "none"` without emitting a phantom summary turn.
- **Re-embed validation mirrors `capture.ts`.** Count mismatch, per-vector dimension, and per-component `Number.isFinite` are all checked and throw `MemoryError`, keeping migration and capture validation consistent.
- **Faithful accounting.** `turnsCarried + turnsSummarized` always equals the original turn count, and the summary turn takes the oldest overflow timestamp so the carried history stays chronologically ordered.
- **Tests assert behavior, not just calls.** The summarize test checks the _exact_ overflow slice `[T1,T2,T3]` passed to the summarizer and the surviving `T4`; the re-embed test asserts ids preserved, meta rewritten, and the failure path throws `MemoryError`.

---

## Verification Story

| Check            | Status | Notes                                                                                                                                                                                                    |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 15 T25 tests; assert exact overflow slice, byte-identical facts, and the re-embed matrix + dimension-mismatch rejection. Gap: no test that the summarize result _fits_ the target budget (Important #1). |
| Build verified   | ✅     | `tsc` clean; strict/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`verbatimModuleSyntax` all satisfied (`import type`, `                                                                       | undefined`optionals, guarded`as readonly number[]` on indexed access). |
| Security checked | ✅     | Summarizer output `stripControl`'d; facts carried as opaque bytes and unaltered; no adapter import; no untrusted input rendered in-module.                                                               |
| Coverage         | ✅     | Logic branches (none/summarize/truncate × reuse/reembed/none) all exercised; error paths covered. Uncounted-summary overflow is the untested edge.                                                       |

---

## Action Items

| #   | Priority   | Issue                                                                                                                                   | Target                   |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Important  | Charge the injected summary turn against the target budget (reserve + bound) so a remap cannot overflow the window it exists to satisfy | T25 follow-up before T26 |
| 2   | Suggestion | Replace `embedder as MigrationEmbedder` with a throwing guard                                                                           | T25 follow-up            |
| 3   | Suggestion | Assert `result.dimension === active.dimension` for parity with `capture.ts`                                                             | T25 follow-up            |
| 4   | Suggestion | Document/freeze/copy the reused source arrays aliased into the plan                                                                     | backlog                  |
| 5   | Suggestion | Confirm T27's reader accepts `system`-role turns; guard against summary-of-summary on re-migration                                      | T27                      |
| 6   | Suggestion | Batch large re-embed inputs; rename `active`                                                                                            | backlog                  |
