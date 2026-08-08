# Code Review Checkpoint 11: Task B2 — Backend Registry

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B2 of the pluggable-backends plan — `src/backend/registry.ts` + `tests/backend/registry.test.ts` (two new, uncommitted files). The single adapter construction site (`BackendRegistry` + `createDefaultRegistry`). No command code touched (that is B6).
> **Test suite:** 646 tests passing (+7), typecheck clean, build clean, eslint on the two files exits 0.

---

## Verdict: ✅ APPROVE

**Overview:** A clean, minimal, well-documented additive module that faithfully implements the spec §2.2 `BackendRegistry` contract (`all()` / `get()` / `available()`) and the plan's "single construction site" mandate. No Critical or Important findings — safe to commit.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. `all()` returns the live internal `order` reference (compile-time-only immutability)

- **File:** `src/backend/registry.ts:43-45`
- `order` is typed `readonly BackendAdapter[]`, but `readonly` is erased at runtime; `all()` (and the array `available()` derives from) hands back the same underlying array instance on every call. A caller who casts away `readonly` (`as BackendAdapter[]`) could mutate the registry's internal order. This is defensively guarded on the **input** side (the constructor spreads `[...adapters]`, so mutating the caller's original array is harmless), just not on the **output** side.
- For an internal, S-sized module consumed only by first-party command code — and with the `readonly` type actively discouraging mutation — this is acceptable as-is. If you want belt-and-suspenders immutability at zero ongoing cost, `Object.freeze` the copy once in `createRegistry` (`const order = Object.freeze([...adapters])`), which upgrades the readonly contract to a runtime guarantee without a per-call allocation. Optional; not blocking.

### 2. Doc comment forward-references `select()` before it exists

- **File:** `src/backend/registry.ts:3-4`, `21` (interface `BackendRegistry` header refers to resolving "via `select()`")
- `select()` lands in B5. The forward reference is a helpful roadmap and is clearly a future-tense description, so it reads fine — just confirm it stays accurate when B5 lands (and that `select()` is what commands ultimately call rather than `get()` directly). No change needed now.

## What's Done Well

- **Spec-faithful contract.** `all()` / `get()`→`ValidationError` / `available()` match spec §2.2 exactly, and `createDefaultRegistry()` correctly registers Ollama only for Phase 0.
- **`available()` resilience is correct and justified.** Each `isInstalled()` probe is isolated in its own `try/catch`, so one throwing backend is treated as "not installed" and cannot suppress the others — directly satisfying the plan's "cannot hide other backends" requirement. `Promise.all` preserves array position regardless of resolution timing, and the subsequent `filter().map()` preserves it too, so registration order survives end-to-end. Both properties are pinned by tests.
- **`createRegistry(adapters)` factoring is a justified addition, not scope creep.** It is the natural seam that makes `createDefaultRegistry()` a one-liner and lets the tests exercise ordering/duplication/probe behavior with a fully-typed `fakeAdapter` — no `new OllamaAdapter()` gymnastics, no casts, no `any`. The public surface the spec names (`createDefaultRegistry`) is unchanged; `createRegistry` is a thin, honest DI seam.
- **Duplicate-name rejection** closes an ambiguity `get()` would otherwise inherit, and is caught at construction (fail-fast) rather than lookup.
- **Conventions honored throughout:** named exports only, explicit return types on all exported functions, typed `ValidationError` (never error codes), no `any`, kebab-case filename. The `unknown backend` message helpfully enumerates known names.
- **Tests mirror `src/` structure**, cover the happy path, both error paths, order-stability, the installed-filter, and the throwing-probe edge case, using a fully-typed fake adapter.

## Verification Story

| Check            | Status | Notes                                                                                                                                                                              |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 7 tests cover default registration, get by name, unknown→ValidationError, duplicate→ValidationError, `all()` order, `available()` filter+order, throwing-probe isolation.          |
| Build verified   | ✅     | `npm run typecheck` clean; user-reported `npm run build` clean; full suite 646 passing (+7).                                                                                       |
| Security checked | ✅     | No new external input, no network/FS/child-process at this layer, no secrets. `available()` swallows probe errors by design (resilience), not masking a security-relevant failure. |
| Coverage         | ✅     | Both error branches and the probe-failure branch are exercised; order stability asserted.                                                                                          |

## Action Items

| #   | Priority   | Issue                                                                                      | Target             |
| --- | ---------- | ------------------------------------------------------------------------------------------ | ------------------ |
| 1   | Suggestion | `Object.freeze` the internal `order` copy to make `all()` immutability a runtime guarantee | backlog (optional) |
| 2   | Suggestion | Re-verify the `select()` doc forward-reference stays accurate when B5 lands                | task B5            |
