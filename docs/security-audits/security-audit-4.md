# Security Audit Report #4

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-05
> **Scope:** T22 memory store — `src/memory/store.ts` (`memorySlug`, `ensureDir`, `isWithin`, `resolveStoreDir`, `openMemoryStore` create/load path) and the **planned** exclusive-create (`wx`) hardening. Threat model: `modelId` → filesystem path segment under `~/.local-llmup/memory/<slug>/`; store holds chat history + durable user facts (confidentiality + integrity, owner-only 0700/0600).
> **Dependencies:** 0 known vulnerabilities (`npm audit --omit=dev`).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 3 |
| Info | 2 |

**Overall:** The slug function correctly forecloses classic `../` traversal (no `.`/`..`/`/` can survive the charset filter + leading/trailing-dot strip), `isWithin` uses a correct `root + sep` prefix check, and corrupt-store handling fails closed with typed errors and no clobber. The residual risks are (1) a **concurrent-create data-integrity race** in the current temp+rename create path that permits silent cross-contamination between two ids under load, (2) **umask/permission-hardening gaps** on recursively-created intermediate directories and the create-time window, (3) a **directory-component TOCTOU** because the write targets the pre-realpath `dir`, and (4) **missing post-write `fs.stat` verification** required by the acceptance bar. The planned `wx` change is a real improvement but does **not by itself** close the torn-read window or the directory-swap TOCTOU (see [LOW-3], [MEDIUM-2] and the Q&A).

---

## Findings

### [HIGH-1] Concurrent create race → silent cross-contamination (last-writer-wins rename)

- **Location:** `src/memory/store.ts` — `openMemoryStore` create path (temp-in-staging + `renameSync` over target).
- **Description:** On a fresh slug, the create path writes meta to a staging temp and `renameSync`es it over `<dir>/meta.json`. `rename(2)` unconditionally overwrites the destination, so two concurrent `openMemoryStore` calls that resolve to the **same slug** (either the same `modelId` twice, or two *distinct* ids that slug alike — e.g. `llama3:8b` and `llama3/8b` both → `llama3-8b`) both observe `ENOENT`, both create meta, and the second rename clobbers the first. The winning process holds an in-memory `meta` (with its own `modelId`) that no longer matches the `meta.json` now on disk. The collision check (`meta.modelId !== modelId`) ran at creation and passed for both, so **neither** process detects the swap.
- **Impact:** Violates the acceptance bar ("slug-collision must NOT silently overwrite; two distinct model ids that slug alike must not cross-contaminate"). Under concurrency the durable `meta.json` and any subsequently appended chat/facts can be attributed to the wrong `modelId`, silently mixing two models' memory.
- **Proof of concept:** Run two processes racing `openMemoryStore(cfg, "llama3:8b")` and `openMemoryStore(cfg, "llama3/8b")` against an empty store. Both slug to `llama3-8b`, both take the `ENOENT` branch, both write meta, `rename` last-writer-wins. The loser proceeds believing its `meta.modelId` is authoritative while disk says otherwise.
- **Recommendation:** Adopt **first-writer-wins atomic create**. `wx` (`O_CREAT|O_EXCL`) is the right primitive but must be paired with atomic *content*: write the temp fully, `fsyncSync` it, then `linkSync(temp, target)` — `link(2)` fails with `EEXIST` when the target already exists **and** publishes complete content atomically (unlike a partially-written direct `wx` write). On `EEXIST`, re-read + Zod-validate + collision-check the existing meta and reconcile (first-writer-wins). Do **not** rely on plain `renameSync` for a create-once file.

  ```ts
  // temp written + fsync'd, then:
  try {
    linkSync(temp, target);            // atomic, fails if target exists
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // first-writer-wins: re-read, validate, collision-check the winner
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
  ```

### [MEDIUM-1] Recursive `mkdir` leaves intermediate directories at umask-derived permissions; only the leaf is chmod'd

