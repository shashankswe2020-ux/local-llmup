# Code Review Checkpoint 16: Task B7 — catalog `source` gguf/mlx schema + validators + types

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-06
> **Scope:** Task B7 (Phase 1 of the pluggable-backends plan) — uncommitted working-tree changes only. Extends `ModelSourceSchema` with optional `gguf{repo,revision,file,sha256}` and `mlx{repo,revision}` sub-schemas (both `.strict()`); adds `HF_REPO_ID_RE`, `REVISION_RE` (40-hex), and `isSafeModelFile()`; widens the ≥1-source refine. Adds `GgufSource`/`MlxSource` domain interfaces and extends `ModelSource`. Changed files: `src/catalog/schema.ts`, `src/types.ts`, `tests/catalog/schema.test.ts`.
> **Test suite:** 720/720 passing (48 files); typecheck ✅; build ✅; lint ✅ on all B7 files.

---

## Verdict: ✅ APPROVE

**Overview:** A tight, well-scoped, security-conscious extension. Every B7 acceptance criterion is met: `gguf`/`mlx` parse, unknown keys are rejected (`.strict()`), `revision` is pinned to a 40-hex SHA (floating tags like `main`/`HEAD` are refused), `file` blocks globs/`..`/absolute/backslash paths, the HF repo-id validator accepts `mlx-community/Qwen3-14B` and rejects `../x`/absolute/leading-dash, the ≥1-source refine is preserved, and the committed 58-model catalog still validates (covered by `tests/catalog/seed.test.ts` + `bootstrap.test.ts`). No Critical findings. One Important defense-in-depth hardening for the later HF-URL boundary, plus four Suggestions.

---

## Critical Issues

None.

## Important Issues

