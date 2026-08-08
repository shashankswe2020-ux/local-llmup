# Code Review Checkpoint 10: Task 30 (CI + catalog refresh workflow)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** Task 30 — `.github/workflows/ci.yml`, `.github/workflows/catalog-refresh.yml`, `scripts/catalog-refresh-dry-run.ts`, `tests/workflows/workflow-policy.test.ts`, and `package.json` wiring for dry-run script.
> **Test suite:** 454 tests passing (37 files), typecheck clean, build clean, lint clean.

---

## Verdict: ✅ APPROVE

**Overview:** The T30 implementation satisfies the stated acceptance criteria: CI runs lint/typecheck/test/build plus a coverage gate, thresholds enforce the required per-path and overall minimums, and the catalog-refresh workflow is scheduled + manually runnable with SHA-pinned actions, minimal top-level permissions, incremental dry-run execution, and zero-write assertions. Prior checkpoint 9 action items are also addressed by new deterministic catalog-output tests and catalog CLI wiring tests.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. Remove duplicate test execution in CI to reduce runtime

- **File:** `.github/workflows/ci.yml:37`
- CI currently runs `npm test` and then `npm run test:cov`, where the latter already executes the full test suite. This doubles test runtime without adding signal.
- **Recommendation:** Keep `npm run test:cov` as the single test step (it enforces thresholds and executes tests), or split fast/slow jobs intentionally if duplication is desired for a reason.

### 2. Add policy coverage for CI workflow permissions drift

- **File:** `tests/workflows/workflow-policy.test.ts:78`
- The workflow-policy test enforces strict permissions for `catalog-refresh.yml`, but does not assert the same minimal permission contract for `ci.yml`.
- **Recommendation:** Add a test assertion that top-level `permissions` in `ci.yml` stays `{ contents: "read" }` to prevent future privilege creep.

## What's Done Well

- Acceptance criteria are encoded as tests, not only as workflow YAML, which meaningfully reduces regression risk.
- `catalog-refresh-dry-run.ts` provides an in-script zero-write guard (`before/after` file-content equality) in addition to the workflow-level `git diff --exit-code` assertion.
- Both workflows pin `uses:` references to full commit SHAs, aligning with hardening requirements.
- T29 follow-up gaps were closed: `tests/commands/catalog.test.ts` now checks deterministic order/header, and `tests/cli-catalog.test.ts` verifies flag forwarding and failure behavior.

## Verification Story

| Check            | Status | Notes                                                                                                       |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | Reviewed `tests/workflows/workflow-policy.test.ts` and related CLI/catalog tests touching prior open items. |
| Build verified   | ✅     | `npm run build` passes locally.                                                                             |
| Security checked | ✅     | Minimal permissions + SHA-pinned actions + no push command in refresh workflow verified.                    |
| Coverage         | ✅     | `vitest.config.ts` thresholds match T30 policy and CI invokes `npm run test:cov`.                           |

## Action Items

| #   | Priority   | Issue                                                                 | Target  |
| --- | ---------- | --------------------------------------------------------------------- | ------- |
| 1   | Suggestion | Eliminate redundant `npm test` + `npm run test:cov` duplication in CI | backlog |
| 2   | Suggestion | Extend workflow-policy tests to lock `ci.yml` top-level permissions   | backlog |
