# Security Audit Report #12

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Uncommitted B10 changes — embedding capability gating (vector-less
> capture + `meta.json` flag). Files: `src/memory/store.ts`,
> `src/memory/capture.ts`, `src/commands/chat.ts`, `src/memory/migrate.ts`,
> `src/commands/migrate.ts`. Focus: schema-injection / validation-bypass,
> path-safety of the `meta.json` write, TOCTOU on read-then-write meta,
> honesty-gate integrity (no fabricated vectors), and whether the embed-capable
> path is unchanged.
> **Dependencies:** `npm audit --omit=dev` → **0** runtime vulnerabilities. Full
> tree reports 6 (3 moderate, 1 high, 2 critical) confined to dev-only
> `vitest`/`vite-node` transitives — not shipped in the published package.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 2 |

The B10 change is small, well-bounded, and inherits the memory store's existing
defenses (slug traversal guard, symlink re-check before write, `0700/0600`
fail-closed perms, cross-process `O_EXCL` lock). No exploitable vulnerability was
found. The two Low findings are honesty-gate / data-integrity correctness
defects, not remotely exploitable.

---

## Findings

### [LOW-1] `meta.json` can simultaneously assert an embedding index and `embeddingUnsupported`

- **Location:** `src/memory/capture.ts:287` (`markEmbeddingUnsupported`),
  `src/memory/capture.ts:383-387` (`writeEmbedding` pin), schema at
  `src/memory/store.ts:56-70`.
- **Description:** The schema makes `embedding` and `embeddingUnsupported` two
  independent `.optional()` fields with no mutual-exclusion invariant. Both
  writers preserve prior state via `{ ...meta, ... }`:
  - `markEmbeddingUnsupported` adds `embeddingUnsupported: true` but does **not**
    clear an existing `embedding` descriptor.
  - `writeEmbedding` (embed-capable path) adds `embedding` but does **not** clear
    a prior `embeddingUnsupported: true`.

  A store keyed by model id can be served across sessions by backends with
  different `canEmbed` capabilities (e.g. an embed-capable Ollama session pins
  `embedding`, then the same model is later served by a non-embedding backend
  which sets `embeddingUnsupported: true`). The resulting `meta.json` then claims
  both "this store has a `nomic-embed-text`/768 index" **and** "vectors are
  intentionally absent."
- **Impact:** Honesty-gate contradiction. A future retrieval/search consumer that
  trusts `embedding` would query a **real but stale/partial** index (recent
  vector-less turns are missing) while `embeddingUnsupported` signals the
  opposite. This is silent incompleteness, not data loss — conversation turns and
  facts are still recorded. No remote exploitability; requires a local backend
  switch on the same model. Latent in v1 (no retrieval consumer reads these flags
  yet), but the on-disk record is already self-contradictory.
- **Proof of concept:** n/a (not remotely exploitable). Reproduction: capture a
  turn with an embed-capable adapter (pins `embedding`), switch the active
  backend for the same model to one with `canEmbed === false`, capture again →
  `meta.json` contains both keys.
- **Recommendation:** Make the two states mutually exclusive at the write
  boundary. Either (a) have `markEmbeddingUnsupported` strip `embedding` before
  writing and have `writeEmbedding` strip `embeddingUnsupported` on pin, or (b)
  add a Zod `superRefine` on `MemoryMetaSchema` rejecting the co-presence so the
  invariant is enforced fail-closed on every read and write. Example for (b):

  ```ts
  const MemoryMetaSchema = z
    .object({ /* ...existing fields... */ })
    .strict()
    .superRefine((m, ctx) => {
      if (m.embedding !== undefined && m.embeddingUnsupported === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "meta cannot both pin an embedding index and mark embeddings unsupported",
        });
      }
    });
  ```

  Option (a) is friendlier (self-heals on the next capture); option (b) is
  stricter (a store that reaches the contradictory state becomes unopenable and
  must be reconciled). Given the honesty gate, prefer (a) plus a `superRefine`
  guard so the contradiction can never be persisted in the first place.

### [LOW-2] `migrate` now resolves the active adapter more broadly, widening a failure surface

- **Location:** `src/commands/migrate.ts:152-163`.
- **Description:** The guard that gates `select({ intent: "attach", ... })` was
  loosened from `summarizer === undefined && active !== null && active.modelId
  === toId && targetOllamaId !== undefined` to `active !== null && active.modelId
  === toId`. `select()` is now invoked whenever the active model is the migration
  target — even when a summarizer was already supplied and even when
  `targetOllamaId` is `undefined`.