### 1. `file` and `gguf.repo`/`mlx.repo` accept percent-encoded sequences and control characters
- **File:** `src/catalog/schema.ts:30-36` (`isSafeModelFile`), `src/catalog/schema.ts:18` (`HF_REPO_ID_RE`)
- **Problem:** `isSafeModelFile` blocks glob metacharacters, backslashes, absolute paths, and `.`/`..` *segments*, but does not reject `%` or ASCII control characters. A catalog author (or a compromised catalog) could encode `file: "%2e%2e/secret.gguf"` — the segment check sees `%2e%2e` (not literally `..`) and passes. Per the plan, `file`/`repo`/`revision` feed a Hugging Face download URL (`.../resolve/{revision}/{file}`) and a local cache path at B13. If B13 URL-decodes or a server decodes `%2e%2e` → `..`, the segment-based guard here is bypassed. Control characters (`\n`, `\0`) in `file`/`repo` are likewise accepted and could enable log injection or odd path behavior. This is **defense-in-depth**, not an exploit at B7 (no fetch happens yet), and B13's `assertSafeFetchUrl` is the primary control — but the check is nearly free at the schema boundary and real GGUF filenames/HF repo ids never contain `%` or control chars, so there is zero false-positive cost.
- **Fix:** Reject percent-encoding and control chars at the schema boundary:
  ```ts
  function isSafeModelFile(f: string): boolean {
    if (f.length === 0) return false;
    if (/[*?[\]{}]/.test(f)) return false;
    if (f.includes("\\")) return false;
    if (f.startsWith("/")) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f%]/.test(f)) return false; // control chars + percent-encoding
    return f.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  }
  ```
  And tighten the repo validator to exclude `%` (already excluded by `HF_REPO_ID_RE`'s allowed class `[a-zA-Z0-9._-]`, so `repo` is already safe here — only `file` needs the change). Add table-driven tests for `"%2e%2e/x.gguf"`, `"a%2fb.gguf"`, and a control char.

## Suggestions

### 1. `source.hf` remains an unvalidated loose string while `gguf.repo`/`mlx.repo` are strict repo ids
- **File:** `src/catalog/schema.ts:78`
- The legacy `hf: z.string().min(1).optional()` accepts any non-empty string (including `../x` or an absolute path), whereas the new `gguf.repo`/`mlx.repo` go through `HfRepoIdSchema`. This is acceptable for B7 because `hf` is *advisory* (B8 maps it to "no backend match", so it is not a download/cache input), but the asymmetry is a latent trap: if a future task ever threads `source.hf` into a fetch or path, it inherits none of the traversal guards. Either reuse `HfRepoIdSchema` for `hf` now (it should already satisfy it for the 58 existing entries — verify against `data/models.json`), or add a one-line comment at `hf` stating it is advisory-only and MUST NOT feed a fetch/cache path without re-validation.

### 2. Missing test: malformed `gguf.sha256` rejection
- **File:** `tests/catalog/schema.test.ts:127` (the "source gguf/mlx (B7)" block)
- The `Quantization` block tests a malformed `sha256` (`"xyz"` → throws), but the new `gguf.sha256` (validated by the same `SHA256_RE`) has no negative test — only the "without sha256" and "with valid sha256" paths are exercised. Add `withSource({ gguf: { ...validGguf, sha256: "xyz" } })` → `toThrow()` to lock the digest-format branch.

### 3. `REVISION_RE` uses the `i` flag; git commit SHAs are canonically lowercase
- **File:** `src/catalog/schema.ts:16`
- `/^[0-9a-f]{40}$/i` accepts `A…A` (uppercase). Git object names are lowercase hex; an uppercase revision is an authoring error that would surface only at fetch time. Dropping `i` (matching git's own casing) tightens pinning at no cost. Minor — the `SHA256_RE` uses `i` too, so if you keep `i` for consistency that is a defensible choice; just note the intent.

### 4. Redundant `.min(1)` on `file`
- **File:** `src/catalog/schema.ts:48-52`
- `isSafeModelFile` already rejects empty strings (`if (f.length === 0) return false`), so the chained `.min(1)` is redundant. Harmless; leave it if you prefer the explicit Zod-level message, but it is dead validation.

## What's Done Well

- **Path traversal is blocked at the boundary, segment-wise.** `isSafeModelFile` rejects absolute paths, backslashes, glob metacharacters, and any `.`/`..` path segment — the correct model for "safe repo-relative path" — and the `it.each` table covers `../secret.gguf`, `a/../b.gguf`, `/abs/path.gguf`, and `sub\file.gguf`.
- **Supply-chain integrity via pinned revisions.** Requiring a 40-hex SHA and refusing `main`/`HEAD`/`v1.0` means weights resolve to an immutable commit — a floating tag can never silently repoint the download. Exactly the right posture for an integrity/fail-closed project.
- **`.strict()` on both sub-schemas + the refine widened correctly.** Unknown keys in `gguf`/`mlx` throw, and the ≥1-source refine now admits `gguf`/`mlx` alone (tested in isolation via `withSource`), so a gguf-only or mlx-only model validates while `{}` still fails.
- **Honesty-gate-consistent optional `sha256`.** `gguf.sha256` mirrors the `Quantization.sha256` pattern — absent → size-only verify, never a fabricated digest.
- **Compile-time drift guard covers the new shapes.** `_CatalogConforms = AssertAssignable<z.infer<typeof CatalogSchema>, Catalog>` means the new `GgufSource`/`MlxSource` interfaces and the inferred schema type are kept in lockstep; a loosened schema that widened the inferred type would fail the build.
- **Clean reuse and naming.** `HfRepoIdSchema` is factored once and shared by both sub-schemas; `HF_REPO_ID_RE`/`REVISION_RE`/`isSafeModelFile` are well-named with precise doc comments. Strict-TS clean: no `any`, named exports, explicit return type on `isSafeModelFile`, ESM `.js` paths.
- **Thorough, table-driven tests.** `it.each` tables exercise the revision (39/40/41-char, non-hex, `main`/`HEAD`/`v1.0`), the file guard, and the repo-id validator (valid `owner/name` forms; invalid `../x`, absolute, leading dash, extra slash, `.hidden`, trailing/leading slash) — strong coverage for a security-critical validator.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 720/720 pass. New "source gguf/mlx (B7)" block covers accept/reject for gguf+mlx, strict unknown-key rejection, 40-hex revision, unsafe-file table, HF repo-id table, and missing-required-field cases. |
| Build verified | ✅ | `tsc` and `tsc --noEmit` clean; drift guard `_CatalogConforms` compiles against the new interfaces. |
| Security checked | ✅ | Traversal, absolute, backslash, glob, and floating-tag vectors all rejected. One residual defense-in-depth gap (percent-encoding/control chars in `file`) — Important #1; primary control is B13 `assertSafeFetchUrl`. |
| Coverage | ⚠️ | Comprehensive except the `gguf.sha256` malformed-digest branch (Suggestion #2). |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Reject percent-encoding + control chars in `isSafeModelFile` (defense-in-depth for the B13 HF-URL/cache boundary) | before B13, or B7 follow-up |
| 2 | Suggestion | Validate `source.hf` with `HfRepoIdSchema` or annotate it advisory-only | backlog |
| 3 | Suggestion | Add a malformed-`gguf.sha256` rejection test | B7 follow-up |
| 4 | Suggestion | Consider dropping the `i` flag on `REVISION_RE` (lowercase git SHAs) | backlog |
| 5 | Suggestion | Remove redundant `.min(1)` on `gguf.file` | backlog |
