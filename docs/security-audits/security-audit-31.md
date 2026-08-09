# Security Audit Report #31

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Final production-reachable Critical/High/Medium review of the current uncommitted Task U2a after security-audit-30: fail-closed migration mutation, memory-root canonicalization, bounded metadata and logical-store reads, descriptor/path/root identity checks, dry-run planning, and prior unresolved U2a findings
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

**Verdict: BLOCKED.** Production migration mutation is fail-closed, but security-audit-30 MEDIUM-1 remains open. The revised reader proves that the lexical root has the same identity before and after `realpathSync(root)`, but it never proves that the returned `canonicalRoot` names that identity. File resolution and opening also remain separate pathname operations, so an intermediate parent can be substituted after canonicalization. The later checks validate independently re-resolved pathnames rather than a descriptor-bound traversal.

---

## Findings

### [MEDIUM-1] Dry-run reads remain unbound to trusted root and parent descriptors

- **Location:** `src/memory/bounded-read.ts:27-54`, `src/memory/bounded-read.ts:77-120`, `src/memory/store.ts:387-392`, `src/memory/migrate.ts:481-520`, `src/commands/migrate.ts:196-200`
- **Description:** `containedCanonicalPath()` captures `rootStat`, computes `canonicalRoot = realpathSync(root)`, and then rechecks the lexical `root`. It does not `lstat`/`stat` `canonicalRoot` and compare that object's `(dev, ino)` with `rootStat`. Consequently, the first and second lexical-root checks can both observe the approved directory while the intervening `realpathSync(root)` observes an outside symlink. Independently, `realpathSync(path)` and `openSync(securePath)` are separate operations, so an intermediate store or embeddings directory can be replaced after canonicalization and followed during open; `O_NOFOLLOW` protects only the final component. The same independent sampling recurs after open and after read. Descriptor/file checks validate whichever final file was opened, not a descriptor chain from the approved root. Metadata and all logical-store artifacts share this reader.
- **Impact:** A local filesystem actor able to replace the user's memory-root pathname can redirect a production-reachable dry-run to attacker-selected, bounded store data outside the approved root. The substituted conversation can be disclosed to the active target model when overflow planning invokes summarization, and the resulting plan is accepted as approved-source data. Mutation is not reachable through default production dependencies, so this finding does not restore the prior write/delete impact.
- **Proof of concept:** Alternate `memoryDir` between the approved directory and `memoryDir -> outside` around each synchronous pathname sample: let both initial `lstatSync(root)` calls observe the approved directory, let `realpathSync(root)` and `realpathSync(path)` observe the outside symlink, restore the approved directory for each later `lstatSync(allowedRoot)`, and re-install the outside symlink for each later `realpathSync(allowedRoot)`. The opened descriptor and `lstatSync(securePath)` then agree on the outside regular file, while every separately sampled root predicate also passes. Repeating rename/symlink swaps from another local process makes this race practically attemptable; the new regression only tests a stable symlink root and cannot exercise this interleaving.
- **Recommendation:** Open and retain a no-follow root directory handle, traverse every relative component through retained no-follow directory handles, open the final regular file relative to the last trusted handle, and validate all descriptor identities through read completion. Binding the returned `canonicalRoot` to `rootStat` is necessary defense in depth but is not sufficient because an intermediate parent can still change between `realpathSync(path)` and `openSync()`. If the supported Node runtime cannot expose `openat`/`openat2`-equivalent semantics, fail closed for production dry-run before source capture, just as mutation already does. For example, introduce an explicit capability and reject the default path until a secure reader is available:

  ```ts
  if (options.dryRun === true && !deps.supportsSecureRead) {
    throw new MemoryError(
      "migration dry-run is unavailable without descriptor-relative secure reads",
    );
  }
  ```

  Add deterministic injected regressions at the initial root-identity-to-canonicalization boundary and the canonicalization-to-open intermediate-parent boundary for metadata and one nested artifact; assert that no outside bytes reach parsing or summarization.

---

## Positive Observations

- Default production dependencies set `supportsSecureMutation` to `false`, and every non-dry-run migration is rejected before source capture, planning, locking, staging, rename, or deletion. The prior mutation/deletion path is therefore not production-reachable.
- Bounded readers reject absent/zero `O_NOFOLLOW`, non-regular final descriptors, final symlinks, oversized files, invalid UTF-8, excessive JSONL records, and stable root/file substitutions. Metadata now uses the same bounded containment reader as all logical-store artifacts.
- Source, target, runtime, process, and logical-store identities are recaptured before planning and under lock; inference adapters retain exact listener/process checks around requests.
- External state, catalog data, memory metadata, logical records, backend responses, and confirmation snapshots are schema-validated. Runtime endpoints remain loopback-only.
- Independent verification passed: 79 test files and 1,346 tests, type checking, repository lint, build, package dry-run, and `git diff --check`.
- Production dependencies have zero known vulnerabilities. Sensitive environment files are ignored, no `.env`/`tokens.json` history or tracked key material was found, and the only source-tree console call reports a catalog model count and output path rather than secrets.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| 1 | Medium | Dry-run reads are not descriptor-bound from the approved root through every parent | Use descriptor-relative no-follow traversal, or fail closed for production dry-run where unavailable |
