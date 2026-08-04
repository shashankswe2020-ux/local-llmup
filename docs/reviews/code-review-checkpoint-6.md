# Code Review Checkpoint 6: Task 23 (Chat Capture Logic)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T23 — chat memory capture (`src/memory/capture.ts`): append turns to `conversation.jsonl`, rule-based fact extraction into `facts.json`, optional embedding into `embeddings/` with model+dimension pinned in `meta.json`. Spec §3.5.
> **Test suite:** 354 tests passing (28 files), typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE (with follow-ups)

**Overview:** `captureExchange` is a clean, well-documented producer over the T22 store foundation. The security boundary is right — every chat-sourced string is `stripControl`'d before it touches disk, the embedding space is pinned with a mismatch guard, and perms are re-applied 0600/0700 under a permissive umask. The regex fact extractor is ReDoS-safe. No blocking defects. Three durability/consistency follow-ups are worth landing before the `chat` command wires this in: `facts.json` is rewritten non-atomically (a torn write bricks all future captures), per-vector dimension is never validated against the pinned dimension, and a mid-capture embed failure leaves `conversation.jsonl`/`facts.json` ahead of `embeddings/` with no reconciliation.

---

## Critical Issues

None.

---

## Important Issues

### 1. `facts.json` is rewritten non-atomically — a torn write bricks the store's fact system
- **File:** `src/memory/capture.ts` (`writeFacts`, ~L177–180; called by `mergeFacts` ~L217–236)
- **Problem:** Unlike `store.ts`, which writes `meta.json` via temp-file + `renameSync`, `writeFacts` calls `writeFileSync(path, ...)` directly onto the live file. `facts.json` is a full read-modify-**rewrite** on every capture (`loadFacts` → mutate → `writeFacts`), so it is exactly the artifact most exposed to a torn write. If the process is killed (or hits `ENOSPC`/`EIO`) mid-write, `facts.json` is left truncated/partial. The very next `captureExchange` calls `loadFacts`, `JSON.parse` throws, and `loadFacts` raises `MemoryError("facts file is not valid JSON")` — permanently failing every future capture for that store until a human intervenes. The atomic pattern already exists in the codebase.
- **Fix:** Stage to `config.stagingDir` and `renameSync` into place, mirroring `writeMemoryMeta`:
  ```ts
  function writeFacts(config: Config, path: string, file: FactsFile): void {
    const tempFile = join(config.stagingDir, `facts.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tempFile, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE });
      chmodSync(tempFile, FILE_MODE);
      renameSync(tempFile, path);
    } catch (error) {
      tryUnlink(tempFile);
      throw new MemoryError(`failed to write facts: ${path}`, { cause: error });
    }
    verifyPerms(path, FILE_MODE);
  }
  ```
  (Requires threading `config` into `mergeFacts`, which `captureExchange` already holds.)

### 2. Per-vector dimension is never validated against the pinned dimension
- **File:** `src/memory/capture.ts` (`embedTurns`, ~L253–271)
- **Problem:** `embedTurns` validates the vector **count** (`result.vectors.length !== chunks.length`) but never checks that each vector actually has `result.dimension` elements. The whole point of pinning `{ model, dimension }` in `meta.json` is to guarantee a single consistent vector space for similarity search; a misbehaving or version-drifted embedder that returns `dimension: 768` alongside 512-length vectors would be written straight into `vectors.jsonl`, silently corrupting the index against its own declared invariant. `noUncheckedIndexedAccess` also types `result.vectors[i]` as `readonly number[] | undefined`, so a short `vectors` array relative to the declared shape would serialize `"vector": null` with no error.
- **Fix:** Validate each row before writing:
  ```ts
  for (const vec of result.vectors) {
    if (vec.length !== result.dimension) {
      throw new MemoryError(
        `embedder returned a ${vec.length}-d vector, expected ${result.dimension}`,
      );
    }
  }
  ```

### 3. Mid-capture failure leaves conversation/facts ahead of embeddings with no reconciliation
- **File:** `src/memory/capture.ts` (`captureExchange`, ~L190–215; `embedTurns` ~L238–272)
- **Problem:** The four artifacts are written sequentially with no cross-file transaction: (1) `conversation.jsonl`, (2) `facts.json`, then (3) `await embedder.embed(...)`, (4) `chunks.jsonl`, (5) `vectors.jsonl`, plus the `meta.json` embedding pin in between. The lock serializes *concurrent* writers, but it does nothing for a *failure mid-capture*. Because the network-fallible `embed()` call runs **last**, an embedder error (the most likely failure — the embedding model being down) leaves the turn permanently recorded in `conversation.jsonl`/`facts.json` but absent from the embedding index, with no marker of which turns were embedded. A later RAG/similarity read silently under-retrieves. Separately, `appendJsonl(chunks)` and `appendJsonl(vectors)` are two non-atomic writes: a failure between them orphans chunk ids that have no vector.
- **Fix (cheapest, biggest payoff):** Move the fallible `embed()` call to the **front** of `captureExchange`, before any disk write, so a network failure aborts the whole capture with nothing persisted:
  ```ts
  const embed = await runEmbed(contents, options.embedder); // may throw; nothing written yet
  appendJsonl(conversation, turns);
  mergeFacts(...);
  writeEmbeddings(embed); // chunks + vectors + pin, all local writes
  ```
  If recording the conversation even when embedding fails is desired instead, document that intent and add a per-turn "embedded" marker so the two files can be reconciled. At minimum, note the chunks/vectors non-atomicity so a future reader tolerates orphan chunks.

---

## Suggestions (Minor)

### 1. `facts.json` is rewritten on every turn even when nothing changed
- **File:** `src/memory/capture.ts` (`mergeFacts`, ~L217–236)
- The common case (chit-chat, `added === 0`) still triggers a full parse → serialize → write → chmod of `facts.json` every turn. Guard the write on `added > 0`. Note the existing test "writes an empty facts.json when nothing is extracted" asserts the file exists after a no-fact exchange — satisfy it by creating an empty `facts.json` once at store open (or on first capture) rather than rewriting on every turn.

### 2. No bound on conversation / embeddings / facts growth
- **File:** `src/memory/capture.ts` (`appendJsonl` for `conversation.jsonl`, `chunks.jsonl`, `vectors.jsonl`; `mergeFacts`)
- Appends are unbounded by design ("appends turns"), but there is no rotation/cap, and `facts.json` is fully loaded + rewritten each turn (O(n) per capture, O(n²) over a long conversation). For a long-lived store this grows without limit and the facts rewrite cost climbs. Track a retention/compaction strategy (size- or age-based conversation rotation, capped facts) for a future task even if deferred now.

### 3. `remember` rule fires on interrogative and negated uses
- **File:** `src/memory/capture.ts` (`FACT_RULES`, ~L104)
- `/\bremember(?: that)?[:\s]+([^.\n]+)/gi` matches any `remember` followed by a separator, so "Do you remember the movie we discussed?" stores the fact `the movie we discussed?`, and "I don't remember that address" stores `address`. It also uses a different stop set (`[^.\n]+`, keeping `,;!?`) than the other rules (`[^.,;!?\n]+`), so a "remember" fact swallows punctuation the others reject. Consider requiring an imperative lead ("please remember", start-of-message "remember"), excluding a preceding negation/question auxiliary, and aligning the stop set across rules.

### 4. Run-on sentences over-capture the greedy value group
- **File:** `src/memory/capture.ts` (`FACT_RULES`, ~L96–103)
- `[^.,;!?\n]+` stops only at sentence punctuation, so "My name is Ada and I live in London" yields `name = Ada and I live in London` (and, separately, `location = London`). Conservative for v1, but worth a note or a `\b(?:and|but|because)\b` cutoff so a single clause is captured. Same class of issue makes "I like you" a stored `preference = you`.

### 5. `embedder.model` is not `stripControl`'d before it is persisted to `meta.json`
- **File:** `src/memory/capture.ts` (`pinEmbeddingMeta`, ~L296)
- The mismatch *error message* wraps both model ids in `stripControl(...)` — acknowledging the id may be tainted — but the value actually written (`writeMemoryMeta(..., { embedding: { model, dimension } })`) is the raw `embedder.model`. `MemoryMetaSchema` only checks `min(1)`, not control bytes. If the embedding model id can carry model/catalog-sourced control/ANSI bytes, they land raw in `meta.json` and re-render later. Strip on the way in (or document the id as trusted config) so storage and display are consistent.

### 6. Prefer `String.prototype.matchAll` over manual `lastIndex` reset
- **File:** `src/memory/capture.ts` (`extractFacts`, ~L110–134)
- The module-level `/g` regexes rely on `rule.pattern.lastIndex = 0` before each loop. It is correct today (extractFacts is fully synchronous and never yields), but it is a footgun: any future `await` interleaving or re-entrancy across the shared regex object would corrupt iteration. `for (const m of text.matchAll(rule.pattern))` clones the regex internally and removes the shared mutable `lastIndex` entirely, with no behavior change.

### 7. Append path only `chmod`s; it does not `verifyPerms` fail-closed
- **File:** `src/memory/capture.ts` (`appendJsonl` ~L140–150, `ensureDir` ~L136–139)
- `store.ts` hardens with `chmod` **and** a `verifyPerms` stat re-check (fail-closed). The capture write path re-applies `chmod` but never verifies, so it is marginally weaker than the foundation it builds on. Low risk given owner-only 0700 dirs, but a `verifyPerms` on the created files would match the established posture.

### 8. Facts have no key/supersede semantics
- **File:** `src/memory/capture.ts` (`mergeFacts`, ~L217–236)
- Dedup is on the whole lowercased fact string, so contradictory facts accumulate side by side (`name = Ada`, then later `name = Bob`, both retained). Fine for a v1 append-only log, but a future consumer will need to decide precedence. Worth a note that "latest wins" is not modeled yet.

---

## What's Done Well

- **Sanitization boundary is correct and load-bearing.** Every chat-sourced string (`user`, `assistant`, and therefore the extracted fact text and embedded chunk text) is `stripControl`'d before storage. This is the *right* place: `JSON.stringify` only escapes the on-disk bytes; `JSON.parse` on the render path would restore the raw control/BiDi bytes, so `stripControl` — not JSON escaping — is what actually protects a later `chat`/`migrate` render. The "passes control-stripped content to the embedder" test locks this in.
- **Regex extractor is ReDoS-safe.** All patterns use negated character classes (`[^...]+`) and simple `\s+` with no nested quantifiers or ambiguous alternation, so there is no catastrophic backtracking. Each pattern has a non-zero minimum match length, so the `exec` loop cannot spin on a zero-width match. `lastIndex` is reset per rule and `extractFacts` never yields, so shared regex state cannot be corrupted.
- **Embedding-space pinning is sound.** `pinEmbeddingMeta` re-reads `meta.json` fresh via `readMemoryMeta` (observing writes since open), guards model+dimension mismatch with a hard `MemoryError`, and persists via the atomic `writeMemoryMeta`. The vector **count** check catches the most common embedder contract violation.
- **Permission discipline carries through.** Files/dirs are created with `FILE_MODE`/`DIR_MODE` and re-`chmod`'d, and the "writes memory files 0600 even under a permissive umask" test proves the umask-widening window is closed.
- **Strong, intent-revealing tests** — append-not-overwrite, cross-call dedup, ANSI stripping, empty-facts file, no-embedder path leaving no `embeddings/`, and model-mismatch rejection all present.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 12 capture tests; cover append, dedup, stripping, embedding pin + mismatch, umask 0600. Gaps: no torn-write/atomicity test, no per-vector-dimension test, no embed-failure consistency test. |
| Build verified | ✅ | `tsc` clean; `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` satisfied. |
| Security checked | ✅ | `stripControl` at storage boundary; 0600/0700 enforced; no secrets; runs under runtime lock. Minor: `embedder.model` persisted unstripped (Suggestion 5). |
| Coverage | ✅ | 354 tests passing across 28 files; `src/memory/` well exercised. |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | `facts.json` non-atomic rewrite → torn write bricks future captures; use temp+rename | before `chat` wiring (T23 follow-up) |
| 2 | Important | Validate each vector length against pinned `dimension` | before `chat` wiring (T23 follow-up) |
| 3 | Important | Mid-capture embed failure desyncs conversation/facts vs embeddings; move `embed()` before writes | before `chat` wiring (T23 follow-up) |
| 4 | Suggestion | Skip `facts.json` write when `added === 0`; create empty file once at store open | backlog |
| 5 | Suggestion | Add retention/compaction for conversation/embeddings/facts growth | backlog |
| 6 | Suggestion | `remember` rule fires on questions/negation; tighten anchoring + align stop sets | backlog |
| 7 | Suggestion | Greedy value group over-captures run-on sentences | backlog |
| 8 | Suggestion | `stripControl` `embedder.model` before persisting to `meta.json` | backlog |
| 9 | Suggestion | Use `matchAll` instead of manual `lastIndex` reset | backlog |
| 10 | Suggestion | Add `verifyPerms` fail-closed on the append write path | backlog |
| 11 | Suggestion | Document/model fact supersede ("latest wins") semantics | backlog |
