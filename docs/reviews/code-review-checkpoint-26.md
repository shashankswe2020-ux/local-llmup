# Code Review Checkpoint 26: Task B15 — catalog GGUF seeding + llama.cpp perf provenance

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-07
> **Scope:** Task B15 (seeded GGUF sources in catalog, seeded `efficiencyByBackend.llamacpp` + provenance, loader sanitization preservation for `gguf`/`mlx`, bootstrap GGUF injection, and regression/seed tests)
> **Test suite:** 858 tests passing (52 files), typecheck ✅, build ✅, lint ⚠️ (repo-wide lint has 2 pre-existing `site/main.js` browser-global errors; changed-file lint is clean)

---

## Verdict: ✅ APPROVE

**Overview:** The B15 implementation is internally consistent with the spec/plan intent and acceptance context: seeded GGUF records are pinned and digest-shaped, llama.cpp per-class efficiency/provenance is present across the dataset, loader sanitization now preserves `gguf`/`mlx`, and bootstrap deterministically injects the same curated GGUF map used by the shipped catalog. No correctness, architecture, security, or performance blockers were found in scope.

---

## Critical Issues

None.

## Important Issues

None.

## Minor Issues

### 1. Upstream artifact existence/digest validity is not machine-verified in tests
- **File:** `tests/catalog/seed.test.ts:69`
- **Problem:** The new seed test validates shape (40-hex revision, 64-hex sha, `.gguf` suffix) but does not verify that each `(repo, revision, file, sha256)` tuple actually exists upstream and that the digest matches the LFS pointer for that pinned revision. This leaves drift detection to manual curation.
- **Fix:** Add an opt-in maintainer script (not runtime, not default CI) that checks each seeded GGUF tuple against Hugging Face metadata and fails on mismatch; document it in the B15 playbook.

## Nits

None.

## What's Done Well

- The loader regression closes a real sanitization hole: `parseCatalog` now preserves/sanitizes `source.gguf` and `source.mlx` instead of dropping them.
- Determinism is strong: bootstrap GGUF injection plus the existing exact-reproduction test keeps `data/models.json` reproducible.
- Provenance quality is improved materially: per-class `sources.efficiencyByBackend.llamacpp` includes value, trust tier, basis bytes-per-token, and URL, matching the honesty-gate/data lineage requirements.
- B15 directly mitigates the checkpoint-25 latent concern for shipped seed data by ensuring all currently seeded GGUF entries include a SHA-256 digest.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | Reviewed B15-targeted tests first: `tests/catalog/seed.test.ts`, `tests/advisor/perf-data.test.ts`, `tests/catalog/load.test.ts`; also validated surrounding behavior coverage in `tests/catalog/bootstrap.test.ts` and backend throughput scoping tests. |
| Build verified | ✅ | `npm run build` passes. |
| Typecheck | ✅ | `npm run typecheck` passes. |
| Lint verified | ⚠️ | `npm run lint` fails on 2 pre-existing unrelated errors in `site/main.js`; changed-file lint for B15 scope passes cleanly. |
| Security checked | ✅ | No new untrusted execution paths; seeded GGUF entries are pinned by commit + SHA; sanitizer now includes new source fields. |
| Coverage | ✅ | Regression tests cover preservation of `gguf`/`mlx`; seed tests cover minimum pinned GGUF set and llamacpp scalar/provenance coverage across classes. |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Minor | Add optional maintainer verifier for seeded GGUF tuple existence + digest parity against upstream metadata | backlog |
