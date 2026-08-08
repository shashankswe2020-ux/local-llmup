# Code Review Checkpoint 28: Phase 2 hardening re-review

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-08
> **Scope:** Phase 2 hardening (listener ownership, lifecycle/state validation, fetch policy, and cache acquisition)
> **Test suite:** 915 tests passing (54 files), typecheck ✅, build ✅, lint ⚠️ (2 pre-existing `site/main.js` browser-global errors; changed files clean)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The prior lifecycle, state, and cache blockers are substantially addressed, but four concrete production defects remain in the listener and endpoint trust boundaries. No Critical findings remain; the Important findings below should be resolved before merge.

---

## Critical Issues

None.

## Important Issues

### 1. Unrelated unowned connections invalidate the entire listener probe

- **File:** `src/backend/listener.ts:31`
- **Problem:** `NetworkConnectionsSchema.safeParse(value)` validates every system connection as requiring a positive PID and non-empty process. On Linux/BSD, `systeminformation` legitimately emits `pid: null`/empty process for connections the current user cannot inspect. One unrelated row therefore makes every listener lookup return `null`, so attach and stop fail even when the requested listener row is valid.
- **Fix:** Validate the outer value as an array of unknown rows, parse rows independently, and fail closed only for malformed or ambiguous rows that can correspond to the requested port. Add a regression containing one valid target listener plus an unrelated row with `pid: null` and empty process.

### 2. Listener verification ignores the bound address

- **File:** `src/backend/listener.ts:33`
- **Problem:** Matching uses only port and state. A daemon bound to `0.0.0.0:<port>` or `::<port>` is accepted as the owner of a supposedly loopback endpoint, allowing attach/state persistence for a server exposed to the network and violating the loopback-only invariant.
- **Fix:** Pass the normalized endpoint host into the listener probe (or return/filter socket addresses) and require the observed listener address to be the expected loopback address. Explicitly reject wildcard and non-loopback listeners; add IPv4, IPv6, wildcard, and mismatched-address regressions.

### 3. Process-name checks accept substring spoofing

- **File:** `src/backend/ollama.ts:751`
- **Problem:** `includes("ollama")` and the equivalent `includes("llama-server")` checks accept executable names such as `notollama`, `ollama-proxy`, or `evil-llama-server`. Combined with a locally spoofed HTTP identity endpoint, stale owned state can authorize signaling the wrong process after PID reuse. This does not satisfy the stated expected-process-name requirement.
- **Fix:** Normalize the platform-specific process field to an executable basename/token and compare against an explicit allow-list using exact equality (`ollama`, `llama-server`). Share the helper between attach and stop and add spoof-name regressions for both adapters.

### 4. Readiness and stop validate endpoint normalization but continue using the raw endpoint

- **File:** `src/backend/ollama.ts:872`
- **Problem:** `assertLoopbackEndpoint()` returns a normalized origin, but `waitUntilReady()` and `stop()` discard it; llama.cpp does the same. State accepts loopback URLs with paths/query/fragment, so tampered or legacy state such as `http://127.0.0.1:11434/redirect?x=1` passes schema validation and is then probed as `/redirect?x=1/v1/models` or `/redirect?x=1/api/version`. The claimed normalization is therefore not enforced in lifecycle operations.
- **Fix:** Assign the returned origin and use it for all readiness/identity probes (for example, `const endpoint = assertLoopbackEndpoint(options.endpoint)`), or transform the endpoint to its origin in the state schema. Add path/query/fragment regressions that assert requests are sent only to the normalized origin.

## Suggestions

None.

## What's Done Well

- Stop now requires recorded PID, observed listener PID, process identity, and HTTP identity before signaling.
- Repeated-`up` ownership resurrection now also requires the attached observed PID to equal the prior recorded PID.
- The state schema rejects non-loopback HTTP endpoints and endpoint/port mismatches.
- Native backend fetches use `redirect: "error"`, while acquisition redirects are manually validated before following.
- Weight acquisition now requires digests, checks real-path containment, rejects symlink components, destroys rejected response bodies, and verifies a concurrent winner before reuse.
- llama.cpp attach verifies both `model_path` and `model_alias`.

## Verification Story

| Check            | Status | Notes                                                                                                                                               |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | Listener, state, acquisition, adapter lifecycle, and command regressions reviewed first.                                                            |
| Build verified   | ✅     | `npm run build` passes.                                                                                                                             |
| Security checked | ❌     | Listener address/process matching and raw endpoint reuse leave remaining trust-boundary defects.                                                    |
| Coverage         | ⚠️     | 915 tests pass, but no valid-target-plus-unowned-row, wildcard-listener, spoofed-process-name, or endpoint-normalization request regression exists. |

## Action Items

| #   | Priority  | Issue                                                                                                  | Target            |
| --- | --------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| 1   | Important | Parse listener rows independently so unrelated unowned connections do not disable lifecycle operations | Phase 2 hardening |
| 2   | Important | Require listener address to match the expected loopback endpoint                                       | Phase 2 hardening |
| 3   | Important | Replace process-name substring checks with normalized exact executable matching                        | Phase 2 hardening |
| 4   | Important | Use normalized endpoint origins in readiness and stop probes                                           | Phase 2 hardening |
