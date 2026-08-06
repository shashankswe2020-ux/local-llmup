# Code Review Checkpoint 22: Task B13

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 7 August 2026
> **Scope:** Task B13 — shared, guarded weight-acquisition module. Two new files: `src/backend/acquire.ts`, `tests/backend/acquire.test.ts` (Phase 2 of `docs/plans/task-plan-pluggable-backends.md`, spec §2.8 M2 / §2.9).
> **Test suite:** 812 tests passing (per author), typecheck ✅, build ✅, lint ✅ (both scope files clean — verification reported by author, not re-run in full)

---

## Verdict: ✅ APPROVE

**Overview:** `acquireWeight` downloads a single artifact from a **pinned** Hugging
Face resolve URL for self-managing backends, streaming to a `0600` temp file in a
`0700` per-repo cache, hashing in-flight, verifying the resolved commit and (when
supplied) the SHA-256 digest, then **atomically renaming** into place and discarding
partials on any failure. The SSRF guard, traversal validators, `realpath` symlink
check, and honesty gate (`digestVerified:false` on missing digest) are all correctly
wired and mirror the established `writeState`/catalog-schema conventions. The findings
below are non-blocking: two Important items concern a conditionally-skipped commit
guard and a test that does not actually prove the "discard partial" clause it claims.
No Critical issues; approving with follow-ups.

---

## Critical Issues

None.

## Important Issues

