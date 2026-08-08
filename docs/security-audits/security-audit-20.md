# Security Audit Report #20

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** Uncommitted B16 changes versus `HEAD 82e7e51`: shared parameterized adapter contract suite (`tests/backend/adapter-contract.test.ts`), required `SpawnFn` `shell:false`, and explicit `shell:false` at all Ollama and llama.cpp process call sites. Review focused on command/argv injection, loopback-only enforcement, port-ownership trust, readiness cleanup, fail-closed integrity coverage, and future-adapter registration coverage. Relevant production boundaries in `src/backend/adapter.ts`, `src/backend/registry.ts`, `src/backend/acquire.ts`, `src/commands/up.ts`, and `src/catalog/schema.ts` were cross-checked.
> **Dependencies:** 6 known vulnerabilities from `npm audit` (2 critical, 1 high, 3 moderate), all in the Vitest/Vite dev-toolchain chain; `npm audit --omit=dev` reports 0 runtime vulnerabilities.

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 3     |
| Info     | 4     |

---

## Findings

### [LOW-1] The llama.cpp integrity contract is a mocked error-propagation test and still permits unverified weights

- **Location:** `tests/backend/adapter-contract.test.ts:186-208`, `tests/backend/adapter-contract.test.ts:286-291`, `src/backend/llamacpp.ts:451-478`, `src/catalog/schema.ts:46-58`, `src/commands/up.ts:224-228`
- **Description:** Each named llama.cpp integrity case injects an `acquire` mock that rejects unconditionally with a caller-supplied message. The case checks only that `pull()` rejects and that the mock received one request. It does not cause or assert a digest mismatch, revision mismatch, or exact-file mismatch, and it does not assert the request fields that make those checks possible. All four named cases therefore pass if `LlamaCppAdapter.pull()` forwards the wrong `repo`, `revision`, `file`, or `sha256`, provided it invokes the rejecting mock once. More importantly, the contract has no no-digest/size-floor case: `gguf.sha256` remains optional, `acquireWeight` may honestly return `digestVerified:false`, and `up` warns but proceeds to serve. This is the unresolved fail-closed gap from audits 18 and 19.
- **Impact:** A future catalog entry without a digest, or a regression that drops the digest before acquisition, can result in llama.cpp serving weights protected only by the HTTPS/pinned-revision trust path. The B16 suite would still report all named integrity clauses green, creating false assurance around a non-negotiable integrity boundary. Exploitation requires a malformed/compromised catalog or upstream and is therefore Low rather than remotely exploitable High risk.
- **Recommendation:** Require `sha256` for GGUF catalog sources and reject any self-managed pull whose result is not digest-verified. Replace the unconditional rejection cases with assertions over real `acquireWeight` behavior or a contract seam that validates the exact `AcquireRequest` before returning scenario-specific outcomes. At minimum:

  ```ts
  if (!pullResult.digestVerified && pullResult.modelPath !== undefined) {
    throw new BackendError(`refusing to serve ${model.id}: weights are not digest-verified`);
  }
  ```

  The shared contract should include a no-digest case that expects rejection and should assert exact `repo`, `revision`, `file`, and `sha256` forwarding.

### [LOW-2] llama.cpp port ownership is not bound to the requested model

- **Location:** `src/backend/llamacpp.ts:308-316`, `src/backend/llamacpp.ts:504-506`, `src/backend/llamacpp.ts:820-847`, `tests/backend/adapter-contract.test.ts:145-161`, `tests/backend/adapter-contract.test.ts:341-350`
- **Description:** The attach fingerprint accepts a llama-server when `/props` contains any one llama.cpp-shaped field. Although `/props.model_path` is available, `serve()` does not compare it with `ServeOptions.modelPath`. The contract's trusted mock happens to return `/cache/model.gguf`, the same path used by the test options, but no mismatch case exists and no assertion establishes that equality as an invariant.
- **Impact:** If a legitimate llama-server is already listening on the target port with different weights, `up` attaches and records the requested model as active even though another model is actually served. Subsequent prompts can be sent to the wrong model/server. The issue is limited to an existing loopback listener and the same-user local trust boundary, so severity is Low.
- **Recommendation:** When `modelPath` is provided and `/props` exposes `model_path`, require a canonical path match before classifying the listener as trusted; otherwise refuse the attach. Add a contract case where readiness and the llama.cpp fingerprint pass but `model_path` differs, asserting rejection, zero spawn, and no ownership claim. For example:

  ```ts
  const expected = options?.modelPath;
  if (expected !== undefined && props.model_path !== expected) return "untrusted";
  ```

  Canonicalize both paths safely before comparison if llama-server may report an equivalent resolved path.

### [LOW-3] Future-adapter registration proves name parity, not complete security-contract coverage

