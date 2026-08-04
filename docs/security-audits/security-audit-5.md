# Security Audit Report #5

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 5 August 2026
> **Scope:** T23 "Chat capture logic" — `src/memory/capture.ts` (with `src/memory/store.ts`, `src/sanitize.ts`, `src/config.ts`, `src/errors.ts` as supporting context)
> **Dependencies:** Not re-run for this module-scoped review (no new runtime deps introduced by `capture.ts`; it uses `node:fs`, `node:crypto`, `node:path`, and `zod`, all already in tree). Run `npm audit` at checkpoint close.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 3 |
| Info | 2 |

Overall the module is well-hardened for its threat model: all stored content is passed through `stripControl` first, the fallible network embed is fully validated before any disk write, facts are only extracted from the *user* turn (a hostile model reply cannot poison `facts.json`), temp files use unpredictable `randomUUID` names in an owner-only staging dir, and `facts.json`/`meta.json` are swapped via `rename` (atomic and symlink-safe at the target). No remotely-exploitable issue was found. The findings below are hardening gaps and local resource-exhaustion / integrity concerns.

---

## Findings

### [MEDIUM-1] Unbounded on-disk growth and O(n²) fact rewrite — local disk/CPU exhaustion

- **Location:** [src/memory/capture.ts](../../src/memory/capture.ts) — `mergeFacts` (whole-file read-modify-rewrite), `appendJsonl` targets `conversation.jsonl` / `embeddings/chunks.jsonl` / `embeddings/vectors.jsonl`, and `captureExchange` (no input-size cap before `stripControl`).
- **Description:** There is no size limit anywhere in the write path:
  - `conversation.jsonl`, `chunks.jsonl`, and `vectors.jsonl` are append-only with no rotation or cap and grow without bound over a session's lifetime.
  - `mergeFacts` reads the **entire** `facts.json` into memory, builds a lower-cased `Set` of every existing fact, and `atomicWriteJson` rewrites the **entire** file on every change. Over a long session this is O(n) work and O(n) memory per turn → O(n²) total.
  - Individual facts have no length cap. The `remember(?: that)?[:\s]+([^.\n]+)` rule captures everything up to the first period; because `stripControl` has already removed newlines (`\n` is in the C0 range), a large pasted "remember: …" message with no period is stored as one enormous fact string.
  - `exchange.user` / `exchange.assistant` are stripped and stored whole with no upper bound; a multi-megabyte model reply is copied through `stripControl` (three full-string `.replace` passes) and persisted verbatim into both `conversation.jsonl` and `chunks.jsonl`.
- **Impact:** A long or adversarial chat session (large pastes, repeated distinct `remember:` lines) can exhaust the user's disk and drive CPU/memory quadratically on every subsequent capture, degrading or hanging the `chat` command while it holds the runtime lock. Impact is confined to the local user (self-inflicted or via very large model output), so this is availability, not disclosure.
- **Proof of concept:** In a session, repeatedly send `remember: <fresh-unique-token-N>`. Each turn adds one new fact; capture N then re-reads and re-serializes all N-1 prior facts, and `facts.json` grows linearly while total work grows quadratically. Separately, a single `assistant` reply of e.g. 50 MB is stored twice on disk.
- **Recommendation:** Enforce explicit caps at this boundary:
  - Reject or truncate `exchange.user` / `exchange.assistant` above a fixed byte budget (e.g. 64–256 KB) *before* sanitizing/storing.
  - Cap individual fact length (e.g. `fact.slice(0, 512)`), cap the total number of retained facts (evict oldest or refuse), and consider an append-only `facts.jsonl` with periodic compaction instead of full-file rewrite to avoid O(n²).
  - Cap/rotate `conversation.jsonl` and the embeddings files (size- or turn-based rotation), and refuse to embed chunks over a maximum length.

  ```ts
  const MAX_TURN_BYTES = 128 * 1024;
  const MAX_FACT_LEN = 512;
  const MAX_FACTS = 1000;

  function clampTurn(s: string): string {
    return Buffer.byteLength(s, "utf8") > MAX_TURN_BYTES
      ? Buffer.from(s, "utf8").subarray(0, MAX_TURN_BYTES).toString("utf8")
      : s;
  }
  // in extractFacts: fact = rule.format(captured).slice(0, MAX_FACT_LEN);
  // in mergeFacts: stop adding once file.facts.length >= MAX_FACTS.
  ```

### [MEDIUM-2] `stripControl` bidi coverage gap + single-layer sanitization (residual Trojan-Source)

- **Location:** [src/sanitize.ts](../../src/sanitize.ts) — `BIDI_RE`; relied on exclusively by `captureExchange` before storage.
- **Description:** `stripControl` is the only defense applied to untrusted chat content, and its `BIDI_RE` set is incomplete:
  - **U+061C ARABIC LETTER MARK (ALM)** is a bidirectional formatting control usable for Trojan-Source-style visual reordering and is **not** in `BIDI_RE` (`\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff` skips `\u061c`).
  - Invisible/zero-width joiners outside the covered ranges — e.g. U+2060 WORD JOINER, U+2061–U+2064, U+00AD SOFT HYPHEN, U+180E — survive stripping and can be used for content obfuscation/spoofing.
  Because content is stored via `JSON.stringify` (which escapes C0/C1 but leaves these printable-category code points as raw bytes on disk), any surviving reorder control persists in `conversation.jsonl` / `chunks.jsonl`. If a future `migrate`/`chat` render prints stored content without re-sanitizing, the residual controls reach the terminal.