- **Impact:** Availability/robustness only. `select()` for a state-recorded
  `active.backend` that is not present in the registry throws `ValidationError`,
  so a `migrate` invocation that previously succeeded (summarizer injected,
  adapter never resolved) could now fail. In production `deps.summarizer` is
  normally undefined, so the practical delta is limited to the
  `targetOllamaId === undefined` case (non-Ollama-sourced targets). `select()`
  with `attach` intent performs **no** network probe (the `isInstalled()` probe
  is on the create/auto-detect branch only), so this is not a determinism or
  network-exposure regression — purely a broader throw surface.
- **Proof of concept:** n/a.
- **Recommendation:** Accept as intended (embedding gating genuinely requires the
  adapter), but confirm `select()` failure for a stale/unknown `active.backend`
  degrades gracefully — e.g. treat an unresolvable active adapter as "capabilities
  unknown → proceed vector-less" rather than aborting the whole migration, or
  wrap the resolution so a registry miss does not block a migration that needs
  neither the summarizer nor the embedder. Add a test for `active.backend` not in
  the registry.

---

## Positive Observations

- **Schema is injection-tight.** `embeddingUnsupported: z.literal(true).optional()`
  on a `.strict()` object accepts only the exact value `true` or omission — `false`,
  strings, and unknown keys are all rejected. No validation-bypass vector, and the
  honesty semantics ("absent by design") cannot be spoofed to any other value.
- **Path-safety is preserved and re-verified.** `markEmbeddingUnsupported`
  delegates to `writeMemoryMeta`, which re-runs `assertWithinRoot` (realpath
  containment + symlink re-check) immediately before the `rename`, writes to the
  canonical validated path, and re-`stat`s `0700/0600` perms fail-closed. The
  `store.dir` handed in was already validated by `openMemoryStore`. No new
  filesystem-write primitive was introduced.
- **TOCTOU is correctly bounded.** The read-then-write in
  `markEmbeddingUnsupported` (`readMemoryMeta` → check → `writeMemoryMeta`) runs
  inside `deps.withLock` in the `chat` loop (`src/commands/chat.ts:191`) and the
  `migrate` write path. `withLock` is a real cross-process mutex
  (`openSync(lockFile, "wx", …)` = `O_EXCL`, with stale-PID reclaim in
  `src/state/state.ts:223`), so concurrent chat/migrate processes cannot
  interleave the read and the write. The writer also re-reads fresh meta rather
  than trusting the possibly-stale `store.meta` handle, and `writeMemoryMeta`
  re-validates through `MemoryMetaSchema.parse` — defense in depth.
- **Honesty gate is honored on the capture path.** When
  `embeddingUnsupported === true`, `prepareEmbedding` is not called at all — no
  embedder is consulted, no network request is made, `embedding` is `undefined`,
  and `vectorsEmbedded` is `0`. No vector is fabricated; the absence is recorded
  explicitly.
- **Embed-capable path is genuinely unchanged.** When `canEmbed` is true,
  `embeddingUnsupported` is omitted from `captureOptions`, so
  `options.embeddingUnsupported === true` is `false`, `prepareEmbedding` runs
  exactly as before, and `markEmbeddingUnsupported` is never reached. The migrate
  planner likewise only diverts to `strategy: "none"` under the explicit flag.
- **Migrate target meta stays clean.** On the migration path,
  `stageMigration` omits `embedding` (because `plan.embedding` is `undefined`
  under `strategy: "none"`) and adds only `embeddingUnsupported: true`, so a
  freshly staged target store does not exhibit the LOW-1 mixed state — the
  contradiction is reachable only via in-place capture on a pre-existing indexed
  store.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | LOW-1: `meta.json` can assert both `embedding` and `embeddingUnsupported` | Make the two mutually exclusive at the write boundary and/or add a `superRefine` guard so the contradiction cannot persist |
| 2 | Low | LOW-2: `migrate` resolves active adapter more broadly | Degrade gracefully when `active.backend` is unresolvable; add a registry-miss test |
| 3 | Info | Dev-only `npm audit` findings (vitest/vite-node) | Track; not shipped — confirm `--omit=dev` stays clean before publish |
| 4 | Info | Broader `select()` invocation on migrate is network-free (`attach` intent) | No action; documented for future reviewers |
```

