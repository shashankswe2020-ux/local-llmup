# Code Review Checkpoint 5: Task 22 (Memory Store Foundation)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T22 — per-model memory store foundation (`memorySlug`, dir provisioning, meta read/write, traversal & collision safety). Spec §3.3.
> **Test suite:** 339 tests passing, typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE

**Overview:** `src/memory/store.ts` is a tight, well-structured foundation. The structural traversal defense (all separators collapse to `-`, so a slug is always a single path component) combined with realpath containment is genuinely solid, and permission handling correctly avoids any world-readable window. One correctness gap exists under concurrency (colliding stores can be silently overwritten if two processes create simultaneously), which is worth tracking but is reasonably deferred to the lock work in T23/T25. No changes are required to merge the foundation.

---

## Critical Issues

None.

---

## Important Issues

### 1. Concurrent creation can silently overwrite a colliding store
- **File:** `src/memory/store.ts` (`loadOrCreateMeta` / `writeMetaAtomic`)
- **Problem:** The collision guarantee ("slug-collision must NOT silently overwrite") holds for the sequential reopen case (recorded `modelId` mismatch → `MemoryError`), but not under concurrency. Two processes opening distinct model IDs that normalize to the same slug can both observe `ENOENT` on `meta.json`, then both `writeMetaAtomic`. `renameSync` is last-writer-wins and never fails on an existing target, so process A returns an in-memory store claiming `modelId=A` while the on-disk `meta.json` says `modelId=B`. A subsequent capture (T23) using A's handle would then write into a store whose metadata belongs to B — a silent overwrite that the sequential check is specifically designed to prevent. The `config.lockFile` is available but unused here.
- **Fix:** Make meta creation exclusive rather than last-writer-wins. Either acquire `config.lockFile` around the create path, or create the meta target with an exclusive flag and re-validate on `EEXIST`:
  ```ts
  // instead of renameSync (which clobbers), link + verify, or open target O_EXCL:
  try {
    writeFileSync(target, json, { flag: "wx", mode: FILE_MODE });
    chmodSync(target, FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return loadOrCreateMeta(config, dir, modelId); // re-read; hits the mismatch guard
    }
    throw new MemoryError(`failed to write memory metadata: ${target}`, { cause: error });
  }
  ```
  (Trade-off: this writes the target directly rather than temp+rename. If the atomic-staging pattern must be preserved, gate the whole create in a lock instead.) Acceptable to defer to T23/T25 lock work, but track it so the acceptance criterion is honored end-to-end.

---

## Suggestions (Minor)

### 1. Write path uses the non-realpathed `dir`; residual TOCTOU
- **File:** `src/memory/store.ts` (`resolveStoreDir` returns `dir`, `writeMetaAtomic` renames into `join(dir, META_FILE)`)
- Containment is validated on `dirReal`, but writes target `dir` (the pre-resolution join path). Between the `realpathSync` check and the later `renameSync`, an actor with write access to `memoryDir` could swap `<slug>` for a symlink escaping the root. This is mitigated in practice by `memoryDir` being 0700 (owner-only) and the single-user local model, so severity is low — but worth a short comment noting the assumption, or operate on `dirReal` for the write path.

### 2. No maximum slug length
- **File:** `src/memory/store.ts` (`memorySlug`)
- A very long model ID produces a very long slug; `realpathSync`/`mkdirSync` then throw `ENAMETOOLONG`, which surfaces as the generic `failed to resolve memory store...` `MemoryError`. Consider capping slug length (e.g. 128 chars, optionally suffixed with a short hash of the full id to preserve uniqueness) so long-but-distinct IDs stay distinguishable and the error is intentional rather than incidental.

### 3. Windows portability of containment check
- **File:** `src/memory/store.ts` (`isWithin`)
- `candidate.startsWith(root + sep)` is case-sensitive and `sep`-dependent. On Windows (and case-insensitive macOS volumes), `realpathSync` can return differing casing/short-name forms, causing a legitimate path to fail containment → spurious `MemoryError`. If Windows is in scope, normalize case before comparison; if not, a one-line comment declaring POSIX-only support would set expectations.

