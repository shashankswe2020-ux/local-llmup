# Security Audit Report #29

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Re-audit of the current uncommitted Task U2a implementation after security-audit-28 remediation: legacy inference identity, canonical confirmation/runtime/store identities, bounded no-follow memory reads, nested-store containment, migration staging/commit/move, lock-time revalidation, PID/listener identity, and guarded lifecycle signals
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 1     |
| Low      | 0     |
| Info     | 0     |

**Verdict: BLOCKED.** One Medium containment/TOCTOU finding remains in the U2a security boundary. The three findings targeted by security-audit-28 remediation are closed, but `--move` can still be redirected outside the approved memory root after locked revalidation.

---

## Findings

### [MEDIUM-1] Memory-root substitution can redirect migration commit and recursive source deletion

- **Location:** `src/tui/snapshots.ts:564-568`, `src/tui/snapshots.ts:602-621`, `src/memory/bounded-read.ts:21-28`, `src/memory/migrate.ts:701-715`, `src/memory/migrate.ts:792-799`
- **Description:** Store capture proves canonical containment while reading, but retains only path strings and hashes; it does not retain a descriptor or device/inode identity for the configured memory root, source parent, or target parent. The locked migration then calls `writeMigration()` with the original lexical `sourceDir` and `targetDir`. `commitStaged()` renames by pathname, and `--move` later calls recursive `rmSync(sourceDir)` by pathname without recanonicalizing or checking the captured root identity. A local process can rename the approved `memoryDir` and replace it with a symlink after verification/commit but before source deletion. The lexical source path then resolves beneath an attacker-selected outside directory.
- **Impact:** A local attacker able to replace path components can redirect migration writes or make `--move` recursively delete an outside directory whose final component matches the source store slug. This violates the approved source/target identity and containment boundary and can destroy unrelated user data. The product lock does not protect against filesystem actors that do not honor it.
- **Proof of concept:** A disposable built-code proof created `memory/source`, `outside/source/DO-NOT-DELETE`, and migrated to `memory/target` with `move: true`. In the post-swap verification callback it renamed `memory` to `memory-approved` and installed `memory -> outside`. `writeMigration()` completed successfully; the observed result was `{"swapped":true,"victimExistsAfter":false,"approvedSourceStillExists":true}`. The approved source survived under the renamed original root while the outside victim directory was recursively deleted.
- **Recommendation:** Bind commit and deletion to stable filesystem objects rather than re-resolving approved path strings. Open and retain no-follow descriptors for the canonical memory root and store parents, verify their `(dev, ino)` identities under the product lock, and perform rename/delete with descriptor-relative no-follow operations (`renameat`/`unlinkat` semantics). If the runtime cannot provide those primitives, fail closed for `--move` rather than calling recursive `rmSync()` on a path. As an immediate defense-in-depth check, reject symlinked parent components and compare root/source/target `(dev, ino)` immediately before and after each rename, but do not treat check-then-path-operation as a complete TOCTOU fix. Add a deterministic regression that substitutes `memoryDir` after target verification and proves no outside path is written or removed.

---

## Positive Observations

- **Security-audit-28 MEDIUM-1 is closed:** `runChat()` now always captures authoritative live listener identity before inference (`src/commands/chat.ts:149`) and always supplies the resulting exact PID/executable/start tuple (`src/commands/chat.ts:211`). Ollama and llama.cpp reject mismatched expected listener identity before requests and verify the listener again afterward. The legacy-state regression is present at `tests/commands/chat.test.ts:193`.
- **Security-audit-28 MEDIUM-2's direct exploit is closed:** every logical-store artifact read supplies the store as `allowedRoot`; canonical path containment rejects a symlinked `embeddings` parent that resolves outside the store. The regression at `tests/commands/migrate.test.ts:460` passes. The remaining finding is a later parent-substitution race, not the prior static parent-symlink bypass.
- **Checkpoint-40 unsupported-`O_NOFOLLOW` gap is closed:** `requireNoFollowFlag()` rejects missing or zero support, and `readBoundedUtf8File()` invokes it before opening. The platform-independent regression at `tests/memory/bounded-read.test.ts:6` passes.
- Confirmation snapshots strictly bind operation cardinality, canonical model IDs, state revision, live process identity, and complete source/target logical-store hashes. Runtime changes and store-content changes fail closed at pre-materialization and locked commit revalidation.
- Listener identity includes PID, canonical executable, and start identity; inference checks before and after requests detect ordinary PID reuse or listener substitution. Owned stops reject non-positive PIDs, require listener/backend identity, and revalidate process identity before SIGKILL.
- External state, catalog-derived targets, backend responses, and logical-store records are schema-validated and bounded. Runtime endpoints remain loopback-only.
- Verification passed: 79 test files and 1,341 tests, TypeScript type checking, repository lint, build, and `git diff --check`. Production dependencies have zero known vulnerabilities; sensitive environment files are ignored; no `.env`/`tokens.json` history or source `console.log`/`console.error` leakage was found.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| 1 | Medium | Path-based migration commit/delete can escape after memory-root substitution | Bind mutations to stable no-follow directory descriptors, or fail closed for `--move` where secure descriptor-relative deletion is unavailable |
