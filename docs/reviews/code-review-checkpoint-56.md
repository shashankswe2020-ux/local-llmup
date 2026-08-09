# Code Review Checkpoint 56: U3b Performance/Package Gates & Terminal Hygiene Tests

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Two new test files for U3b — `tests/tui/perf/budget-gates.test.ts` and `tests/tui/perf/terminal-smoke.test.ts`
> **Test suite:** 15/15 new tests passing, typecheck ✅, lint ✅

---

## Verdict: ✅ APPROVE

**Overview:** Both test files are well-structured, test the right contracts (package budget infrastructure, cold-start regression, production audit, terminal restoration invariants, and abort signal propagation), and align with project conventions. Minor suggestions only.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. Duplicate `npm pack` invocation in budget-gates

- **File:** `tests/tui/perf/budget-gates.test.ts:21,34`
- The first two tests each call `npm pack --dry-run --json` independently (~380ms each). A `beforeAll` hook could run it once and share the parsed result, cutting ~400ms from the test file.

### 2. Weak type assertion via `as` in budget-gates

- **File:** `tests/tui/perf/budget-gates.test.ts:27`
- `(parsed as unknown[])[0] as { size?: number; name?: string }` uses double assertion. Consider a Zod schema (the project convention for external data) or at minimum a tighter narrowing guard before accessing fields.

### 3. `npm audit` flakiness risk in CI

- **File:** `tests/tui/perf/budget-gates.test.ts:92`
- `npm audit` can fail with non-zero exit code if the registry returns vulnerabilities that are later patched upstream (advisory churn). The test currently expects 0 vulnerabilities. Consider wrapping in try/catch for audit exit code 1, or adding a skip mechanism if advisory-level flakes appear in CI.

### 4. `removeListener` no-ops lose coverage opportunity

- **File:** `tests/tui/perf/terminal-smoke.test.ts:79,99`
- `MockSignalTarget.removeListener` is a no-op. A test asserting that signal listeners are cleaned up on close (by verifying `removeListener` was called) would strengthen the "no leak" contract.

### 5. Minor: `SHOW_CURSOR`/`HIDE_CURSOR` constants duplicated from source

- **File:** `tests/tui/perf/terminal-smoke.test.ts:18-19`
- These are defined in both the test and `src/tui/session.ts`. If the source exports them, the test could import them. Low priority since escape sequences are stable.

## What's Done Well

- **Contract-first testing:** Tests verify behavioral invariants (raw mode restored, cursor shown, abort fired on signal) rather than implementation details — these survive refactors.
- **Mock design matches production interfaces:** `MockStdin`, `MockStdout`, and `MockSignalTarget` faithfully mirror the `TuiInput`/`TuiOutput`/`SignalTarget` contracts from `src/tui/session.ts`, making the tests trustworthy.
- **Integration-level budget gates are justified:** `npm pack` and `npm audit` tests are appropriately integration-level — they catch real regressions (accidental inclusion of `data/` or test fixtures in the tarball, vulnerable transitive deps) that unit tests cannot.
- **Clear separation:** The perf file tests infrastructure/gates; the terminal file tests runtime invariants. Good cohesion within each file.
- **Accessible mode coverage:** Testing that accessible mode never enters raw mode or emits cursor escapes is an important accessibility correctness property.

## Verification Story

| Check            | Status | Notes                                                                 |
| ---------------- | ------ | --------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 15 tests across 2 files; all pass in 1.66s                           |
| Build verified   | ✅     | typecheck passes, lint clean on both files                            |
| Security checked | ✅     | No secrets, no network calls, `npm audit` validates production deps   |
| Coverage         | ✅     | Covers budget infra, cold-start, audit, raw mode, cursor, and abort   |

## Action Items

| #   | Priority   | Issue                                          | Target  |
| --- | ---------- | ---------------------------------------------- | ------- |
| 1   | Suggestion | Deduplicate `npm pack` call in budget-gates    | backlog |
| 2   | Suggestion | Stronger type narrowing for npm pack output    | backlog |
| 3   | Suggestion | Guard against npm audit advisory flakiness     | backlog |
| 4   | Suggestion | Assert removeListener called on session close  | backlog |
| 5   | Suggestion | Consider exporting cursor constants from source| backlog |