### 4. `ensureDir` does not chmod recursively created intermediates
- **File:** `src/memory/store.ts` (`ensureDir`)
- `mkdirSync(dir, { recursive, mode })` then `chmodSync(dir, DIR_MODE)` only hardens the final directory. If an intermediate (e.g. `homeDir`) has to be created here, it is left at `mode & ~umask` with no follow-up `chmod`. In practice `homeDir` is provisioned earlier by config, so this is defensive only — worth confirming that invariant holds wherever `openMemoryStore` can be the first writer.

### 5. `meta.json` permissions not re-healed on reopen
- **File:** `src/memory/store.ts` (`loadOrCreateMeta`)
- The directory perms self-heal on every open via `ensureDir` + `chmodSync`, but an existing `meta.json` with drifted perms is read as-is and never re-chmod'd. Consider a `chmodSync(target, FILE_MODE)` on the successful-read path for parity with the directory hardening.

---

## Nits

### 1. `createdAt` validated only as non-empty string
- **File:** `src/memory/store.ts` (`MemoryMetaSchema`)
- `createdAt: z.string().min(1)` accepts any non-empty string. Since it is always written via `new Date().toISOString()`, tightening to `z.string().datetime()` would catch corruption/tampering of the timestamp field for free.

### 2. `resolveStoreDir` returns `dir` while validating `dirReal`
- **File:** `src/memory/store.ts` (`resolveStoreDir`)
- The intentional divergence (validate resolved path, return join path to match the atomic-write pattern) is subtle. A one-line comment would save the next reader a double-take.

---

## What's Done Well

- **No world-readable window on the meta file.** `writeFileSync(tempFile, json, { mode: FILE_MODE })` sets the *creation* mode, which umask can only make *more* restrictive — so the temp file is never broader than 0600 even before the belt-and-suspenders `chmodSync`. This correctly avoids the classic create-then-chmod race.
- **Structural traversal defense.** Collapsing every non-`[a-z0-9._-]` run (including all separators) to `-` guarantees a slug is always a single path component, so `join(memoryDir, slug)` cannot traverse regardless of input — the realpath containment check is then a second, independent layer that also catches symlinked slug dirs.
- **Non-silent collision detection.** Recording `modelId` in `meta.json` and hard-failing on mismatch is the right call, and the test proves the original meta is left untouched.
- **Consistent atomic-write reuse.** Temp-in-staging + `renameSync` with best-effort `unlinkSync` cleanup faithfully mirrors the established `state.ts` pattern, and corrupt/unparseable/schema-invalid metadata all become typed `MemoryError`s without clobbering the store.
- **Umask-hostile perm verification in tests.** Asserting 0600/0700 under `process.umask(0)` is exactly the right way to prove the hardening.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 10 store tests cover slug mapping, traversal neutralization, empty-slug rejection, idempotent reopen, collision, umask-0 perms, corrupt/invalid meta, and symlink-escape → `MemoryError`. |
| Build verified | ✅ | `tsc` build + `tsc --noEmit` typecheck both clean. |
| Security checked | ✅ | Traversal (structural + realpath), perms (no world-readable window), non-silent collision all sound; one concurrency gap noted (Important #1). |
| Coverage | ✅ | 339 total passing; store behaviors exercised against a real temp home. Concurrency path is not (and is hard to) unit-test — track via issue. |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Concurrent creation can silently overwrite a colliding store (no lock/exclusive create) | T23/T25 lock work |
| 2 | Minor | Write path uses non-realpathed `dir`; residual TOCTOU (comment or use `dirReal`) | backlog |
| 3 | Minor | Cap slug length (hash-suffix long IDs) | backlog |
| 4 | Minor | Windows/case-insensitive containment check portability | backlog |
| 5 | Minor | `ensureDir` doesn't chmod recursively created intermediates | backlog |
| 6 | Minor | `meta.json` perms not re-healed on reopen | backlog |
| 7 | Nit | Tighten `createdAt` to `z.string().datetime()` | backlog |
| 8 | Nit | Comment the `dir` vs `dirReal` return in `resolveStoreDir` | backlog |
