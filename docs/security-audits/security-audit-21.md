# Security Audit Report #21

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 8 August 2026
> **Scope:** Final review of the complete uncommitted Phase 2 hardening versus `f599805`, covering catalog coordinates and schema truth, self-managed downloads and redirect policy, cache symlink/race handling, prompt routing, attach/spawn/stop process identity, state endpoint SSRF controls, replacement lifecycle, and single-model switching. All changed production files and relevant tests were reviewed; the previously reported repository-level Critical/High/Medium findings were also cross-checked.
> **Dependencies:** 6 known vulnerabilities from `npm audit` (2 critical, 1 high, 3 moderate), all in the Vitest/Vite development toolchain; `npm audit --omit=dev` reports 0 runtime vulnerabilities.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Info | 0 |

**Risk verdict: PASS — NO OPEN CRITICAL/HIGH/MEDIUM FINDINGS.** The final Phase 2 hardening closes the previously reported lifecycle, download, routing, SSRF, catalog-artifact, and provenance-coupling findings in the reviewed scope. No release-blocking security finding remains.

---

## Findings

No Critical, High, or Medium findings remain open in the reviewed scope.

---

## Positive Observations

- Catalog GGUF coordinates now use verified upstream commit, filename, digest, and byte-size values; GGUF SHA-256 is mandatory in the schema and self-managed pulls refuse missing or unverified digests.
- Backend-specific efficiency scalars are now structurally coupled to their provenance: missing, orphaned, value-mismatched, and low-confidence provenance is rejected before throughput advice can consume it.
- Acquisition manually follows at most five redirects and re-applies HTTPS, credential, port, private-address, and Hugging Face host policy at every hop. Real curated URLs were confirmed to redirect through the permitted `us.aws.cdn.hf.co` host.
- Redirect response bodies are cancelled before the next hop. Downloads are timeout/abort bounded, stream-size bounded, digest checked before atomic promotion, and serialized by an artifact lock. Cache hits and concurrent winners are re-hashed; abandoned partials are cleaned safely; symlinked home/cache components and final entries fail closed.
- Chat and migration route through the active state endpoint. Both adapters normalize the endpoint to its loopback HTTP origin before requests, preventing path/query/fragment steering and non-loopback SSRF.
- Attach and owned-spawn flows bind HTTP identity to a stable OS listener observed before and after probing. Process identity uses canonical executable path plus process start identity, and listener matching rejects wildcard or mismatched bind addresses.
- Stop requires ownership, positive PID, recorded port ownership, expected canonical executable, optional persisted start identity, backend HTTP identity, and a stable listener re-check before signaling. Attached processes are never signaled.
- `up` performs owned lifecycle replacement under the state lock, clears stale owned state before replacement startup, and cleans up a newly created handle on readiness/persistence failure.
- `switch` refuses in-place model changes for single-model GGUF servers and directs users through `up` replacement instead; chat likewise rejects a model that differs from the active llama.cpp model.
- Verification completed with 921/921 tests passing, successful typecheck, successful build, and clean lint for all changed TypeScript files. A real llama.cpp process smoke test also passed pull, spawn, normalized-endpoint chat, model listing, PID-bound stop, and port release. Full-repository lint remains blocked only by two pre-existing browser-global errors in `site/main.js`.
- `.gitignore` covers `.env` and `.env.*`; sensitive-path history returned no commits; no `console.log` or `console.error` calls exist in changed TypeScript files.

---

## Action Items (Priority Order)

None for Critical, High, or Medium severity.

---

## Issue Tracking

Per request, no GitHub issues were created.
