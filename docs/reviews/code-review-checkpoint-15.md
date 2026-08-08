# Code Review Checkpoint 15: Task B6 — route all commands through registry + `select()`

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-06
> **Scope:** Task B6 (Phase 0 of the pluggable-backends plan) — uncommitted working-tree changes only. Replaces every `new OllamaAdapter()` in `src/commands/` with a registry-injected `Deps` + `select()` resolution; narrows `BackendAdapter.name` to `BackendName`; adds a `Backend` column to `ls`. Changed files: `src/backend/adapter.ts`, `src/commands/{up,down,switch,chat,migrate,doctor,ls}.ts`, and the seven corresponding `tests/commands/*` files.
> **Test suite:** 685/685 passing (48 files); typecheck ✅; build ✅; lint ✅ on all B6 files (full `npm run lint` reports only the 2 pre-existing, unrelated `site/main.js` `no-undef` errors — out of scope, flagged in checkpoints 13–14).

---

## Verdict: ✅ APPROVE

**Overview:** A clean, mechanical refactor that satisfies every B6 acceptance criterion. All six construction sites are routed through the registry, the Ollama serving path stays byte-identical on success, the attach commands resolve the adapter from `active.backend`, and `ls` gains a state-sourced backend column without constructing an adapter. No Critical or Important findings; four low-severity Suggestions only.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. `up`'s "backend missing" error message changed shape (not byte-identical)

- **File:** `src/commands/up.ts:166-172` → `src/backend/select.ts:171-181`
- **Detail:** The removed inline check threw `BackendError("ollama is not installed. Install it with: brew install ollama")`. The new auto-detect path throws `BackendError("no installed backend can serve; install one of:\n  ollama: brew install ollama")`. Both are `BackendError` and both contain the install hint, so the failure _class_ and _actionability_ are preserved, and the updated test (`tests/commands/up.test.ts:301`, asserting `/brew install ollama/`) still passes. The removal is **safe**: the call order is preserved (`registry.available()` issues the single `isInstalled()` probe between `detect` and `pull`, so the `["detect","isInstalled","pull","serve","health","state"]` order test at `up.test.ts:210` holds), and no `pull`/`serve`/`state` occurs on failure. Worth a one-line note that the _message_ (not the happy path) intentionally changed, since the plan's "byte-identical" language is easy to over-read.
- **Severity:** Low. Message-only, covered by the message-regex test, arguably an improvement for the multi-backend future.

### 2. `up` create-path does not thread flag/env/config into `select()`

- **File:** `src/commands/up.ts:169-175`
- **Detail:** `select({ intent: "create", ... })` passes only `platform`/`arch`; `flag`, `env` (`LOCAL_LLMUP_BACKEND`), and `configBackend` are omitted, so those precedence tiers are inert on the serving path. This is consistent with B6's scope (no CLI `--backend` flag exists yet — confirmed no `--backend`/`LOCAL_LLMUP_BACKEND` references in `src/cli.ts`) and harmless in Phase 0 (only Ollama registered). Flag/env/config resolution in `select()` is currently exercised only by unit tests. Recommend tracking the wiring explicitly with the CLI-flag task so the documented env override doesn't silently no-op longer than intended.
- **Severity:** Low. Deferred wiring, no Phase-0 behavior change.

### 3. Attach commands surface the generic `unknown backend` error for a stale `active.backend`

- **File:** `src/commands/{down,switch,chat,migrate}.ts` (all call `select({ intent: "attach", activeBackend: active.backend })` → `selectAttach` → `registry.get(activeBackend)`)
- **Detail:** This is checkpoint-14 Action Item #2 ("revisit at B6"). `doctor.checkState` (`doctor.ts:164-172`) now wraps `registry.get(active.backend)` in try/catch and degrades to a `fail` check — good. The runtime attach commands do **not** get the same treatment: on a build downgrade where `state.json` still names a no-longer-registered `BackendName`, they would throw the generic `unknown backend: <name> (known: ...)` `ValidationError` rather than an attach-specific "started by a build that no longer has this backend — run `down`" message. Cannot occur in Phase 0 (single-backend registry; v1→v2 migration defaults `backend` to `ollama`), so it remains a deferred UX nicety.
- **Severity:** Low. Unreachable in Phase 0; consider addressing when the second backend lands.

### 4. `doctor.checkBackend` probes `registry.all()[0]`, not the active backend