- **Location:** `tests/backend/adapter-contract.test.ts:120-126`, `tests/backend/adapter-contract.test.ts:212-292`, `tests/backend/adapter-contract.test.ts:296-302`, `tests/backend/adapter-contract.test.ts:304-382`
- **Description:** Registry parity is a useful tripwire: adding a default adapter without a matching `CONTRACTS` entry fails. However, the contract entry is hand-authored and `integrityCases` may be empty. Generic cases exercise only `serve()` process execution; they do not require `pull()` to use discrete argv or `shell:false`, do not require any integrity scenario based on adapter capabilities, and do not test `stop()` ownership. A future adapter can therefore be registered with a safe-looking `serve()` fixture and no pull-integrity cases while the suite remains green.
- **Impact:** A future self-managed or CLI-pull adapter could introduce shell/argv injection or fail-open weight handling without being rejected by the advertised shared contract. This is a forward-looking test-enforcement gap rather than a current production exploit, hence Low.
- **Recommendation:** Make contract capabilities explicit and structurally mandatory. Define non-empty scenario requirements per pull strategy (for example `cliPull` requires an argv capture including `shell:false`; `selfManagedPull` requires digest/revision/exact-file failure scenarios), and assert each default registry adapter has all scenarios required by its capabilities. A discriminated contract type can prevent empty coverage at compile time:

  ```ts
  type PullContract =
    | { kind: "cli"; assertSafePullSpawn(): Promise<void> }
    | { kind: "self-managed"; integrityCases: readonly [IntegrityCase, ...IntegrityCase[]] };
  ```

  Also add a generic owned-vs-attached `stop()` case or explicitly document that lifecycle ownership remains adapter-specific coverage.

---

## Info

### [INFO-1] Required `shell:false` is sound and materially strengthens the spawn seam

`SpawnFn` now requires the literal `false`, every Ollama and llama.cpp call site supplies it, and both production `defaultSpawn` implementations independently hardcode `shell:false`. This is defence in depth: a call-site omission is a type error, while the production wrapper still refuses shell execution. Current executable names are fixed production constants; user-influenced values remain discrete array elements. Ollama additionally uses an end-of-options separator for the model id, while llama.cpp rejects a leading-dash model path.

### [INFO-2] Loopback and readiness-cleanup contract cases assert meaningful side effects

The suite checks exact bind mechanisms (`OLLAMA_HOST` for Ollama and `--host 127.0.0.1` for llama.cpp), rejection before probe/spawn for `0.0.0.0`, no spawn for a foreign listener, `ownedByUs:false` for attach, and `SIGTERM` cleanup after owned readiness failure. These cases would fail if the current production adapters silently widened their bind or leaked the spawned child on readiness failure.

### [INFO-3] Registry parity is a useful immediate coverage tripwire

The ordered equality between `CONTRACTS` names and `createDefaultRegistry().all()` prevents a newly registered default adapter from silently bypassing the shared suite altogether. Finding LOW-3 concerns the completeness of the manually supplied contract entry, not the effectiveness of this name-parity check.

### [INFO-4] Dependency and repository hygiene checks

- `npm audit` reports 6 dev-toolchain advisories; `npm audit --omit=dev` reports 0 runtime vulnerabilities.
- `.gitignore` covers `.env` and `.env.*`.
- `git log --all -- '*.env' 'tokens.json'` returned no matching commits.
- No `console.log` or `console.error` calls exist in the scoped backend modules or new contract suite.
- The scoped contract test passed: 19/19 cases. The user-provided full verification remains 877 passing tests plus successful typecheck, build, and scoped lint.

---

## Positive Observations

- All changed production process calls explicitly pass `shell:false`; the `SpawnFn` literal type makes omission fail at compile time.
- The exact Ollama pull argv includes `--`, and llama.cpp model paths remain separate argv values with a leading-dash guard.
- Non-loopback refusal occurs before network probing or spawning for both adapters.
- Foreign listeners never produce `ownedByUs:true`; trusted attach handles use `pid:0` and are not claimed.
- Readiness failures tear down only the child just spawned by the adapter.
- Existing dedicated `acquireWeight` tests exercise real digest mismatch, revision mismatch, exact-file cardinality, partial cleanup, safe cache permissions, and atomic promotion. The weakness in LOW-1 is specifically that B16's shared llama.cpp cases do not prove those properties or enforce the final serve gate.

---

## Unresolved Prior Findings Relevant to This Scope

- Audit 18 LOW-1 / audit 19 LOW-1 (unverified GGUF weights may still be served) remains open and is incorporated as LOW-1 above.
- Audit 17 LOW-3 (stop checks endpoint reachability rather than a pid-to-endpoint binding) remains unchanged; B16 does not add a `stop()` ownership contract.
- Audit 18 LOW-2 (llama.cpp `chat` uses the hardcoded default endpoint without an identity check) remains unchanged and increases the consequence of incorrect attach/state, but was not modified by B16.
- Audit 17 LOW-2 (unbounded `/props` JSON body read) remains unchanged and outside the B16 patch.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                                                                  | Recommendation                                                                                                           |
| --- | -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Low      | Shared llama.cpp integrity cases are tautological and unverified weights remain servable | Require GGUF digests / reject `digestVerified:false`; exercise real failure causes and exact request forwarding          |
| 2   | Low      | llama.cpp attach identity is not bound to the requested model path                       | Compare canonical `/props.model_path` with the requested path and test mismatch refusal                                  |
| 3   | Low      | Future adapters can provide incomplete hand-authored contract entries                    | Use capability/pull-strategy-discriminated, non-empty contract requirements and cover pull execution plus stop ownership |

---

## Note on Requested Constraints

Per request:

- No source or test files were modified.
- No GitHub issues were created.
- The only workspace change made by this audit is this report.