- **Impact:** Adversarial user or model content can embed a residual bidi/invisible control that is preserved on disk and, at a later render that trusts stored data, reorder or hide displayed text (Trojan-Source class) or spoof a fact's meaning.
- **Proof of concept:** Send a message containing U+061C between visible tokens; it passes `stripControl` unchanged, is stored raw, and reorders on any terminal render that does not itself sanitize.
- **Recommendation:** (1) Extend `BIDI_RE` to include U+061C and the remaining invisible/zero-width formatting code points (add `\u061c`, `\u2060-\u2064`, `\u00ad`, `\u180e`); prefer a Unicode default-ignorable / bidi-control based allow/deny list to avoid future gaps. (2) Treat sanitization as defense-in-depth: **re-run `stripControl` at every render boundary** (`chat` display, `migrate`) rather than trusting that stored data was fully sanitized at write time, since the on-disk format is long-lived and the sanitizer may evolve.

  ```ts
  const BIDI_RE =
    /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff]/g;
  ```

### [LOW-1] Symlink-following writes + open-time-only containment (TOCTOU) on the four capture paths

- **Location:** [src/memory/capture.ts](../../src/memory/capture.ts) — `appendJsonl` (`appendFileSync` + `chmodSync`) for `conversation.jsonl` / `chunks.jsonl` / `vectors.jsonl`, and `ensureDir(join(store.dir, EMBEDDINGS_DIR))`.
- **Description:** `store.dir`'s realpath containment is verified once by `openMemoryStore` and re-asserted by the store layer only around its own `meta.json` link/rename. The four paths this module writes are joined onto `store.dir` (safe, constant filenames — no name-based traversal) but are **never re-checked**, and `appendFileSync`/`chmodSync`/`mkdirSync` all **follow symlinks**. A symlink planted at `conversation.jsonl` (or at `embeddings/`) between store open and the append, or a swap of `store.dir` itself to a symlink, would redirect the write and the subsequent `chmod` outside the memory root. Unlike `store.ts` (which re-asserts `assertWithinRoot` immediately before each `link`/`rename`), `capture.ts` performs no equivalent guard and uses no `O_NOFOLLOW`.
- **Impact:** Corruption of or unintended appends to an attacker-chosen file, and a `chmod 0600` applied to the symlink target. Exploitation requires write access to the `0700` memory tree, i.e. an actor already operating as the victim user — hence Low — but the guarantee is weaker than the store layer's belt-and-suspenders.
- **Recommendation:** Open the append targets with `fs.openSync(path, "ax"|"a", ...)` combined with `O_NOFOLLOW` (`fs.constants.O_NOFOLLOW`) and write to the fd, and/or re-assert `assertWithinRoot(config, store.dir, store.modelId)` at the top of `captureExchange` (and after resolving the `embeddings` dir) so the four write paths inherit the same containment re-check the store layer applies.

### [LOW-2] Permissions are fail-open — no `stat` verification after `chmod`, and `ensureDir` chmods only the leaf

