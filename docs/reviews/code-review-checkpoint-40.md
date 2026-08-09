# Code Review Checkpoint 40: Task U2a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2a (final independent review of confirmation snapshots, exact identities, bounded memory reads, lock-time revalidation, and guarded backend lifecycle behavior)
> **Test suite:** 1,338 tests passing (78 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The four checkpoint-39 blockers are remediated: MLX/LM Studio executable policy is fail-closed, new attachments persist complete identity, BOM-preserving fatal UTF-8 reads bind the original valid UTF-8 facts bytes, and operation cardinality/coherence is enforced. Three security gaps remain in legacy inference identity and no-follow store containment, so U2a is not yet ready to ship.

---

## Critical Issues

None.

## Important Issues

### 1. Require exact process identity for legacy-state inference

- **File:** `src/commands/chat.ts:195`
- **Problem:** `runChat()` supplies `expectedProcess` only when all three persisted fields exist. The compatibility schema still accepts owned Ollama/llama.cpp state and attached non-LM-Studio state without that tuple (`src/state/state.ts:45-68`, `src/state/state.ts:119-138`). In that case llama.cpp's new guard returns `null` and skips both listener checks (`src/backend/llamacpp.ts:1005-1038`); Ollama performs a current backend probe but does not bind it to the persisted process instance (`src/backend/ollama.ts:1296-1349`). A replaced loopback listener can therefore receive prompts and provide accepted responses under valid legacy state.
- **Fix:** Before every persisted-endpoint inference, capture and backend-validate a live PID/executable/start tuple and require it before and after the request. Atomically upgrade legacy state under the product lock or fail closed with remediation; do not interpret missing `expectedProcess` as permission to skip instance identity. Track with issue #147.

### 2. Reject symlinked parent directories for every logical-store artifact

- **File:** `src/memory/migrate.ts:488`
- **Problem:** `O_NOFOLLOW` protects only the final opened component. `loadSourceMemory()` opens `embeddings/chunks.jsonl` and `embeddings/vectors.jsonl` beneath a joined `embeddings` path, while the only containment check validates the top-level store earlier (`src/tui/snapshots.ts:557-563`). A symlinked or swapped `embeddings` directory is followed, allowing bounded outside-root data to be hashed, migrated, or submitted to an embedder.
- **Fix:** Reject links in every parent component and prove each opened descriptor remains beneath the canonical store root. Prefer descriptor-relative no-follow traversal; otherwise validate each component and descriptor with a race-resistant platform abstraction. Add symlinked-parent and parent-swap regressions. Track with issue #148.

### 3. Fail closed when the platform cannot provide `O_NOFOLLOW`

- **File:** `src/memory/bounded-read.ts:11`
- **Problem:** The helper substitutes `0` when `constants.O_NOFOLLOW` is unavailable, then opens the path normally at line 22. On such platforms, including Windows, an attacker-controlled logical-store symlink/reparse point is followed instead of rejected. The only symlink regression is explicitly skipped on Windows at `tests/commands/migrate.test.ts:447`, so the advertised descriptor-safe/no-follow boundary silently becomes follow-enabled there.
- **Fix:** Never degrade to a zero flag. Add a platform-safe fail-closed fallback that verifies the opened descriptor and path identify the same non-link file without a race (or declare unsupported platforms and reject the operation), and run a platform-independent injected regression proving the unavailable-`O_NOFOLLOW` branch cannot read a link target. Track with issue #149.

## Suggestions

None.

## What's Done Well

- RFC 8785 canonicalization rejects non-I-JSON values, hidden/accessor properties, sparse/extended arrays, cycles, and oversized inputs before hashing.
- Live runtime snapshots bind backend, loopback listener, PID, executable, start identity, and ownership; command paths recapture under lock and adapters revalidate before inference or signals.
- Checkpoint-39 remediation is substantive: MLX is restricted to the resolved `python3` executable, LM Studio to trusted installation paths, and newly attached handles cannot be persisted without all three process-identity fields.
- Fatal UTF-8 decoding with `ignoreBOM: true` preserves a UTF-8 BOM in `factsText`, making decode/re-encode byte-exact for accepted valid UTF-8 while rejecting invalid encodings and present invalid/empty facts JSON.
- Migration captures source, target, runtime, and process identity before planning and again under the commit lock; `--yes` shares the same exact-drift behavior.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | U2a snapshot, command, memory, and backend lifecycle tests reviewed first; 1,338/1,338 pass. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, package dry-run, and `git diff --check` pass. |
| Security checked | ❌ | Legacy state can bypass exact inference identity; parent links and unavailable `O_NOFOLLOW` can bypass store containment. |
| Coverage         | ⚠️ | Missing legacy-inference replacement, symlinked-parent, parent-swap, and unavailable-flag fail-closed regressions. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Require exact live identity for every persisted-endpoint inference | Task U2a before ship / issue #147 |
| 2 | Important | Reject symlinked or swapped parent directories in logical-store reads | Task U2a before ship / issue #148 |
| 3 | Important | Make bounded logical-store reads fail closed without `O_NOFOLLOW` | Task U2a before ship / issue #149 |