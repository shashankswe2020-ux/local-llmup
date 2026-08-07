# Code Review Checkpoint 27: Task B16 — shared adapter contract suite

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-07
> **Scope:** Task B16 (parameterized Ollama + llama.cpp adapter contract suite, registry completeness guard, and explicit `shell:false` spawn seam enforcement)
> **Test suite:** 877 tests passing (53 files); focused contract suite 19/19; typecheck ✅; build ✅; scoped lint ✅; full lint ⚠️ (2 pre-existing `site/main.js` browser-global `no-undef` errors)

---

## Verdict: ✅ APPROVE

**Overview:** The checkpoint-27 Important finding is resolved. The llama.cpp integrity cases now assert the complete forwarded `AcquireRequest`, exercise distinct digest/revision/exact-file conditions, and align exact-file behavior with the production architecture: an exact pinned resolve URL treats HTTP 404 as zero-match, while the impossible duplicate-listing condition is guarded directly by the shared B13 helper. No Critical or Important blockers remain.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. Shared process seams remain owned by the Ollama module
- **File:** `src/backend/ollama.ts:50-82`
- `SpawnFn`, `SpawnedProcess`, and related generic seam types still live in the concrete Ollama adapter, so `LlamaCppAdapter` and the shared contract suite import generic contracts from a sibling adapter. Moving them to a neutral backend seam module would improve dependency direction, as noted in checkpoints 23 and 24. This is existing architectural debt and does not block B16's behavioral contract.

## What's Done Well

- The registry completeness assertion directly couples the contract registrations to `createDefaultRegistry().all()`, so adding a default adapter without registering its contract fails immediately.
- The lifecycle matrix is genuinely parameterized and checks the security-critical outcomes, not only rejection types: no spawn on non-loopback/foreign listeners, `ownedByUs:false` on trusted attach, and owned-child cleanup after readiness failure.
- Ollama's unusual but correct launch shape is represented honestly: `ollama serve` remains argument-less beyond the subcommand while `OLLAMA_HOST` proves the explicit loopback bind.
- Requiring `shell:false` in `SpawnFn` converts a runtime convention into a compile-time seam invariant, and every production spawn call in scope passes it explicitly.
- The llama.cpp helper asserts the complete `{ backend, repo, revision, file, sha256 }` acquisition boundary; digest and revision cases additionally pin their condition-specific fields before failure propagation.
- Exact-file coverage now reflects the real design instead of inventing a repository-listing production path: HTTP 404 models a missing exact pinned artifact, and `assertExactFileMatch()` directly guards zero/duplicate listing cardinality.
- The fake child queues its close event, allowing teardown to observe graceful exit and assert exactly `SIGTERM`; the focused contract logic now runs in 9 ms rather than roughly two seconds.
- All network, process, acquisition, sleep, and integrity boundaries in the new suite are faked; no real runtime, network endpoint, or filesystem is touched.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | Reviewed the parameterized contract suite first; all 19 cases have meaningful assertions, including complete llama.cpp acquisition forwarding and condition-specific integrity checks. |
| Focused suite | ✅ | `tests/backend/adapter-contract.test.ts`: 19/19 passing. |
| Full suite | ✅ | 877/877 passing across 53 files. |
| Typecheck | ✅ | `npm run typecheck` passes. |
| Build verified | ✅ | `npm run build` passes. |
| Lint verified | ⚠️ | Scoped ESLint for both changed sources and the new test passes. Full lint reports only the 2 known `site/main.js` browser-global errors. |
| Security checked | ✅ | Explicit loopback bind, pre-spawn non-loopback refusal, identity-gated attach, ownership-safe cleanup, discrete argv, Ollama `--` separator, and required `shell:false` were reviewed. |
| Coverage | ✅ | Every B16 clause has an asserting case; lower-level B13 acquisition tests continue to prove real digest/revision/HTTP/partial-promotion behavior. |
| Performance | ✅ | No production regression; focused contract assertions execute in 9 ms (268 ms total Vitest process duration). |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Suggestion | Relocate generic process seams from the Ollama module to a neutral backend module | immediate follow-up / backlog |
