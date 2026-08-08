# Security Audit Report #32

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Final production-reachable Critical/High/Medium review of Task U2a after security-audit-31: migration capability gating, CLI/default dependency call graph, source-store access ordering, prior migration read/mutation TOCTOU findings, and the remaining U2a boundary
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 0     |
| Info     | 0     |

**Verdict: GO.** No production-reachable Critical, High, or Medium issue remains in the reviewed U2a boundary. The security-audit-31 migration-read TOCTOU is closed by failing every production migration mode before source-store capture or access when descriptor-relative filesystem primitives are unavailable.

---

## Findings

No Critical, High, Medium, Low, or Informational findings were identified in this final audit.

The path-based migration reader and writer remain unsuitable as a production security boundary by themselves. They are not production-reachable through `runMigrate()`: the sole production CLI call supplies no dependency override, `createDefaultDeps()` fixes `supportsSecureFilesystem` to `false`, and the capability gate throws before `captureMemoryStoreIdentity()`, `loadSourceMemory()`, runtime/process capture, model-assisted planning, locking, staging, commit, or deletion. The `supportsSecureFilesystem: true` path is referenced only by injected tests to preserve internal algorithm coverage. A caller with arbitrary code execution that deliberately imports internal modules and supplies replacement dependencies is outside the CLI threat boundary and already has direct filesystem authority.

---

## Positive Observations

- **Security-audit-31 MEDIUM-1 is closed:** ordinary copy, `--move`, and `--dry-run` all encounter the same fail-closed capability gate before any source-store capture or read. Consequently, neither root substitution nor intermediate-parent substitution can expose source bytes, invoke summarization, alter a target, or delete a source through the production CLI.
- The production call graph has one `runMigrate()` call site in `src/cli.ts`; it does not pass injected dependencies. `supportsSecureFilesystem` appears in production only in the command contract, the default `false` assignment, and the pre-access gate. The only `true` assignment is in test dependency construction.
- Model arguments are resolved and collision-checked before the capability error, but those operations use the curated catalog and pure path derivation; no source memory path is opened, canonicalized, stated, read, written, or removed before rejection.
- Prior U2a findings remain closed: authoritative listener/process identity is required around persisted-endpoint inference; static nested-parent symlink escape is rejected; unsupported `O_NOFOLLOW` fails closed; and production migration mutation cannot reach pathname-based commit or recursive deletion.
- External state, catalog records, memory metadata, logical records, backend responses, and confirmation snapshots remain schema-validated and bounded. Runtime endpoints remain loopback-only.
- Independent verification passed: 79 test files and 1,346 tests, type checking, repository lint, build, package dry-run, and `git diff --check`.
- Production dependencies have zero known vulnerabilities. The six reported advisories are confined to the development toolchain. Sensitive environment files are ignored, no `.env`/`tokens.json` history or tracked key material was found, and the only reviewed console call reports catalog output metadata rather than secrets.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| —   | —        | None    | No release-blocking security action required for Task U2a |
