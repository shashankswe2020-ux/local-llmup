# Security Audit Report #30

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Production-reachable Task U2a changes after security-audit-29: default migration execution gating, dry-run source-store loading, bounded no-follow reads for metadata and logical-store artifacts, store confirmation identity capture, and prior U2a Critical/High/Medium findings
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

**Verdict: BLOCKED.** The security-audit-29 mutation finding is closed in production because the default runtime rejects every non-dry-run migration before source loading, planning, locking, or writing. Dry-run remains reachable, but its bounded-read containment check does not bind the canonical root used to derive the opened path to the root identity sampled before and after the read.

---

## Findings

### [MEDIUM-1] Root substitution can redirect a bounded dry-run read outside the approved memory root

- **Location:** `src/memory/bounded-read.ts:25-43`, `src/memory/bounded-read.ts:60-87`, `src/memory/store.ts:387-392`, `src/memory/migrate.ts:477-521`
- **Description:** `containedCanonicalPath()` samples `(dev, ino)` from `lstatSync(root)`, then independently resolves `canonicalRoot` and `canonicalPath`. It does not verify that `canonicalRoot` names the sampled root object. A local filesystem actor can replace the configured root with a symlink between the initial `lstatSync(root)` and the two `realpathSync()` calls, causing `securePath` to become an absolute path below an outside root, then restore the original root before the post-open and post-read checks. The file-descriptor checks prove that the descriptor matches that outside `securePath`, while the root checks see the restored original `(dev, ino)`; all checks pass because no checked identity links the opened canonical path to the approved root object. Metadata uses this same reader, so the gap applies to `meta.json` as well as conversation, facts, system-prompt, chunk, and vector artifacts.
- **Impact:** An unprivileged local process able to replace the user's memory-root pathname can make a dry-run consume attacker-selected store data outside the approved memory root. That breaks store provenance and can disclose the substituted conversation to the active target model when dry-run planning invokes summarization. Reads are byte- and record-bounded, so this does not create an unbounded-memory denial of service.
- **Proof of concept:** Create matching `model-slug/meta.json` and logical artifacts under an outside directory. Repeatedly rename the approved memory root aside, install `memory -> outside`, and restore the approved root while a dry-run reads the store. A successful interleaving is: (1) reader `lstat`s the approved root; (2) attacker substitutes the symlink; (3) reader resolves both canonical paths under `outside`; (4) attacker restores the approved root; (5) reader opens and validates the outside canonical file. The descriptor/file identities match, and both later root checks match the initially sampled approved root, so the outside bytes are returned.
- **Recommendation:** Bind resolution and opening to a retained no-follow root/parent descriptor using descriptor-relative traversal, and verify each directory and final file by descriptor through read completion. Do not derive the trusted open target from independent pathname `realpath` calls. If the supported Node runtime cannot provide an `openat`-equivalent abstraction, fail closed for dry-run source loading on platforms without one rather than treating before/after pathname sampling as containment. For example, the platform abstraction should expose a contract shaped like:

  ```ts
  interface SecureStoreReader {
    openRoot(path: string): TrustedDirectoryHandle;
    readUtf8(
      root: TrustedDirectoryHandle,
      segments: readonly string[],
      maxBytes: number,
    ): string | undefined;
  }
  ```

  `readUtf8()` must no-follow-open every segment relative to the preceding retained directory handle, reject non-directories/non-regular files, and compare descriptor identities before and after the bounded read. Add a deterministic substitution regression at the initial-root-identity-to-canonical-resolution boundary for metadata and one nested artifact.

---

## Positive Observations

- **Security-audit-29 MEDIUM-1 is closed for production-reachable mutation:** `createDefaultDeps()` fixes `supportsSecureMutation` to `false`, and `runMigrate()` rejects every non-dry-run migration before store capture, planning, lock acquisition, or `writeMigration()`. Neither ordinary copy nor `--move` reaches pathname rename or recursive deletion through the CLI.
- The production gate is fail-closed rather than inferred from platform names or Node versions; tests prove the writer is not called. Dry-run still performs no migration writes.
- Bounded readers enforce nonzero `O_NOFOLLOW`, regular-file descriptors, strict byte ceilings, fatal UTF-8 decoding, record ceilings, final-file identity checks, and root identity checks before and after reads. These controls close static final-file and nested-parent symlink attacks; the finding is the narrower missing identity link during canonical resolution.
- Metadata now uses the same bounded containment path as every other logical-store artifact, and confirmation capture reads metadata before and after complete source loading.
- External state, catalog records, memory metadata, JSONL records, facts, process identity, and confirmation snapshots remain schema-validated. Runtime endpoints remain loopback-only, and model-assisted summarization carries expected live process identity.
- Independent verification passed: 79 test files and 1,345 tests, type checking, repository lint, build, and `git diff --check`. Production dependencies have zero known vulnerabilities; sensitive environment files are ignored; no `.env`/`tokens.json` history or source `console.log`/`console.error` leakage was found.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| 1 | Medium | Canonical store path is not bound to the sampled approved root identity | Use descriptor-relative no-follow traversal for dry-run reads, or fail closed where that primitive is unavailable |