- **File:** `src/commands/doctor.ts:221-225`
- **Detail:** The backend diagnostic checks the first registered adapter (Ollama in Phase 0), matching the previously-injected Ollama adapter, while `checkState` correctly resolves `active.backend`. The `undefined` guard for an empty registry is a nice defensive touch. In a multi-backend registry this would only ever report on the highest-priority adapter; that is the B11 "doctor backends section" concern, explicitly deferred. Fine as-is for B6.
- **Severity:** Low. Behavior-preserving for Phase 0; superseded by B11.

## What's Done Well

- **All six construction sites routed; acceptance #1 met.** `grep -R "new OllamaAdapter()" src/commands` returns nothing; `createDefaultRegistry()` is now the single injection point in every `createDefaultDeps()`.
- **Byte-identical serving path preserved.** `port = options.port ?? adapter.capabilities.defaultPort` is exactly equivalent to the old `?? DEFAULT_OLLAMA_PORT` (`OllamaAdapter.capabilities.defaultPort = DEFAULT_OLLAMA_PORT = 11434`, `ollama.ts:520`), and `state.backend = adapter.name` yields `"ollama"` — so the persisted state and the `["detect","isInstalled","pull","serve","health","state"]` call order are unchanged.
- **Lazy adapter resolution where the adapter isn't always needed.** `down` resolves the adapter only inside the `ownedByUs` branch (attached servers are forgotten without touching a backend), and `migrate` resolves it only when a summarizer is actually built (`active` matches the target and the target has an `ollama` source) — no wasted `select()` on the deterministic-truncation path.
- **The `name: string → BackendName` narrowing type-checks end-to-end with no casts.** `adapter.name` flows into `state.backend` (`z.enum(BACKEND_NAMES)`) and into `select`'s `activeBackend: BackendName`, while `registry.get(name: string)` still accepts the widened argument — a coherent, minimal ripple.
- **`ls` reads `active.backend` and constructs no adapter** (acceptance #5); the `Backend` column is inserted in a sensible position and the test asserts both the header and the `ollama` value.
- **Attach-intent routing is correct** (acceptance #3): `down`/`switch`/`chat`/`migrate` all pass `active.backend`/`current.backend` to `select({ intent: "attach" })`, and `chat`/`migrate` guard `active !== null` before resolving, so `selectAttach`'s "no active server" throw is never hit spuriously.
- Strict-TS clean: no `any`, named exports only, explicit return types, typed errors, ESM `.js` import paths. Tests updated in lockstep with the v2 state shape (`schemaVersion: STATE_SCHEMA_VERSION`, `backend: "ollama"`) and the new `capabilities` descriptor on every fake adapter.

## Verification Story

| Check            | Status | Notes                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 685/685 pass. `up.test.ts` retains the call-order (`:210`) and not-installed (`:301`) assertions; `ls.test.ts` asserts the new column; each command's fake adapter gained a `capabilities` block and each active state gained `backend`.                                                                                                            |
| Build verified   | ✅     | `npm run typecheck` and `npm run build` both clean.                                                                                                                                                                                                                                                                                                 |
| Security checked | ✅     | No new external input; `active.backend` is Zod-validated (`z.enum(BACKEND_NAMES)`); `doctor` `stripControl`s `active.backend` before printing; no network/FS/child-process reached on the advice path. Loopback-only serve (`DEFAULT_BIND_HOST`) unchanged.                                                                                         |
| Coverage         | ✅     | All routed paths exercised. Two edges remain untested (Suggestions 2–3), both unreachable in Phase 0. Acceptance #4 (port-ownership: attach or `BackendError`, never `ownedByUs:true` for a foreign process) is preserved because `up` still derives ownership solely from `adapter.serve()`'s returned `handle.ownedByUs`, which B6 did not touch. |

## Action Items

| #   | Priority   | Issue                                                                                                                           | Target                   |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Suggestion | Note that `up`'s backend-missing _message_ intentionally changed (happy path stays byte-identical)                              | docs/backlog             |
| 2   | Suggestion | Thread `flag`/`env`/`configBackend` into `up`'s create-path `select()` when the CLI `--backend` flag lands                      | backlog (CLI-flag task)  |
| 3   | Suggestion | Give the attach commands an attach-specific error for a no-longer-registered `active.backend` (carryover from checkpoint 14 #2) | backlog (second backend) |
| 4   | Suggestion | Broaden `doctor` beyond `registry.all()[0]` to report every installed backend                                                   | B11                      |
