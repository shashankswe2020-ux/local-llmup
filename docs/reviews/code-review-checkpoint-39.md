# Code Review Checkpoint 39: Task U2a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2a (final confirmation snapshot and process-identity re-review)
> **Test suite:** 1,338 tests passing (78 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The latest U2a revision passes every automated gate and correctly hardens live listener capture, migration inference, request-time listener revalidation, forced-stop identity checks, descriptor reads, canonicalization, and typed drift handling. It is not ready to ship because four claimed invariants remain unenforced: MLX/LM Studio executable approval, complete identity persistence for new attachments, exact raw facts-byte identity, and operation-specific target coherence.

---

## Critical Issues

None.

## Important Issues

### 1. Enforce the executable allowlist for every backend

- **File:** `src/tui/snapshots.ts:373`
- **Problem:** The default live-process check approves every MLX and LM Studio executable by returning `true`. Equality with an executable string loaded from mutable state is not an allowlist: forged state naming an unrelated listener executable is accepted when the observed path matches it. This weakens the supposedly authoritative process hash for two registered backends.
- **Fix:** Centralize a backend-owned executable predicate in the adapter/registry boundary and require it for all `BackendName` values. Reuse the LM Studio trusted-installation path set and define the audited MLX Python/launcher policy; reject unknown backends/executables. Add default-dependency tests proving unrelated executables are rejected for MLX and LM Studio.

### 2. Require and persist complete identity for every new attachment

- **File:** `src/commands/up.ts:436`
- **Problem:** The attached-state branch persists `pid` only for LM Studio and permits missing executable/start fields. The regression test at `tests/commands/up.test.ts:711` explicitly expects a newly attached Ollama daemon to be written without any process identity. This contradicts the U2a requirement that new attachments persist PID, executable, and start identity, and leaves later non-snapshot callers without a stable expected process tuple.
- **Fix:** After `serve()`/readiness, require `pid > 0`, `processExecutable`, and `processStartedAt` for every newly attached handle; persist all three independent of backend. Keep incomplete attached tuples readable only through the legacy-state compatibility path, not writable by `runUp()`. Replace the current test with complete-identity persistence and fail-closed missing-field cases.

### 3. Hash the actual facts-file bytes rather than decoded/re-encoded text

- **File:** `src/tui/snapshots.ts:510`
- **Problem:** `byteLength` and SHA-256 are still computed from `factsText`, not the descriptor-read bytes. `TextDecoder` strips an initial UTF-8 BOM by default; a probe showed a valid 33-byte BOM-prefixed file becoming 30 bytes with a different SHA and then parsing successfully. Therefore the identity does not bind the original raw file. The open checkpoint-38 finding remains unresolved.
- **Fix:** Return descriptor-read bytes together with fatal-decoded text (or a dedicated facts payload), compute length/SHA-256 directly from the byte buffer, and validate logical JSON from a deliberately specified decoding policy. Preserve the bytes through `SourceMemory`/`MigrationPlan` when byte-identical carry is required. Add BOM-prefixed and distinct-byte regression cases. Track with existing issue #143.

### 4. Complete operation-specific cardinality and coherence validation

- **File:** `src/tui/snapshots.ts:120`
- **Problem:** Runtime probes still accept an active owned `down` with zero targets, an active `replace_server` with only the new target, and a migration whose source and target IDs are identical. These shapes do not identify the exact lifecycle action reviewed. The open checkpoint-38 finding remains unresolved.
- **Fix:** Use a discriminated operation schema: active `down` requires exactly one target; inactive down/no-op is a separate coherent shape or bypasses destructive snapshot creation; `detach` requires exactly one target; migration requires exactly two distinct IDs; `replace_server` requires one target only with absent runtime and exactly prior/replacement IDs with active runtime. Add a rejection matrix for zero, duplicate, excess, and runtime-incoherent targets. Track with existing issue #144.

## Suggestions

None.

## What's Done Well

- Active snapshot construction requires a freshly probed live listener and binds PID, executable, start identity, ownership, backend, and loopback address into the process hash.
- Migration passes the freshly observed `expectedProcess` into model-assisted summarization.
- Ollama and llama.cpp compare expected listener identity before inference and recheck the same listener after parsing the response.
- Forced-stop escalation probes process identity immediately before `SIGKILL` and refuses PID reuse.
- Descriptor reads are capped by an actual `readSync` loop at `maxBytes + 1` and use fatal UTF-8 decoding.
- Canonicalization rejects sparse/extended arrays; typed `SnapshotComparison` and `RevalidationResult` are consumed by assertion/lock paths, with drift mapped to `ConfirmationDriftError` in commands.
- The reported real llama.cpp marker and hardened stop preserved unrelated state; automated production-path tests corroborate those identity flows.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | U2a snapshot, command, memory, Ollama, and llama.cpp tests reviewed first; 1,338/1,338 pass. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, TypeScript build, package dry-run, and `git diff --check` pass. |
| Security checked | ❌ | Two backend executable classes are not allowlisted; new attachments may discard process identity; exact facts bytes are not bound. |
| Coverage         | ⚠️ | Missing MLX/LM Studio default-allowlist, complete new-attachment identity, BOM/raw-byte, and full operation-coherence rejection tests. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Important | Enforce executable allowlists for MLX and LM Studio snapshot capture | Task U2a before ship |
| 2 | Important | Require complete PID/executable/start identity for every new attachment | Task U2a before ship |
| 3 | Important | Hash original facts bytes, including BOM policy | Task U2a before ship / issue #143 |
| 4 | Important | Enforce complete operation target cardinality and coherence | Task U2a before ship / issue #144 |
