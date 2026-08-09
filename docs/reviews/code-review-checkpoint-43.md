# Code Review Checkpoint 43: Task U2a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2a (final production-reachable review of fail-closed migration writes, dry-run read containment, and typed `switch` drift)
> **Test suite:** 1,346 tests passing (79 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** Production migration mutation is now correctly unreachable because the default dependency set reports no descriptor-relative mutation support, and the `switch` disappearance path produces typed drift. Dry-run remains production-reachable, but its read containment is still a sequence of pathname checks rather than a descriptor-bound traversal, so issues #151 and #154 remain ship blockers.

---

## Critical Issues

None.

## Important Issues

### 1. Bind dry-run reads to the approved root descriptor or fail closed

- **File:** `src/memory/bounded-read.ts:25`
- **Problem:** `containedCanonicalPath()` samples the non-symlink root identity, resolves `canonicalRoot`, and samples the lexical root again, but it never proves that `canonicalRoot` names the sampled inode or binds later traversal to that object. The pre-read and post-read checks are also separate `lstatSync()`/`realpathSync()` pathname operations. A filesystem actor can alternate the approved root and a substituted path between those calls so identity checks observe the approved inode while canonical resolution/opening observes an outside tree; intermediate parents can likewise change after canonicalization because `O_NOFOLLOW` protects only the final component. Dry-run source loading is production-reachable and may send substituted conversation data to the active target model during summarization. The new static symlink-root test does not exercise these swap windows. This is the unresolved issue #151 and security-audit-31 MEDIUM-1, tracked specifically as issue #154.
- **Fix:** Open and retain a no-follow root directory handle, traverse every path component relative to retained directory handles, and validate directory/file descriptors through read completion. If the supported Node runtime cannot provide an `openat`-equivalent abstraction, make production dry-run fail closed rather than treating before/after pathname sampling as secure containment. Add deterministic root-swap tests at the initial identity-to-canonicalization boundary for metadata and one nested artifact.

## Suggestions

None.

## What's Done Well

- Production mutation closes issue #150: `createDefaultDeps()` fixes `supportsSecureMutation` to `false`, and non-dry-run migration rejects before source capture, planning, locking, or writing.
- Issue #152 remains closed: a disappearing active runtime builds a valid one-target current snapshot and reaches `ConfirmationDriftError` without invoking the command state writer.
- Bounded reads enforce nonzero `O_NOFOLLOW`, regular-file descriptors, byte limits, fatal UTF-8 decoding, final-file identity checks, and before/after validation. These controls materially narrow the remaining race.
- Runtime replacement, stop, and inference paths consistently use authoritative process identities and preserve loopback-only behavior.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | Reviewed bounded-read, migration, switch, snapshot, command, and backend lifecycle tests first; independently reran 1,346/1,346 tests across 79 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, package dry-run, and `git diff --check` independently pass. |
| Security checked | ❌ | Mutation is fail-closed in production, but production dry-run reads remain vulnerable to pathname TOCTOU because canonical containment is not descriptor-bound. |
| Coverage         | ⚠️ | Static substituted-root and typed-drift cases are covered; deterministic identity-to-canonicalization root substitution is not. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Bind production dry-run reads to the approved root descriptor, or fail closed | Task U2a before ship / issues #151 and #154 |
