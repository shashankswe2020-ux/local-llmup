# Security Audit Report #26

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-08
> **Scope:** Current uncommitted U1c only: `src/immutable.ts`; `src/tui/types.ts`, `src/tui/presenter.ts`, `src/tui/read-only-view-models.ts`, `src/tui/sanitize.ts`; changed read-only command/result files; and U1c tests
> **Dependencies:** 6 known vulnerabilities (`npm audit` result; 2 critical, 1 high, and 3 moderate in the out-of-scope Vitest/Vite development toolchain)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 1     |
| Low      | 0     |
| Info     | 0     |

---

## Findings

### [MEDIUM-1] Completion DTO projection preserves unknown plain fields

- **Location:** `src/tui/presenter.ts:142-188`, `src/tui/presenter.ts:406-408`
- **Description:** The completion boundary recursively sanitizes, plain-object-checks, bounds, and freezes every enumerable property, but it does not project against the command-specific `CommandViewModelMap` shape or reject unknown keys. A forged completion object can therefore retain arbitrary plain fields such as `authToken`, `configPath`, or a copied runtime-state record and deliver them to the UI. TypeScript's command-specific generic does not enforce this at runtime.
- **Impact:** A buggy or compromised controller/completion mapper can disclose unintended plain configuration, path, state, or authentication data to an independently implemented UI driver. Functions and class instances are rejected, so this does not directly transfer backend/filesystem capabilities, but the intended least-data boundary remains unenforced.
- **Proof of concept:** Return an otherwise valid `ls` completion object with an enumerable `authToken: "secret"` property. `projectUiData()` visits and sanitizes the value, keeps the unknown key, freezes the projected object, and passes it to `ui.complete()`.
- **Recommendation:** Define strict Zod schemas for every `CommandViewModelMap` member, including nested discriminated unions and bounded arrays/numbers. Parse the selected schema immediately after `buildViewModel()`, reject unknown keys with `.strict()`, then sanitize canonical display fields and deep-freeze the schema-produced plain DTO before `ui.complete()`. Add regressions for extra `adapter`, `config`, `state`, `path`, and `authToken` fields on each completion screen.

---

## Positive Observations

- Driver choice and review decisions are parsed with strict closed schemas and malformed decisions fail closed.
- Choice membership is captured before the driver call, while projected request objects and arrays are frozen, preventing membership-evidence mutation.
- Cancellation classification requires both an aborted signal and an `AbortError`; non-abort cleanup/domain failures remain failures.
- Choice/review request projection reconstructs allowlisted fields, sanitizes text, validates canonical IDs, and freezes snapshots.
- Completion projection rejects cycles, non-plain objects, functions, symbols, and other capability-bearing values; canonical and argv action data are validated without display truncation.
- Progress events, collection sizes, and aggregate input nodes are capped; progress ordering, counts, totals, units, and terminal transitions are validated.
- Read-only view-model builders sanitize terminal text, preserve canonical action IDs separately from bounded display text, and deeply freeze output.
- The UI-facing type boundary exposes no backend adapter, filesystem API, configuration object, or state-store operation.
- Scoped verification passed: 113 tests across 7 files, TypeScript type checking, and scoped ESLint.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                  | Recommendation |
| --- | -------- | ---------------------------------------- | -------------- |
| 1   | Medium   | Unknown completion DTO fields cross UI boundary | Strictly schema-project every command completion DTO before UI handoff |