- **Location:** [src/memory/capture.ts](../../src/memory/capture.ts) — `ensureDir`, `appendJsonl`, `atomicWriteJson`.
- **Description:** `store.ts` hardens permissions fail-closed: after creating a dir/file it calls `verifyPerms` (a `statSync` check that throws if the mode is not exactly `0700`/`0600`). `capture.ts` applies `chmodSync` but never verifies the result, so a silently-wrong mode (e.g. a `chmod` that raced, or perms on a pre-existing file that `appendFileSync`'s `mode` option ignores because the file already exists) is not caught. Additionally `ensureDir` does `mkdirSync({ recursive: true })` then `chmodSync` on **only the leaf**; under a hostile `umask`, any intermediate directory that `mkdir -p` has to create (e.g. `homeDir` when staging is materialized before the state/store layers run) is left with the umask-masked, potentially world-readable mode.
- **Impact:** Under an adversarial `umask` or a partial-failure edge case, memory files/dirs could end up more permissive than `0600`/`0700` without the module failing closed, widening exposure of stored chat content and facts.
- **Recommendation:** Mirror the store layer — after `chmodSync`, call a `verifyPerms(path, FILE_MODE)` / `verifyPerms(dir, DIR_MODE)` that `stat`s and throws on mismatch. Have `ensureDir` re-`chmod` (and verify) each path segment it may have created rather than only the leaf.

### [LOW-3] Embedding vectors are not validated to be finite — `NaN`/`Infinity` silently corrupt `vectors.jsonl`

- **Location:** [src/memory/capture.ts](../../src/memory/capture.ts) — `prepareEmbedding` (validates count and per-vector length only) and `writeEmbedding` (`JSON.stringify`).
- **Description:** Vector components are only checked for count and dimension. `JSON.stringify` serializes `NaN`, `Infinity`, and `-Infinity` as `null`. An embedder returning any non-finite component writes `null` entries into `vectors.jsonl` with no error, silently poisoning the vector space that similarity search later relies on.
- **Impact:** Data-integrity corruption of the embedding index (later reads get `null` where a number is expected), potentially from a compromised or buggy backend. Not a disclosure issue.
- **Recommendation:** In `prepareEmbedding`, reject any vector containing a non-finite value: `if (!vector.every(Number.isFinite)) throw new MemoryError(...)`. Validating before the disk write keeps the fail-before-persist invariant the module already maintains.

### [INFO-1] Error messages embed absolute paths and raw `cause`

- **Location:** [src/memory/capture.ts](../../src/memory/capture.ts) — `loadFacts`, `atomicWriteJson`, and the `MemoryError` messages generally (e.g. `failed to write facts: ${path}`, `{ cause: error }`).
- **Description:** Errors include full absolute store paths (home dir + model slug) and attach the underlying `cause`. Untrusted content is *not* leaked here (paths derive from `config` + the sanitized `memorySlug`, and the one place a raw model id/model name appears — the embedding-mismatch message — correctly wraps it in `stripControl`), so this is disclosure of local filesystem layout only.
- **Impact:** Minimal for a single-user CLI; if these messages are shipped to a shared log/telemetry sink they reveal home-directory structure and fs internals.
- **Recommendation:** Acceptable as-is for local debugging. If errors are ever surfaced beyond the local user, render paths relative to `homeDir` and omit the raw `cause` from user-facing output (retain it only in verbose/debug mode).

### [INFO-2] Multi-file writes are not atomic as a unit

- **Location:** [src/memory/capture.ts](../../src/memory/capture.ts) — `captureExchange` writes `conversation.jsonl`, then `facts.json`, then the two embedding files sequentially.
- **Description:** Each individual file write is safe/atomic, but the three logical outputs are written in sequence with no cross-file transaction. A failure after the conversation append but before the embedding write leaves a turn recorded in `conversation.jsonl` with no corresponding vector in `embeddings/`. The design mitigates the common case by validating the fallible embed *before* any write, so only an unexpected mid-write fs error triggers this.
- **Impact:** Reliability/consistency skew between the stores; not a security vulnerability.
- **Recommendation:** Document the ordering contract and have consumers (search/migrate) tolerate a trailing conversation turn lacking a vector, or introduce a per-capture sequence/marker so partial captures are detectable.

---

## Positive Observations

- **Untrusted content is sanitized at the storage boundary** — every stored string passes through `stripControl` before it is written; the embedding-mismatch error also wraps model names in `stripControl`.
- **Facts are extracted only from the user turn** (`mergeFacts(config, store, user, ts)`), so a hostile model reply cannot inject or overwrite persisted facts.
- **Fallible work runs before any disk write** — `prepareEmbedding` performs the network embed and validates vector count, per-vector dimension, and vector-space compatibility *before* the first `appendFileSync`, so an embedder outage or mismatch aborts without persisting a half-recorded exchange.
- **Temp files are unguessable and same-filesystem** — `facts.${pid}.${randomUUID()}.tmp` in the owner-only staging dir, combined with `rename` (atomic and symlink-safe at the destination), makes `facts.json` replacement race- and symlink-resistant.
- **Strict Zod schemas** (`.strict()`) on `FactsFileSchema` reject unknown keys, neutralizing prototype-pollution / `__proto__` smuggling via a tampered `facts.json`.
- **Fact-extraction regexes are linear-time** — each rule is a single-quantifier `prefix \s+ ([^…]+)` shape with no nested/overlapping quantifiers, so no catastrophic-backtracking (ReDoS) path exists even on large adversarial input.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | MEDIUM-1 unbounded growth / O(n²) fact rewrite | Cap turn/fact/input sizes and total fact count; rotate append-only files; avoid full-file rewrite |
| 2 | Medium | MEDIUM-2 `stripControl` bidi gap + single-layer sanitization | Add U+061C and remaining invisibles to `BIDI_RE`; re-sanitize at every render boundary |
| 3 | Low | LOW-1 symlink-follow / TOCTOU on capture write paths | Use `O_NOFOLLOW` opens and/or re-assert `assertWithinRoot` before the four writes |
| 4 | Low | LOW-2 fail-open permissions | Add `stat`-based `verifyPerms` after `chmod`; chmod every created path segment |
| 5 | Low | LOW-3 non-finite vector components | Reject vectors containing non-finite values in `prepareEmbedding` |
| 6 | Info | INFO-1 path/cause disclosure in errors | Relativize paths and drop raw `cause` from user-facing output if logs leave the host |
| 7 | Info | INFO-2 non-atomic multi-file write | Document ordering; make consumers tolerate a trailing unindexed turn |
