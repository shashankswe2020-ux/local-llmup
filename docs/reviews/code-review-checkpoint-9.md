# Code Review Checkpoint 9: Task 29 (`catalog` command)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T29 — `catalog` command implementation (`src/commands/catalog.ts`, `src/cli.ts`, `tests/commands/catalog.test.ts`) against acceptance: fits/all view, stable format, and local incremental `--refresh` dry-run diff without commit.
> **Test suite:** 3 tests passing (1 file) for `tests/commands/catalog`, typecheck clean, lint clean, build clean.

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** Runtime behavior for the covered scenarios is correct: default `fits` filtering, `--all` inclusion with typed fit reason, and `--refresh` wiring to incremental enrich + dry-run diff output. However, acceptance-critical behavior is under-tested in two places, leaving realistic regression risk before merge.

---

## Critical Issues

None.

## Important Issues

### 1. Stable output contract is not actually verified by tests
- **File:** `tests/commands/catalog.test.ts:78`
- **Problem:** The tests only assert substring presence (`toContain`) for model ids/filter text and do not verify stable ordering or tabular structure, even though T29 acceptance explicitly requires a stable format. A regression in ordering (recency/id tie-break), row composition, or header layout in `runCatalog` would pass current tests.
- **Fix:** Add assertions that pin deterministic output structure and order. At minimum:
  - Assert header includes exact shown count format (`shown: X/Y`).
  - Assert row order for mixed release dates and equal-date id tie-break.
  - Assert expected columns render in fixed order (`Model`, `Params`, `Arch`, `Quant`, `Need GiB`, `Fit`, `Release`).
  - Prefer a focused snapshot or normalized line-by-line assertion for the table block.

### 2. CLI option forwarding for `catalog --all --refresh` is untested
- **File:** `tests/cli.test.ts:15`
- **Problem:** `registerCatalog` in `src/cli.ts` now introduces non-trivial flag mapping into `runCatalog`, but `tests/cli.test.ts` only validates command registration/help text and never executes CLI parsing/action paths. A wiring regression (e.g., flags not forwarded, wrong defaults, or inverted booleans) would not be detected.
- **Fix:** Add CLI-level tests that invoke parsing/action and assert `runCatalog` receives:
  - `{}` for `catalog`
  - `{ all: true }` for `catalog --all`
  - `{ refresh: true }` for `catalog --refresh`
  - `{ all: true, refresh: true }` for combined flags.
  Also assert error path sets non-zero exit code when `runCatalog` rejects.

## Suggestions

None.

## What's Done Well

- `runCatalog` is cleanly dependency-injected (`CatalogDeps`), which keeps side effects explicit and makes `--refresh` dry-run behavior testable without filesystem coupling.
- The implementation preserves deterministic model ordering through explicit recency + id tie-break, matching the broader project determinism pattern.
- `--refresh` explicitly uses incremental mode and emits a human-readable diff summary including added/updated/removed/skipped/capped counts.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | `tests/commands/catalog.test.ts` covers default/all/refresh happy paths, but misses acceptance-critical stability and CLI forwarding checks. |
| Build verified | ✅ | `npm run build` passes. |
| Security checked | ✅ | No write path in `runCatalog`; refresh flow uses in-memory enrich and stdout reporting only. |
| Coverage | ⚠️ | Targeted T29 behavior coverage exists, but regression-sensitive CLI and output-contract edges are unpinned. |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Add deterministic output contract tests for catalog stable format/order | T29 follow-up before merge |
| 2 | Important | Add CLI integration tests for `catalog` flag forwarding and error path | T29 follow-up before merge |
