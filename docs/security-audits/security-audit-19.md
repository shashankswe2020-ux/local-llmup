# Security Audit Report #19

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** B15 implementation review focused on catalog/perf seeded-data and loader hardening:
> - `data/models.json` GGUF source additions (`repo`/`revision`/`file`/`sha256`)
> - `data/perf.json` `efficiencyByBackend` + provenance additions
> - `src/catalog/load.ts` sanitizer changes preserving/sanitizing nested `gguf`/`mlx`
> - `src/catalog/bootstrap.ts` curated GGUF source injection map
> - Related tests (`tests/catalog/load.test.ts`, `tests/catalog/seed.test.ts`, `tests/catalog/bootstrap.test.ts`, `tests/advisor/perf-data.test.ts`)
> - Integrity boundary cross-check: `src/catalog/schema.ts`, `src/advisor/perf-data.ts`, `src/advisor/throughput.ts`, `src/backend/acquire.ts`, `src/commands/up.ts`
> **Dependencies:** 6 known vulnerabilities from `npm audit` (2 critical, 1 high, 3 moderate), all in dev-toolchain transitive chain (`vitest`/`vite`/`esbuild`), runtime dependencies unaffected.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| Info | 4 |

---

## Findings

### [MEDIUM-1] `efficiencyByBackend` scalars are not cryptographically or structurally bound to provenance, allowing uncited throughput numbers

- **Location:** `src/advisor/perf-data.ts:40`, `src/advisor/perf-data.ts:74`, `src/advisor/perf-data.ts:81`, `src/advisor/perf-data.ts:98`, `src/advisor/throughput.ts:55`, `src/advisor/throughput.ts:56`, `tests/advisor/perf-data.test.ts:372`
- **Description:** The dataset schema models backend efficiency numeric scalars (`efficiencyByBackend`) and provenance (`sources.efficiencyByBackend`) as separate optional fields, with no cross-field invariant requiring key parity and value parity. The estimator reads numeric scalars directly in `resolveEfficiency` and does not consult provenance.
- **Impact:** A malformed or compromised seeded perf row can produce a deterministic but uncited throughput figure, violating the honesty/integrity boundary that sourced figures should be enforced rather than conventional. This is not remote RCE, but it is a meaningful trust-model break in advice output integrity.
- **Proof of concept:** A class row containing `efficiencyByBackend: { "ollama": 0.99 }` and no matching `sources.efficiencyByBackend.ollama` parses today and is consumed by `resolveEfficiency`. Current tests explicitly accept no `efficiencyByBackend` provenance (`accepts a class with no efficiencyByBackend (fully optional)`).
- **Recommendation:** Add `superRefine` in `PerfClassSchema` to require:
  1. every key in `efficiencyByBackend` has matching key in `sources.efficiencyByBackend`, and
  2. `provenance.value === efficiencyByBackend[key]`.
  On mismatch, fail schema validation (fail-closed).

### [LOW-1] GGUF catalog digest remains optional at schema boundary; with warning-only serve path this can degrade to weaker integrity checks

- **Location:** `src/catalog/schema.ts:57`, `src/commands/up.ts:224`, `src/commands/up.ts:226`
- **Description:** `source.gguf.sha256` is optional in schema. The current `up` flow logs a warning when pull is not digest-verified and continues serving.
- **Impact:** In default B15 seed this is mitigated because shipped GGUF entries include `sha256`; however, the boundary remains permissive for future curated entries (or non-default programmatic inputs), enabling weaker integrity mode without a hard stop.
- **Recommendation:** Either make GGUF `sha256` required in schema or fail closed in `up` when `pullResult.digestVerified === false` for self-managed GGUF paths.

### [LOW-2] Static curated GGUF injection map has manual drift risk (stale pin/digest availability failure)

