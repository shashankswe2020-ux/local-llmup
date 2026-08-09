# Code Review Checkpoint 42: Task U2a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2a (checkpoint-41 follow-up for filesystem identity guards, bounded-read identity checks including metadata, and typed `switch` drift)
> **Test suite:** 1,344 tests passing (79 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** Finding #152 is resolved: an active server disappearing during `switch` now produces typed `ConfirmationDriftError` before any command state write. Findings #150 and #151 remain open because the new identity checks are still check-then-pathname operations; they narrow and detect many substitution windows but do not bind the subsequent rename/delete or read to trusted directory descriptors.

---

## Critical Issues

None.

## Important Issues

### 1. Bind migration commit and `--move` deletion to stable filesystem objects

- **File:** `src/memory/migrate.ts:844`
- **Problem:** Finding #150 is not resolved. `captureMigrationPathGuard()` records the memory-root and source `(dev, ino)` values, and `writeMigration()` checks them before commit and immediately before deletion. The commit still performs pathname-based `renameSync()`/`rmSync()` operations, and source deletion still calls `rmSync(params.sourceDir, { recursive: true, force: true })` after the final check. A filesystem actor can substitute the root or source in the check-to-use interval; the product lock does not serialize that actor. The new regression swaps the root inside verification, before the final guard, so it proves detection for that specific timing but not the vulnerable interval after the final guard or between the pre-commit guard and rename.
- **Fix:** Perform commit and removal relative to retained, no-follow directory descriptors using `renameat`/`unlinkat`-equivalent primitives and verify descriptor identities. If the supported Node/runtime surface cannot provide those semantics, fail closed for `--move` rather than recursively deleting a re-resolved pathname. Add deterministic injected regressions at the final guard-to-delete and pre-commit guard-to-rename boundaries.

### 2. Bind bounded reads to every approved parent component through completion

- **File:** `src/memory/bounded-read.ts:42`
- **Problem:** Finding #151 is not resolved. Passing `allowedRoot` through `readMemoryMeta()` closes the prior metadata omission, and comparing the opened file descriptor with `lstatSync(securePath)` plus the root `(dev, ino)` detects final-file and root changes at that instant. However, `containedCanonicalPath()` still returns a pathname that is opened later, `O_NOFOLLOW` protects only the final component, intermediate store/embedding directories are not descriptor-bound, and there is no post-read identity/containment revalidation. A parent can therefore be replaced after `realpathSync()` and before `openSync()` (or swapped back around the checks), allowing the descriptor to refer outside the approved store while the root and final-file checks appear consistent.
- **Fix:** Traverse from a retained canonical root descriptor with no-follow, descriptor-relative opens for every component, or introduce a platform abstraction with equivalent guarantees and before/after component plus descriptor identity verification. Keep metadata on the same path. Add deterministic parent-swap regressions for metadata and data artifacts that inject the swap between canonicalization and open and verify that no outside bytes are returned.

## Suggestions

None.

## What's Done Well

- Finding #152 is closed correctly: absent runtime state now builds a valid one-target current snapshot, allowing `assertConfirmationUnchanged()` to throw `ConfirmationDriftError`; the regression also proves the command does not call its state writer.
- Metadata reads now receive the configured memory root, closing the direct uncontained-metadata path from checkpoint 41.
- The new root/source `(dev, ino)` guards reject stable substitutions and the reproduced verification-time root swap while preserving the outside victim.
- All verification gates pass independently: 1,344 tests, typecheck, repository lint, build, package dry-run, and diff check.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | Reviewed the new migration root-substitution, metadata containment, bounded-read, and typed `switch` disappearance regressions first; independently reran 1,344/1,344 tests across 79 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, package dry-run, and `git diff --check` independently pass. |
| Security checked | ❌ | Static/root-swap detection improved, but migration mutation/deletion and bounded reads remain pathname TOCTOU operations. |
| Coverage         | ⚠️ | The new tests cover stable substitutions and one verification-time swap, but not the final check-to-use windows or a canonicalization-to-open parent swap. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Bind migration commit and recursive deletion to stable filesystem objects | Task U2a before ship / issue #150 |
| 2 | Important | Bind every bounded source-store read to trusted parent descriptors through completion | Task U2a before ship / issue #151 |
