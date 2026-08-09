# Code Review Checkpoint 41: Task U2a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2a (checkpoint-40 remediation and full confirmation-snapshot, process-identity, bounded-read, and locked-revalidation re-review)
> **Test suite:** 1,341 tests passing (79 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** Issues #147, #148, and #149 are closed for their reported cases: chat always captures live identity, stable nested parent symlinks are rejected by per-artifact canonical containment, and unavailable/zero `O_NOFOLLOW` fails closed. U2a is still blocked by a later memory-root substitution that can redirect `--move` deletion (issue #150), the descriptor/path race underlying source-store reads, and one typed-drift defect in `switch`.

---

## Critical Issues

None.

## Important Issues

### 1. Bind migration commit and `--move` deletion to the approved memory root

- **File:** `src/memory/migrate.ts:798`
- **Problem:** Locked revalidation hashes the approved logical stores, but `writeMigration()` later commits and recursively deletes through the original lexical `targetDir`/`sourceDir`. A filesystem actor can rename `memoryDir` and replace it with a symlink after verification; `rmSync(params.sourceDir, { recursive: true, force: true })` then follows the substituted root and can delete an outside same-slug directory. Security audit 29 reproduced this: the approved source survived under the renamed root while the outside victim was removed. The product lock cannot serialize actors that do not honor it. Tracked by issue #150.
- **Fix:** Bind commit/deletion to stable no-follow directory descriptors and perform descriptor-relative rename/unlink operations. If the runtime cannot provide those primitives, fail closed for `--move`; do not recursively remove a re-resolved pathname. Add the deterministic root-substitution regression from security audit 29.

### 2. Complete descriptor-bound containment for source-store reads

- **File:** `src/memory/bounded-read.ts:21`
- **Problem:** Issue #148's stable symlinked-parent exploit is closed: each migration data artifact passes `allowedRoot` and the new regression rejects `embeddings -> outside`. However, `containedCanonicalPath()` returns a pathname that `readBoundedUtf8File()` opens later at line 47. A parent can be replaced between `realpathSync()` and `openSync()`; `O_NOFOLLOW` protects only the final component, and `fstatSync()` proves regular-file type, not descriptor containment. `readMemoryMeta()` also calls the helper without `allowedRoot` (`src/memory/store.ts:387-390`). This is a follow-on TOCTOU, not a reopening of #148's reported static bypass.
- **Fix:** Bind validation to the opened object with descriptor-relative no-follow traversal, or a platform abstraction that verifies component and descriptor identities before and after the read. Pass the canonical store root through metadata reads and add deterministic metadata-containment and parent-swap regressions. Tracked by issue #151.

### 3. Return typed confirmation drift when the active server disappears during `switch`

- **File:** `src/commands/switch.ts:131`
- **Problem:** When the active server disappears before lock acquisition, `currentSnapshot` is built with two canonical target IDs (`[current.modelId, target.id]`) while runtime identity is absent. `createRuntimeConfirmationSnapshot()` therefore rejects the snapshot because `replace_server` permits one target when no runtime is present, before `assertConfirmationUnchanged()` can produce `ConfirmationDriftError`. This violates U2a's typed “return to fresh review” drift contract and makes the explicit `active === null` handling at lines 143-145 unreachable on this race. No test covers the disappearance case.
- **Fix:** Build the absent-runtime current snapshot with `[target.id]`, then let `assertConfirmationUnchanged()` return `ConfirmationDriftError`; add a regression that removes active state inside `withLock` and asserts typed drift with no state write. Tracked by issue #152.

## Suggestions

None.

## What's Done Well

- **Issue #147 closed:** `runChat()` unconditionally captures authoritative live identity at `src/commands/chat.ts:149` and always passes it as `expectedProcess` at line 211. Ollama and llama.cpp verify the expected listener before inference and compare it again after the response (`src/backend/ollama.ts:1148-1196`, `src/backend/llamacpp.ts:934-987`). The regression at `tests/commands/chat.test.ts:193-209` exercises readable legacy state with missing persisted executable/start fields.
- **Issue #148 closed:** every migration data artifact is canonicalized against the store root before opening, and the regression at `tests/commands/migrate.test.ts:460-478` rejects a stable symlinked `embeddings` parent that resolves outside it. The remaining read race is a follow-on swap after that check.
- **Issue #149 closed:** `requireNoFollowFlag()` rejects non-numeric, absent, and zero values before `openSync()` (`src/memory/bounded-read.ts:14-17`, `src/memory/bounded-read.ts:47`). The platform-independent regression directly exercises `undefined` and `0` at `tests/memory/bounded-read.test.ts:6-9`.
- Logical source data is byte/record bounded and UTF-8 decoding is fatal.
- Snapshot hashing, operation cardinality, pre-materialization recapture, lock-time recapture, process executable policy, and pre-SIGKILL identity checks remain strong and well covered.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | U2a command, backend, memory, snapshot, and compatibility tests reviewed first; independently rerun 1,341/1,341 across 79 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, package dry-run, and `git diff --check` independently pass. |
| Security checked | ❌ | #147–#149 are closed for their reported cases, but issue #150 can redirect migration mutation/deletion, and source reads remain check-then-open. |
| Coverage         | ⚠️ | Missing memory-root substitution, read parent-swap/metadata-containment, and `switch` active-disappearance typed-drift coverage. The reported rebuilt real llama.cpp chat smoke passed, but was not rerun during this review. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Bind migration commit and recursive deletion to the approved memory root | Task U2a before ship / issue #150 |
| 2 | Important | Bind every source-store read descriptor to its canonical store root | Task U2a before ship / issue #151 |
| 3 | Important | Preserve typed drift when active state disappears during `switch` | Task U2a before ship / issue #152 |