- **Location:** `src/catalog/bootstrap.ts:22`, `src/catalog/bootstrap.ts:205`, `src/catalog/bootstrap.ts:210`, `tests/catalog/seed.test.ts:69`, `tests/catalog/seed.test.ts:71`
- **Description:** The B15 GGUF source map is a static hand-maintained constant keyed by model id and injected during bootstrap. Tests assert presence of at least 3 GGUF rows and regex shape, but do not assert exact curated-key coverage/invariants between registry snapshot intent and map content.
- **Impact:** Stale/mistyped digest or missing map entries fail closed at pull time (good for integrity) but create availability regressions and maintenance risk. Determinism is preserved, but freshness and operational reliability depend on manual map upkeep.
- **Recommendation:** Add a bootstrap test asserting exact expected GGUF key set (or an explicit allowlist policy) and optionally periodic validation workflow for pinned artifacts.

---

## Info

### [INFO-1] No path traversal/control-character regression found in preserved `gguf`/`mlx` fields

- **Evidence:** `src/catalog/schema.ts:31`, `src/catalog/schema.ts:49`, `src/catalog/schema.ts:54`, `src/catalog/schema.ts:64`, `src/catalog/load.ts:33`, `src/catalog/load.ts:45`, `tests/catalog/load.test.ts:122`, `tests/catalog/load.test.ts:169`.
- **Notes:** `gguf.file` and revision fields are constrained at schema boundary; nested `gguf`/`mlx` strings are preserved and sanitized consistently; trusted default catalog rejects sanitize mutations.

### [INFO-2] Default seed/catalog loading is fail-closed for sanitize mutations and duplicate IDs

- **Evidence:** `src/catalog/load.ts:86`, `src/catalog/load.ts:96`, `src/catalog/load.ts:102`, `src/catalog/load.ts:114`, `tests/catalog/load.test.ts:89`, `tests/catalog/load.test.ts:169`.
- **Notes:** Parse path validates schema first, sanitizes, rejects on sanitize for trusted default path, then enforces post-sanitize unique IDs.

### [INFO-3] Seeded B15 deterministic boundaries are strong

- **Evidence:** `tests/catalog/bootstrap.test.ts:79`, `tests/catalog/bootstrap.test.ts:84`, `data/models.json:145`, `data/models.json:210`, `data/models.json:246`.
- **Notes:** Bootstrap output remains deterministic and byte-reproducible; shipped seed includes the three pinned GGUF entries with revision+digest.

### [INFO-4] Dependency and repository hygiene checks

- **Dependency advisories:** `npm audit --json` reports 6 advisories in dev-only chain (`vitest`/`vite`/`esbuild`).
- **Secrets history:** `git log --all -- '*.env' 'tokens.json'` returned no historical commits for these paths.
- **Ignore coverage:** `.gitignore` includes `.env` and `.env.*` (`.gitignore:5`, `.gitignore:6`).
- **Console leakage scan:** one bootstrap script diagnostic (`scripts/bootstrap-catalog.ts:22`), no user-secret logging pattern observed in scoped runtime modules.

---

## Positive Observations

- B15 schema constraints for GGUF/MLX sources are strict and materially reduce injection/traversal risk at the catalog boundary.
- The catalog loader applies sanitize + integrity checks in the correct order and fails closed for trusted bundled data.
- Pull path integrity defenses (pinned revision, safe URL policy, digest verification when provided) remain in place and align with fail-closed intent.
- Determinism controls are well represented in tests (`frozen clock`, exact committed catalog reproduction).

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | Uncited per-backend efficiency scalar can still drive throughput output | Add schema cross-field `superRefine` binding `efficiencyByBackend` to provenance key/value parity |
| 2 | Low | Optional GGUF digest + warning-only serve path permits weaker integrity mode | Require GGUF `sha256` or hard-fail on `digestVerified:false` in self-managed serve path |
| 3 | Low | Static GGUF map drift/staleness risk | Add exact-key coverage tests and periodic pin freshness validation workflow |

---

## Note on Requested Constraints

Per request, this audit was run as a review-only pass:
- **No source files were modified.**
- **No GitHub issues were created.**
