# Code Review Checkpoint 54: U2c — Cancellation/compensation model + lock/cleanup timeouts

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** U2c cancellation/compensation model (`src/tui/cancellation.ts`, `src/state/state.ts` export change, `tests/tui/cancellation.test.ts`)
> **Test suite:** 1401 tests passing (83 files), typecheck ✅, build ✅, lint ✅

---

## Verdict: ✅ APPROVE

**Overview:** Clean, well-typed cancellation/compensation vocabulary with explicit timeout constants, typed termination effects, signal-exit mappings, and exhaustive test coverage. The design correctly separates the cancellation classification concern from command execution, enabling composition without coupling.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. Consider parameterising the model ID in `classifyUpCancellation` partial case

- **File:** `src/tui/cancellation.ts:112`
- The partial remediation hardcodes `"the target model"` rather than accepting the actual model ID as a parameter. This loses specificity when the message is surfaced to users. The function signature could accept an optional `modelId` to produce a precise remediation message.

### 2. `LOCK_TIMEOUT_MS` re-export adds indirection without benefit

- **File:** `src/tui/cancellation.ts:16`
- `LOCK_TIMEOUT_MS` is simply `DEFAULT_LOCK_TIMEOUT_MS` re-assigned. This is fine for co-location, but consumers could import directly from `state.ts`. Low priority — the current approach keeps all TUI timeout constants in one module, which is a reasonable design choice.

### 3. `classifySwitchCancellation` could handle prior-server-stopped partial states

- **File:** `src/tui/cancellation.ts:137-145`
- Switch has a similar lifecycle to `up` (stop old → start new). Currently it doesn't model the partial state where the prior server was stopped but the new model failed readiness. This may be intentional if the switch command will call `classifyUpCancellation` internally, but worth documenting the boundary.

## What's Done Well

- **Exhaustive typed discriminated union** — `CommandTermination` uses literal type narrowing so TypeScript guarantees the remediation field is only present on `partial` terminations. This makes it impossible to accidentally treat a partial outcome as a success.
- **Frozen signal map** — `Object.freeze` on `SIGNAL_EXIT_CODES` prevents runtime mutation and the `as const` assertion provides readonly literal types.
- **Test structure** — 32 tests cover every constant, every classifier branch, every formatter output, and the safety invariants (bounded timeouts, non-colliding exit codes). The "Repeated Ctrl+C safety contract" describe block elegantly tests the acceptance criteria as explicit assertions.
- **Pure functions** — All classifiers and formatters are pure with no side effects, making them trivially testable and composable.
- **Explicit timeout export from state** — Changing `DEFAULT_LOCK_TIMEOUT_MS` from unexported to exported is the minimal change needed; no restructuring of the state module.

## Verification Story

| Check            | Status | Notes                                    |
| ---------------- | ------ | ---------------------------------------- |
| Tests reviewed   | ✅     | 32 tests, all branches exercised         |
| Build verified   | ✅     | `tsc` clean                              |
| Security checked | ✅     | No user input flows, pure classifiers    |
| Coverage         | ✅     | Every exported function and constant hit |
| Lint             | ✅     | ESLint clean on all 3 files              |

## Action Items

| #   | Priority   | Issue                                                          | Target  |
| --- | ---------- | -------------------------------------------------------------- | ------- |
| 1   | Suggestion | Parameterise model ID in `classifyUpCancellation` partial case | backlog |
| 2   | Suggestion | Document switch vs up partial-state boundary                   | backlog |
