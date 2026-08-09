# Security Audit Report #28

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Final independent audit of the current uncommitted Task U2a implementation: RFC 8785 snapshot hashing; runtime, process, and memory-store identities; operation schema coherence; pre-lock and locked revalidation; bounded no-follow reads; facts byte/presence identity; attached identity persistence; backend executable allowlists; inference listener checks; and pre-SIGKILL identity revalidation
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 2     |
| Low      | 0     |
| Info     | 0     |

---

## Findings

### [MEDIUM-1] Legacy runtime identities make inference listener checks optional

- **Location:** `src/state/state.ts:51-68`, `src/state/state.ts:122-138`, `src/commands/chat.ts:201-216`, `src/backend/llamacpp.ts:934-938`, `src/backend/llamacpp.ts:1005-1009`, `src/backend/ollama.ts:1296-1300`, `src/backend/ollama.ts:1317-1321`
- **Description:** The persisted-state schema still accepts owned Ollama/llama.cpp records without executable/start identity and accepts attached non-LM-Studio records with the entire identity tuple absent. `runChat()` conditionally omits `expectedProcess` for those records. Both adapters then explicitly treat an absent expectation as `null`, and their post-request listener checks become no-ops. Ollama performs a backend-shape/executable probe before the request, but it is not bound to the previously persisted process instance; llama.cpp sends the request without even that fallback identity probe.
- **Impact:** A stale legacy state file plus replacement of the loopback listener can send user prompts and conversation context to a different local process. For llama.cpp, any process returning the expected response shape is accepted when the identity tuple is absent. The response can also be printed and captured as if it came from the tracked runtime. Exploitation requires local ability to replace the listener after the recorded process exits, but no ability to modify the protected state file.
- **Recommendation:** Normalize legacy state before inference by capturing the live listener identity once, validating the backend executable, and requiring that exact PID/executable/start tuple before and after every chat/embed request. Prefer making `expectedProcess` mandatory whenever an explicit persisted endpoint is used. Legacy incomplete records should either be upgraded atomically under the state lock after authoritative capture or fail closed with a remediation message; do not preserve the current `undefined => skip` adapter behavior.

### [MEDIUM-2] No-follow file reads permit escape through a symlinked parent directory

- **Location:** `src/tui/snapshots.ts:557-562`, `src/memory/migrate.ts:476-510`, `src/memory/bounded-read.ts:23-25`
- **Description:** Store capture verifies only the real path of the top-level model-store directory. `loadSourceMemory()` subsequently opens `embeddings/chunks.jsonl` and `embeddings/vectors.jsonl` by joined pathname. `O_NOFOLLOW` protects only the final path component, so a symlinked `embeddings` parent is followed. A local proof created `store/embeddings -> outside/`; `loadSourceMemory()` accepted and returned the outside chunk text and vector even though the outside directory was not under `config.memoryDir`.
- **Impact:** A planted or replaced nested directory symlink can make migration hash, copy, and potentially submit files outside the configured memory root as model memory. Reads remain byte- and record-bounded, limiting denial-of-service, but store isolation and data provenance are bypassed; outside data can be copied into a target store or sent to a configured target embedder.
- **Recommendation:** Resolve and verify every artifact path against the canonical store root immediately before opening, including the `embeddings` directory, and reject symlinks in every parent component. Prefer descriptor-relative traversal (`openat`-style semantics where available) with no-follow checks on each directory and file; otherwise `lstat` each component, compare the final canonical parent to the captured store root, open with `O_NOFOLLOW`, and verify descriptor metadata. Add regressions for symlinked `embeddings`, replaced intermediate directories, and parent swaps between validation and open.

---

## Positive Observations

- RFC 8785 canonicalization rejects non-I-JSON values, lone surrogates, cycles, accessors, hidden/symbol properties, sparse/extended arrays, excessive nodes, and excessive canonical bytes; the reviewed hash inputs are strict schema projections.
- Facts identity now distinguishes absence from presence and binds fatal-decoded original text bytes by SHA-256 and byte length; present empty, BOM-prefixed, malformed, and schema-invalid facts fail closed.
- Snapshot operation cardinality, migration source/target distinction, runtime-field coherence, and store-hash applicability are enforced by a strict schema.
- New attachments require and persist PID, executable, and start identity; MLX and LM Studio executable policies now fail closed against backend-specific approved paths.
- `up`, `down`, `switch`, and `migrate` recapture authoritative state/process/store identity at the relevant pre-action and locked boundaries, and drift aborts instead of inheriting approval.
- Ollama, llama.cpp, MLX, and LM Studio have request-time process/listener checks when complete expected identity is supplied; destructive stops revalidate process identity immediately before SIGKILL.
- The prior Task U2a blockers documented in checkpoints 38 and 39—facts bytes/presence, new attached identity persistence, backend executable approval, and operation constraints—are resolved in the current implementation.
- The focused U2a suite passes 196 tests across 10 files; type checking and `git diff --check` pass. Production dependencies have zero known vulnerabilities, sensitive environment files are ignored, no `.env`/`tokens.json` history was found, and reviewed console output contains no secrets.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| 1 | Medium | Inference identity checks are optional for legacy state | Require authoritative expected process identity before and after every persisted-endpoint inference request |
| 2 | Medium | Symlinked parent escapes bounded no-follow reads | Reject symlinked/interchanged parent components and prove descriptor containment for every store artifact |