### 1. Absent `X-Repo-Commit` header silently skips the commit-pinning assertion
- **File:** [src/backend/acquire.ts](src/backend/acquire.ts#L211-L216)
- **Problem:** The guard is `if (resolvedCommit !== null && resolvedCommit.toLowerCase() !== request.revision...)`. When the header is **absent** (`null`), the assertion is skipped and the artifact is promoted. The commit is still pinned in the URL path (`/resolve/<40-hex>/…`), which HF resolves server-side, so the practical risk is low — but when the caller supplies **no** `sha256` (the `digestVerified:false` path), a stripped/missing header means the response undergoes **zero** integrity confirmation beyond the URL. For a module whose whole contract is "fail-closed," a security header being absent should be an explicit, documented decision, not an implicit skip. Spec §2.8 H2 / plan acceptance say "resolved commit ≠ pinned revision → fail closed"; the `null` case is neither documented nor tested.
- **Fix:** Add an inline comment stating why a missing header is tolerated (URL pins the commit), and — for defence in depth — consider requiring the header when no digest is present:
  ```ts
  const resolvedCommit = response.headers.get("x-repo-commit");
  if (resolvedCommit === null) {
    // The commit is pinned in the resolve URL path; the header is corroboration.
    // With no expected digest we have no other confirmation, so refuse.
    if (request.sha256 === undefined) {
      throw new BackendError(`missing X-Repo-Commit and no expected digest for ${request.file}`);
    }
  } else if (resolvedCommit.toLowerCase() !== request.revision.toLowerCase()) {
    throw new BackendError(
      `resolved commit ${resolvedCommit} does not match pinned revision ${request.revision}`,
    );
  }
  ```
  (At minimum, add the clarifying comment even if the stricter branch is deferred.)

### 2. The digest-mismatch test does not actually prove the partial was discarded
- **File:** [tests/backend/acquire.test.ts](tests/backend/acquire.test.ts#L153-L162)
- **Problem:** The test comment reads "No leftover `*.tmp` partials in the cache dir," but the only assertion is `expect(statSync(dir).isDirectory()).toBe(true)` — it confirms the directory exists, not that it is free of `.part` files. The plan acceptance clause "digest mismatch discards partial, never promotes" is therefore only half-proven (the "never promotes" half is checked via `statSync(finalPath)` throwing; the "discards partial" half is not).
- **Fix:** Assert the cache directory contains no partial:
  ```ts
  import { readdirSync } from "node:fs";
  // …
  const dir = dirname(finalPath);
  expect(readdirSync(dir).some((f) => f.endsWith(".part"))).toBe(false);
  ```

## Suggestions (Minor)

### 1. Security-critical validators are duplicated from `catalog/schema.ts` (drift risk)
- **File:** [src/backend/acquire.ts](src/backend/acquire.ts#L48-L54), [src/backend/acquire.ts](src/backend/acquire.ts#L266-L281)
- `HF_REPO_ID_RE`, `REVISION_RE`, `SHA256_RE`, and `isSafeRepoRelativePath` are byte-for-byte re-implementations of the same constants and `isSafeModelFile` in [src/catalog/schema.ts](src/catalog/schema.ts#L31-L40) (the code comment even says "Mirrors the catalog schema's `isSafeModelFile`"). Two independent copies of a traversal/SSRF validator can silently diverge. Consider extracting them into a shared `src/backend/net.ts` (or a small `src/validators.ts`) and importing from both call sites.

### 2. Cache-hit path re-hashes the entire (potentially multi-GB) artifact on every call
- **File:** [src/backend/acquire.ts](src/backend/acquire.ts#L297-L309)
- `tryCacheHit` runs a full SHA-256 over the cached file on every `acquireWeight` invocation when a digest is supplied. This is the safe, integrity-first choice, but for a 4–8 GB GGUF it makes every `up` pay a full-file read+hash. If this becomes a hot path, consider recording a verified marker (e.g. a sibling `.verified` sentinel keyed by digest) so a previously-verified file skips re-hashing. Correctness is fine as-is; flagging as a performance note only.

### 3. Two fail-closed branches lack direct test coverage
- **File:** [src/backend/acquire.ts](src/backend/acquire.ts#L196-L205)
- No test exercises (a) the `existing?.isSymbolicLink()` guard on the **final file path** (the symlink test targets the `owner` directory component via `ensureCacheDir`'s `realpath` check, a different branch), or (b) the corrupt/mismatched-cache re-download path (`unlinkSync(finalPath)` then refetch). Both are security-relevant; add focused tests.

### 4. The "non-HTTPS / private-host" test short-circuits on protocol
- **File:** [tests/backend/acquire.test.ts](tests/backend/acquire.test.ts#L169-L172)
- `baseUrl: "http://169.254.169.254"` fails `assertSafeFetchUrl` on the **protocol** check (`non-HTTPS`) before the private-host branch is ever reached, so the private-host guard is not actually isolated here. It's still proven at the unit level in the `net` tests, but if the intent is to cover the private-host clause at the acquire boundary, add an `https://169.254.169.254` case (which reaches `assertNotPrivateHost`).

### 5. `mkdirSync(recursive)` follows a symlinked path component before the guard rejects it
- **File:** [src/backend/acquire.ts](src/backend/acquire.ts#L288-L296)
- `ensureCacheDir` calls `mkdirSync(parentDir, { recursive: true })` **before** the `realpath` `isWithin` check. When a cache component (e.g. `owner`) is a symlink pointing outside the root, `mkdir` follows it and creates the leaf directory in the external location; the check then correctly fails closed, but a stray empty directory has already been created outside the cache root. Low severity (no data written, fail-closed holds), but consider validating each component / using `lstat` on ancestors before `mkdir` if you want zero external side effects.

### 6. `unlinkSync(finalPath)` for a corrupt cache entry is outside the `try` block
- **File:** [src/backend/acquire.ts](src/backend/acquire.ts#L204)
- If removing a mismatched cached file fails (e.g. permissions), the raw `fs` error propagates unwrapped rather than as a `BackendError`, breaking the module's "throws typed errors" contract for that edge. Wrap it or convert to a `BackendError`.

## What's Done Well

- **Stream-based download + in-flight hashing** via a pass-through `Transform` feeding `createHash`, with `flags: "wx"` on the write stream — never buffers a multi-GB artifact, never overwrites an existing temp, and the byte counter is derived from the same chunks that are hashed. Clean and correct.
- **Atomic-rename discipline mirrors `writeState`:** the temp file lives in the destination directory (no cross-device copy), promotion happens only after verification, and every error path funnels through `discard(tempPath)`. The `catch` correctly re-throws typed `BackendError`/`ValidationError` and wraps unknowns with a `cause`.
- **Layered symlink/traversal defence:** lexical `isWithin(repoDir, finalPath)`, `realpath` `isWithin` on the created parent dir, and an `lstat` symlink check on the final target — defence in depth beyond the already-validated `file`.
- **Honesty gate is exact:** `digestVerified = request.sha256 !== undefined`, digest comparison is case-normalized, and a missing digest yields `false` on both the download and cache-hit paths — no fabricated pass.
- **Testable seams** (`AcquireFetch`, `FetchResponseLike`, injected `config`/`baseUrl`) keep the suite fully offline with no real network, filesystem-under-`tmpdir`, or child processes — matching the project's mocking rules.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | Cover happy path, cache hit, digest/commit/HTTP failures, SSRF (protocol + allowlist), traversal, invalid repo/revision, dir-symlink. Gaps noted (Important #2, Minor #3, #4). |
| Build verified | ✅ | Author-reported clean; not re-run per instructions. |
| Security checked | ✅ | SSRF guard wired, traversal validators present, `0600`/`0700` enforced with explicit `chmod`, atomic promotion, honesty gate honored. Two hardening notes (Important #1, Minor #5, #6). |
| Coverage | ⚠️ | Two fail-closed branches (final-path symlink, corrupt-cache re-download) and the "discard partial" assertion are not directly exercised. |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Document/tighten the `null` `X-Repo-Commit` skip; refuse when no digest is present | B14 slice or hotfix |
| 2 | Important | Assert no `.part` remains in the digest-mismatch test | backlog |
| 3 | Suggestion | Extract shared HF/SHA/path validators to one module (de-dup from `catalog/schema.ts`) | backlog |
| 4 | Suggestion | Add verified-marker to skip full re-hash on cache hit | backlog (perf) |
| 5 | Suggestion | Cover final-path symlink + corrupt-cache re-download branches | backlog |
| 6 | Suggestion | Add an `https://` private-IP acquire test to isolate the private-host guard | backlog |
| 7 | Suggestion | Avoid `mkdir` following a symlinked component before the `realpath` check | backlog |
| 8 | Suggestion | Wrap the corrupt-cache `unlinkSync` in a typed `BackendError` | backlog |
