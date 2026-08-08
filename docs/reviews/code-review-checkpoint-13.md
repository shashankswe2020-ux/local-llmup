# Code Review Checkpoint 13: Task B4 — State schema v2 (+backend) + v1→v2 normalization

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-06
> **Scope:** Task B4 (Phase 0 of the pluggable-backends plan) — bump `STATE_SCHEMA_VERSION` 1→2, add `backend` to the persisted server state, and normalize v1 state to v2 in memory before validation.
> **Test suite:** 665 tests passing (47 files), typecheck ✅, build ✅, lint ✅ on changed files (full `npm run lint` fails only on 2 pre-existing unrelated `site/main.js` errors — out of scope).

---

## Verdict: ✅ APPROVE

**Overview:** The v2 schema change and v1→v2 normalization are correct, fail-closed, and backed by a thorough migration test matrix. The two normalization transforms compose in the right order, the spread defaults `backend` only when absent, and a v2 file that legitimately lacks `backend` is correctly rejected. No Critical or blocking issues. One Important item — stale, type-incorrect `RuntimeState` fixtures left in the out-of-scope `doctor`/`chat`/`migrate` tests — should be tracked against B6/B10, which will begin consuming `active.backend`.

---

## Critical Issues

None.

## Important Issues

### 1. Stale, type-incorrect `RuntimeState` fixtures in out-of-scope command tests

- **Files:**
  - `tests/commands/migrate.test.ts:49` (`emptyState(): RuntimeState` returns `{ schemaVersion: 1, active: null }`)
  - `tests/commands/migrate.test.ts:228` (`readState: () => ({ schemaVersion: 1, active: { ... no backend } })`)
  - `tests/commands/doctor.test.ts:83` (`readState: () => ({ schemaVersion: 1, active: null })`)
  - `tests/commands/doctor.test.ts:194` and `tests/commands/doctor.test.ts:221` (`const activeState: RuntimeState = { schemaVersion: 1, active: { ... no backend } }`)
  - `tests/commands/chat.test.ts:232` (`state: { schemaVersion: 1, active: null }`)
- **Problem:** These values are annotated as (or assigned to a `() => RuntimeState` field) `RuntimeState`, but with the v2 bump `RuntimeState.schemaVersion` is now the literal `2` and `active` requires `backend`. They are therefore **type-incorrect assertions that go unchecked**: `tsconfig.json` sets `"exclude": [..., "tests"]` ([tsconfig.json](tsconfig.json#L21)), so `tsc --noEmit` never type-checks test files, and Vitest transpiles without type-checking. Tests pass only because these mocks bypass `readState`'s Zod validation and the command code does not yet read `backend`/`schemaVersion`. This is a latent trap: **B10 (`{B4,B6}`) explicitly touches `capture`/`chat`/`migrate`** and B6 routes commands through `select()`, at which point `active.backend` will be read — a fixture with no `backend` would silently yield `undefined` and mask a bug.
- **Fix:** Update the fixtures to the v2 shape, e.g.
  ```ts
  function emptyState(): RuntimeState {
    return { schemaVersion: STATE_SCHEMA_VERSION, active: null };
  }
  // and for active servers:
  active: { backend: "ollama", modelId: "small", endpoint: "http://x", pid: 1, port: 2, ownedByUs: true }
  ```
  Acceptable to defer to B6/B10 if tracked, but it should not be left silently — the annotations are now factually false.

## Suggestions

### 1. Redundant default-first spread under the `undefined` guard

- **File:** `src/state/state.ts:83`
- The block only runs when `activeRecord["backend"] === undefined`, so in `{ backend: V1_DEFAULT_BACKEND, ...activeRecord }` the trailing spread can never override the default — the guard already guarantees absence. This is correct but belt-and-suspenders. Either drop the guard (letting an existing `backend` win via `{ backend: V1_DEFAULT_BACKEND, ...activeRecord }`) or keep the guard and write the clearer `{ ...activeRecord, backend: V1_DEFAULT_BACKEND }`. Pick one intent to avoid a reader wondering which mechanism is authoritative.

### 2. Bare numeric literal for the legacy version

- **File:** `src/state/state.ts:78`
- `candidate["schemaVersion"] === 1` uses a bare `1` while the target uses the named `STATE_SCHEMA_VERSION`. A short comment or a `const V1 = 1` (mirroring `V1_DEFAULT_BACKEND`) would make the migration's "from/to" symmetry self-documenting.

### 3. Duplicated `backend: "ollama"` across both `up` branches

- **File:** `src/commands/up.ts:214`
- The owned/attached `ServerState` construction repeats `backend: "ollama"`. Minor duplication; the inline `// Phase 0 is Ollama-only; B6 will source this from select().` comment adequately signals intent, so this is optional cleanup for B6 rather than now.

## What's Done Well

- **Comprehensive migration matrix:** owned, attached, idle (`active: null`), composed legacy `pid:0`, rewrite-as-v2-on-mutation, and reject-v2-missing-backend are all covered — the composition of the two transforms is directly exercised ([tests/state/state.test.ts](tests/state/state.test.ts)).
- **Fail-closed by construction:** normalization only reshapes the object; the full `RuntimeStateSchema.safeParse` still gates every path, so malformed v1 input (non-object `active`, owned `pid:0`, `backend:null`) surfaces as a `"invalid"` `StateError` rather than being silently accepted.
- **Correct transform ordering:** v1→v2 stamps the version and defaults `backend` first, then the legacy `pid:0` strip runs on the migrated candidate, so a v1 attached daemon that used the `pid:0` sentinel round-trips cleanly to v2 without a pid.
- **Single source of truth preserved:** the schema draws `backend` from `BACKEND_NAMES` rather than a local literal, keeping registry/`select()`/config/state aligned.
- **Clear, accurate doc comment** on `normalizeLegacyRuntimeState` explaining both composed transforms and the rewrite-on-next-mutation behavior.

## Verification Story

| Check            | Status | Notes                                                                                                                          |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Tests reviewed   | ✅     | Migration matrix reviewed first; asserts each acceptance criterion incl. composed pid:0 and rewrite-on-mutation                |
| Tests run        | ✅     | 665 passing (47 files)                                                                                                         |
| Typecheck        | ✅     | `tsc --noEmit` clean (note: `tests/` excluded — see Important #1)                                                              |
| Build verified   | ✅     | `tsc` clean                                                                                                                    |
| Lint             | ✅     | Changed files exit 0 (pre-existing `site/main.js` errors out of scope)                                                         |
| Security checked | ✅     | No new external-input surface; migration is pre-validation reshape, final Zod validation fail-closed; no injection/secret risk |
| Performance      | ✅     | Trivial in-memory transforms, no new I/O                                                                                       |
| Coverage         | ⚠️     | state.ts fully covered; doctor/chat/migrate readState mocks remain at stale v1 shape (Important #1)                            |

## Action Items

| #   | Priority   | Issue                                                                                                                                          | Target  |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Important  | Update stale v1 `RuntimeState` fixtures in `doctor`/`chat`/`migrate` tests to v2 shape (add `schemaVersion: STATE_SCHEMA_VERSION` + `backend`) | B6/B10  |
| 2   | Suggestion | Resolve redundant default-first spread under the `undefined` guard in `normalizeLegacyRuntimeState`                                            | backlog |
| 3   | Suggestion | Name/annotate the legacy `=== 1` version literal for from/to symmetry                                                                          | backlog |
| 4   | Suggestion | Consider hoisting duplicated `backend: "ollama"` in `up` once `select()` lands                                                                 | B6      |