- **Location:** `src/memory/store.ts` — `ensureDir` (`mkdirSync(dir, { recursive: true, mode: DIR_MODE }); chmodSync(dir, DIR_MODE);`).
- **Description:** With `recursive: true`, any **intermediate** parent directories that Node creates in the same call (e.g. `~/.local-llmup` and `~/.local-llmup/memory` when they don't yet exist) are created with `mode & ~umask` and are **never** chmod'd — `chmodSync` only fixes the final leaf. Under a permissive umask (e.g. `0o022`, `0o000`) those intermediates become group/world-traversable (`0o755`/`0o777`), exposing the path to the owner-only store. Additionally, even for the leaf there is a window between `mkdirSync` (mode masked by umask) and `chmodSync` where the directory is more permissive than `0o700`.
- **Impact:** Confidentiality of chat history / durable facts degraded on multi-user hosts; a co-located user can traverse into the memory tree during and after creation.
- **Recommendation:** (a) Set a restrictive process umask at CLI startup as defense-in-depth (`process.umask(0o077)`); (b) create/verify each level explicitly and `chmodSync` every directory the tool is responsible for (root and slug dir), not just the leaf; (c) after creation, `statSync` and assert `(mode & 0o077) === 0`, failing closed (see [MEDIUM-3]).

### [MEDIUM-2] Directory-component TOCTOU: write targets pre-realpath `dir`, not the validated `dirReal`

- **Location:** `src/memory/store.ts` — `resolveStoreDir` returns `dir` (the `join(memoryDir, slug)` symbolic path) after validating `dirReal`; the subsequent meta write uses `join(dir, META_FILE)`.
- **Description:** Containment is checked against `realpathSync(dir)` at time T1, but the write happens at T2 against the **symbolic** `dir`. Between T1 and T2 the `slug` component (or an ancestor) can be swapped for a symlink pointing outside `memoryDir`, and the write follows it. This is the intentional "validate `dirReal`, return `dir`" divergence noted in repo memory, but it remains a genuine residual.
- **Impact:** Write of `meta.json` (and later chat/fact files) outside the memory root, or over an attacker-chosen target, via symlink race. Practically bounded by the fact that `memoryDir` is `0o700` owner-only — an attacker who can plant symlinks inside it is already the same UID (or root); the exposure is same-user compromised-process / root, not remote.
- **Recommendation:** For the meta file specifically, exclusive-create (`wx` = `O_CREAT|O_EXCL`) **does not follow a final symlink** — `open(2)` with `O_EXCL|O_CREAT` errors on a symlinked final component — so the planned change hardens the *file* leg for free. For the **directory** component, either (a) re-run `realpathSync(dir)` + `isWithin` immediately before the write and operate on that resolved path, or (b) open a descriptor to the realpath'd directory once and write relative to it (closest Node gets to `openat`). Document the residual and its dependence on `0o700` ownership.

### [MEDIUM-3] No post-write `fs.stat` verification of 0700/0600 (fails open under a hostile umask)

- **Location:** `src/memory/store.ts` — `ensureDir` and the file-write path (`writeFileSync(..., { mode: FILE_MODE })` then `chmodSync`).
- **Description:** The module trusts that `mkdir`/`writeFile` + `chmod` produced `0o700`/`0o600`, but never verifies. The acceptance bar explicitly requires "0600 verified via fs.stat under a hostile umask." If `chmod` is a no-op or subverted (e.g. a pre-existing planted dir/file owned by another user, an odd filesystem, or an ACL layer), the code proceeds with over-permissive storage silently.
- **Impact:** Chat history / durable facts can be stored world- or group-readable without any signal; confidentiality guarantee is unverified.
- **Recommendation:** After creating each directory and writing each file, `statSync` and assert both mode and ownership, failing closed with a typed `MemoryError`:

  ```ts
  const st = statSync(path);
  if ((st.mode & 0o777 & 0o077) !== 0) throw new MemoryError(`insecure permissions on ${stripControl(path)}`);
  if (st.uid !== process.getuid?.()) throw new MemoryError(`unexpected owner on ${stripControl(path)}`);
  ```

### [LOW-1] No slug length cap → `ENAMETOOLONG` surfaces as an untyped raw error

- **Location:** `src/memory/store.ts` — `memorySlug` (no length bound).
- **Description:** An oversized `modelId` yields a path segment exceeding the filesystem `NAME_MAX` (typically 255 bytes). `mkdirSync`/`realpathSync` then throw a raw `ENAMETOOLONG` `Error` that isn't wrapped in `MemoryError`/`ValidationError`, breaking the "corrupt/hostile input → typed error" contract.
- **Impact:** Ungraceful failure; inconsistent error surface. Low direct security impact (this module is defensive-secondary; ids are resolver-validated upstream).
- **Recommendation:** Cap the slug (e.g. 128 chars). When truncating, append a short hash of the **full** `modelId` (e.g. first 8 hex of a SHA-256) so distinct-but-truncating ids don't newly collide — this also shrinks the [HIGH-1]/[LOW-2] collision surface at the source.

### [LOW-2] Windows reserved device names and trailing dot/space not neutralized

- **Location:** `src/memory/store.ts` — `memorySlug`.
- **Description:** The charset filter permits slugs like `con`, `nul`, `prn`, `aux`, `com1`, `lpt1`, which are reserved device names on Windows/NTFS and cannot be used as filenames. Trailing dots are stripped, but the slug can otherwise produce Windows-hostile names. (Trailing spaces are already handled — spaces aren't in the allowed set.)
- **Impact:** Store creation fails or misbehaves on Windows for specific ids. Low, given the likely POSIX-first target, but the module bills itself as a reusable primitive.
- **Recommendation:** On `win32`, reject or prefix reserved names (e.g. `_con`) and forbid trailing `.`/space. Keep the check platform-gated to avoid needless mangling on POSIX.

### [LOW-3] Torn-read window on a directly-written `meta.json` (planned `wx` alone is not atomic content)

- **Location:** Planned hardening — `writeFileSync(target, json, { flag: "wx", mode: FILE_MODE })`.
- **Description:** `O_EXCL` guarantees a single creator, but `writeFileSync` may perform multiple `write(2)` calls; a concurrent reader that took the `EEXIST` branch can observe a **partially written** `meta.json` (torn read) → `JSON.parse` throws → transient `MemoryError`, or in the worst case a truncated-but-parseable object. `wx` fixes *who creates* but not *when content is complete*.
- **Impact:** Spurious `MemoryError`s / flaky reads under concurrency; not a clobber, but a reliability + integrity smell.
- **Recommendation:** Combine exclusivity with atomic content publication: write temp → `fsync` → `linkSync(temp, target)` (see [HIGH-1]). `link` publishes fully-written content atomically and preserves first-writer-wins. If sticking with direct `wx`, have `EEXIST` readers retry `JSON.parse` with a tiny bounded backoff before erroring.

### [INFO-1] `readFileSync` on `meta.json` has no size cap

- **Location:** `src/memory/store.ts` — load path (`readFileSync` + `JSON.parse`).
- **Description:** A maliciously large `meta.json` is read fully into memory before parsing. Bounded in practice by `0o700` owner-only access (attacker must already be the same user), so this is a local self-DoS at most.
- **Recommendation:** Optionally `statSync` and reject files above a sane cap (e.g. 64 KiB) before reading.

### [INFO-2] No Unicode normalization before slugging

- **Location:** `src/memory/store.ts` — `memorySlug` (`toLowerCase` without NFC/NFKC).
- **Description:** Non-ASCII input is collapsed to `-` by the charset filter, so homoglyph/normalization variants map to the same slug — increasing the collision surface. This is caught by the `meta.modelId` collision check (and by [HIGH-1]'s fix), so there's no bypass, only additional collisions.
- **Recommendation:** Normalize (`modelId.normalize("NFKC")`) before slugging for determinism; rely on the hash suffix from [LOW-1] for uniqueness.

---

## Answers to the Posed Questions

1. **Does `wx` fully close the silent-overwrite window, or is a lock still needed? Partial-read window?**
   `wx` closes the *creator* race (only one process creates; others get `EEXIST` and reconcile via re-read + collision-check → first-writer-wins) **without** an explicit lock for this create-once file. However, plain `wx` + `writeFileSync` leaves a **torn-read window** ([LOW-3]): a concurrent `EEXIST` reader may see a partially written file. Close it by publishing content atomically — temp → `fsync` → `linkSync` — which gives you *both* first-writer-wins *and* all-or-nothing content, no lock required. A lock only becomes necessary if the file later becomes mutable (append/rewrite of chat/facts); for create-once meta it is not.

2. **Residual symlink/TOCTOU between the containment check and the write; practical risk under 0700?**
   Yes, residual. The check validates `dirReal` but the write uses the symbolic `dir` ([MEDIUM-2]), so the `slug` directory (or an ancestor) can be swapped for an out-of-root symlink between T1 and T2. The *file* leg is largely neutralized by `wx` (`O_EXCL|O_CREAT` refuses a symlinked final component); the *directory* leg is not. Given `memoryDir` is `0o700` owner-only, the attacker must already share the UID (or be root), so the practical blast radius is a compromised same-user process, not a remote or cross-user attacker. Recommend a re-`realpath` + `isWithin` immediately before the write (or an fd to the realpath'd dir) and explicitly documenting the residual.

3. **Can a crafted `modelId` still escape the root or produce a dangerous slug?**
   Escape: **No** — `.`/`..`/`/`/`\\` cannot survive the `[^a-z0-9._-]` filter plus leading/trailing-dot strip, so no traversal segment is producible; and `isWithin(rootReal, dirReal)` backstops. Dangerous slugs that remain: **very long ids** → `ENAMETOOLONG` untyped error ([LOW-1]); **Windows reserved names** `CON`/`NUL`/`COM1`/… and trailing dot/space ([LOW-2]); **Unicode normalization** collisions ([INFO-2]). None escape the root; they degrade gracefully-vs-ungracefully and inflate collisions.

4. **Are 0700/0600 reliably enforced under a permissive umask, including recursive intermediates?**
   **Not reliably.** The leaf dir and each written file are `chmod`'d, so they converge to `0o700`/`0o600` — but (a) `recursive: true` **intermediate** dirs are never chmod'd and keep umask-derived perms ([MEDIUM-1]); (b) there's a brief create-time window at masked perms before `chmod`; and (c) there is **no `fs.stat` verification**, so any failure to tighten is silent ([MEDIUM-3]). Fix with `process.umask(0o077)` at startup + chmod every level the tool creates + a post-write `statSync` assertion that fails closed.

---

## Positive Observations

- **Traversal-safe slug:** the charset filter + leading/trailing-dot strip provably eliminate `.`, `..`, `/`, and `\\` segments; the empty-slug guard throws `ValidationError` instead of producing a bare-root path.
- **Correct containment check:** `isWithin` compares against `root + sep` (not a bare `startsWith(root)`), so sibling-prefix escapes like `/…/memory-evil` are rejected.
- **Fails closed on corruption:** unparseable / schema-invalid / `modelId`-mismatched meta all raise typed `MemoryError` and never clobber the existing store; `z.object(...).strict()` blocks unexpected keys and any prototype-pollution style merge.
- **Terminal-injection hygiene:** `modelId` is `stripControl`'d in every error message, consistent with the codebase-wide ANSI/escape defense noted in audits #2–#3.
- **Atomic-write intent + same-fs staging:** staging on the same filesystem as home makes `rename` atomic (the durability instinct is right — it just needs first-writer-wins semantics per [HIGH-1]).
- **Explicit `chmod` after create:** the code doesn't *rely* on umask for the leaf; it actively tightens (the gap is intermediates + verification, not intent).

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | High | Concurrent create last-writer-wins clobber (HIGH-1) | temp → fsync → `linkSync` for first-writer-wins atomic create; `EEXIST` → re-read + validate + collision-check |
| 2 | Medium | Umask leaks on recursive intermediate dirs (MEDIUM-1) | `process.umask(0o077)` at startup; chmod every created level, not just the leaf |
| 3 | Medium | Directory-component TOCTOU (write uses `dir` not `dirReal`) (MEDIUM-2) | Re-`realpath`+`isWithin` immediately before write (or fd to realpath'd dir); `wx` covers the file leg |
| 4 | Medium | No post-write 0700/0600 verification (MEDIUM-3) | `statSync` assert `(mode & 0o077)===0` and owner==uid; fail closed with `MemoryError` |
| 5 | Low | No slug length cap → untyped `ENAMETOOLONG` (LOW-1) | Cap slug (~128) + append hash of full `modelId` (also cuts collisions) |
| 6 | Low | Windows reserved names / trailing dot-space (LOW-2) | Platform-gate: reject/prefix `CON`/`NUL`/`COM*`/`LPT*` and trailing `.`/space on win32 |
| 7 | Low | Torn read of directly-written `wx` meta.json (LOW-3) | Publish content atomically via temp+fsync+`link` (or bounded parse-retry on `EEXIST`) |
| — | Info | No `readFileSync` size cap (INFO-1) | Reject oversized `meta.json` before read |
| — | Info | No Unicode normalization before slug (INFO-2) | `normalize("NFKC")` for determinism; uniqueness via LOW-1 hash |

---

## Note on Prior Unresolved Findings

Open **issue #1** (reused/wrong-pid signaling from tampered/stale `state.json`, tracked since audit #1 and reaffirmed in #3) is **out of scope** for the memory store and is not affected by this module. No prior memory-store findings exist (T22 is new). No regression of previously-closed items observed.
