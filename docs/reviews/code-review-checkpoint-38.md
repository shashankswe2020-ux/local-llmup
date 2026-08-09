# Code Review Checkpoint 38: Task U2a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2a (confirmation snapshot hashing, authoritative live process identity, bounded memory-store reads, and locked revalidation)
> **Test suite:** 1,335 tests passing (78 files), typecheck ✅, build ✅, lint ✅; focused U2a suite 198 tests passing (10 files)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The fixes correctly require live listener identity for active runtime snapshots, pass lock-time identity into destructive stops, recapture runtime/store state at the required boundaries, and expose typed unchanged/drift results. U2a is not ready to ship because facts identity does not hash the original raw file bytes or reject a present empty file, and the exported snapshot schema still accepts operation/target combinations that cannot represent a valid lifecycle action.

---

## Critical Issues

None.

## Important Issues

### 1. Hash original facts bytes and reject present non-JSON facts

- **File:** `src/tui/snapshots.ts:445`
- **Problem:** `loadSourceMemory()` decodes `facts.json` with `Buffer.toString("utf8")`, after which `hashMemoryStoreIdentity()` computes `byteLength` and SHA-256 from the decoded string. Invalid UTF-8 bytes are replaced with U+FFFD, so distinct raw files can produce the same purported raw identity; a probe confirmed a 51-byte file was accepted and represented as 53 re-encoded bytes. `parseFacts("")` also returns an empty logical object regardless of `factsPresent`, so a present zero-byte `facts.json` is accepted instead of failing strict JSON validation. This violates the required presence/raw-SHA/raw-length plus strict-logical-JSON identity contract and can miss byte-level drift.
- **Fix:** Preserve the descriptor-read `Buffer` (or return both bytes and fatal UTF-8 text), compute length/SHA-256 directly over those bytes, decode with a fatal UTF-8 decoder, and parse strict JSON whenever `factsPresent === true`. Permit the synthetic empty logical value only when the file is absent, and reject inconsistent `factsPresent`/payload combinations. Add regressions for present zero-byte facts and two distinct invalid UTF-8 byte sequences that currently normalize to the same decoded text.

### 2. Enforce complete operation-specific target cardinality

- **File:** `src/tui/snapshots.ts:116`
- **Problem:** The schema refines ownership for `down`/`detach` and requires two IDs for migrations, but `down`, `detach`, and `replace_server` retain the generic 0–4 target allowance. A runtime probe confirmed that `replace_server` with no runtime and zero target IDs is accepted. Active `down`/`detach` snapshots can likewise carry zero or multiple targets. These malformed values are accepted by the exported creation/revalidation framework even though they cannot describe the exact lifecycle target being approved.
- **Fix:** Define each operation as a discriminated schema: active `down`/`detach` require exactly one canonical target; `migrate`/`migrate_move` require exactly two distinct source/target IDs; `replace_server` requires one target when no prior runtime exists and exactly `[prior, replacement]` when replacing an active runtime. Handle inactive `down` as a command no-op before creating a destructive snapshot, or introduce an explicit non-destructive no-op shape outside `ConfirmationSnapshot`. Add rejection tests for zero, duplicate, and excess IDs per operation.

## Suggestions

None.

## What's Done Well

- Active command snapshots now fail closed unless a live listener supplies a PID, canonical executable, and process-start identity; prepared and lock-time hashes are based on that observed identity.
- `down` and replacement `up` pass the lock-time observed executable/start identity into `stop()`, while `switch` and `migrate` recapture live process identity at their revalidation boundaries.
- Ollama and llama.cpp re-probe the exact PID/executable/start tuple before SIGKILL escalation.
- Descriptor reads are bounded with `readSync` to `maxBytes + 1`, sparse/extended arrays are rejected by canonicalization, and RFC 8785 hash vectors pass.
- `revalidateConfirmationSnapshot()` exposes the typed `SnapshotComparison`; assertion and locked execution paths consume it, and plain commands map drift to `ConfirmationDriftError`.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | U2a snapshot, command, backend lifecycle, memory, and compatibility tests reviewed first; full suite passes 1,335/1,335 and focused suite passes 198/198. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, and `git diff --check` pass. |
| Security checked | ❌ | Raw facts bytes can normalize before hashing, weakening exact store-drift identity. |
| Coverage         | ⚠️ | Missing invalid-UTF-8/present-empty facts regressions and complete per-operation target-cardinality rejection tests. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Hash original facts bytes and require strict JSON for every present facts file | Task U2a before ship |
| 2 | Important | Enforce complete operation-specific target cardinality | Task U2a before ship |