# Code Review Checkpoint 14: Task B5 — intent-split backend selection (`select.ts`)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-06
> **Scope:** Task B5 (Phase 0 of the pluggable-backends plan) — `select()` resolving which `BackendAdapter` a serving command uses, split by command intent. Two new files only: `src/backend/select.ts`, `tests/backend/select.test.ts`.
> **Test suite:** `tests/backend/select.test.ts` 19/19 passing; typecheck ✅; build ✅; lint ✅ on the two scoped files (full `npm run lint` fails only on 2 pre-existing, unrelated `site/main.js` `no-undef` errors — out of scope).

---

## Verdict: ✅ APPROVE

**Overview:** A clean, well-documented, functional implementation that correctly satisfies every B5 acceptance criterion and every verification the task called out. Create-intent precedence (flag → env → config → auto), fail-closed attach-conflict handling, the config-fall-through obligation, the "never auto-select lmstudio" rule, and the advice-path `isInstalled()` guard are all correct and directly tested. No Critical or Important findings; three low-severity Suggestions only.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions

### 1. Attach-intent: an explicit matching flag masks a conflicting env override

- **File:** `src/backend/select.ts:104` (`const requested = flag ?? envBackend;`)
- **Problem:** In `selectAttach`, `requested = flag ?? envBackend` short-circuits on the flag. If the flag matches `activeBackend` (valid) but `LOCAL_LLMUP_BACKEND` names a _different_ backend, the env conflict is silently ignored rather than rejected. Spec §2.2 B says "a `--backend`/env value that conflicts with `active.backend` is a `ValidationError`" — treating each channel independently would honor that more literally.
- **Fix:** Validate both channels before resolving, e.g.:
  ```ts
  for (const [via, value] of [
    ["--backend", flag],
    [ENV_BACKEND_OVERRIDE, envBackend],
  ] as const) {
    if (value !== undefined && value !== activeBackend) {
      throw new ValidationError(
        `active server uses backend "${activeBackend}"; ${via} "${value}" cannot change it — stop it first`,
      );
    }
  }
  ```
- **Severity rationale:** Low. An explicit flag that matches the active backend is a strong statement of intent, so ignoring a stray env var is defensible. Worth a deliberate decision + a test either way.

### 2. Attach to a no-longer-registered active backend surfaces an opaque error

- **File:** `src/backend/select.ts:114` (`return { adapter: registry.get(activeBackend), source: "state" };`)
- **Problem:** If `state.active.backend` names a backend that is a valid `BackendName` but not registered in the current build (e.g. a downgrade where `state.json` still says `llamacpp`), `registry.get()` throws the generic `unknown backend: llamacpp (known: ...)` `ValidationError`. In the attach context this reads as a user-input error rather than an "active server was started by a build that no longer has this backend" condition.
- **Fix:** Guard with `isRegistered` and throw an attach-specific message (still `ValidationError`, or `BackendError`) that names the active backend and suggests stopping the server, e.g. `active server was started with backend "${activeBackend}", which this build no longer provides — run "llmup down" to clear it`.
- **Severity rationale:** Low. This is an edge (build downgrade with a live server) that cannot occur in Phase 0's single-backend registry; a clearer message is a UX nicety.

### 3. `autoSelect` doc/message implies model-serve filtering that B5 does not do

- **File:** `src/backend/select.ts:145-146`, `:161`
- **Problem:** The docstring ("the backends this machine could serve") and the message `no installed backend can serve` echo spec §2.2 A4 / §2.4 ("highest-priority installed backend that can **serve the target model**"), but B5 ranks purely by platform priority + installed, with no model-format compatibility check. That is correct and intentional for B5 (the plan's acceptance list omits format-filtering; per the review brief it lands later), but the wording could mislead a future reader into thinking format-filtering already happens here.
- **Fix:** Tighten the wording to "installed and auto-eligible" until format-aware selection lands (tracked with B6/B14a), or add a one-line comment noting model-format filtering is deferred.
- **Severity rationale:** Low. Documentation clarity only; behavior is correct and in scope.

## What's Done Well

- **Config fall-through obligation is handled exactly right.** `isRegistered()` (`select.ts:66`) probes `all()` without throwing and gates `registry.get(configBackend)`, so a known-but-unregistered config default (`llamacpp` in Phase 0) falls through to auto-detect instead of hitting `registry.get()`'s throw — and there's a dedicated test asserting `source === "auto"` for that case.
- **Fail-closed attach conflict** is precise: the error names the active backend, the offending channel (`--backend` vs `LOCAL_LLMUP_BACKEND`), and the requested value, with actionable "stop it first" guidance.
- **The advice-path guard is proven, not just asserted in prose.** The `fakeAdapter` double wraps `isInstalled` in `vi.fn()` and two tests assert it is never called on the flag-resolve and attach paths — matching the determinism/offline invariant.
- **`noServableBackendMessage` avoids a latent throw** by filtering through `isRegistered` before calling `registry.get(name)` for hints, so composing the failure message can never itself throw on an unregistered priority entry.
- **Blank-input normalization** (`normalizeFlag` / `readEnvBackend` trimming to `undefined`) means a blank `--backend`/env cleanly falls through on create and cannot fabricate a false conflict on attach — covered by the "ignores a blank flag" test.
- Strict-TS clean: no `any`, named exports only, explicit return types on all exported functions, typed errors from `src/errors.ts`, ESM `.js` import paths. No fabricated values.

## Verification Story

| Check            | Status | Notes                                                                                                                                                                                                                                                                                              |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 19 tests map 1:1 to the five acceptance bullets: precedence order, attach dominance + conflict (flag & env), installed-only ranking, Apple-Silicon vs default order, lmstudio-never-auto, no-installed → `BackendError` with hints, config fall-through, and two advice-path `isInstalled` guards. |
| Build verified   | ✅     | `npm run typecheck` and `npm run build` both clean.                                                                                                                                                                                                                                                |
| Security checked | ✅     | Env/flag input trimmed; unknown explicit names hard-fail via `registry.get`; fail-closed attach conflict; no network/FS/child-process reached (auto path only awaits the injected registry's `available()`).                                                                                       |
| Coverage         | ✅     | All B5 branches exercised, including the never-taken-in-Phase-0 config fall-through. Two edges (attach flag-matches-but-env-conflicts; attach to unregistered active backend) are untested — see Suggestions 1–2.                                                                                  |

## Action Items

| #   | Priority   | Issue                                                                                                                      | Target                       |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Suggestion | Attach-intent: validate `--backend` and env independently so a matching flag can't mask a conflicting env override         | backlog                      |
| 2   | Suggestion | Attach to a no-longer-registered active backend: throw an attach-specific message instead of the generic `unknown backend` | backlog (revisit at B6)      |
| 3   | Suggestion | Tighten `autoSelect` doc/message so "can serve" doesn't imply model-format filtering that B5 defers                        | backlog (revisit at B6/B14a) |
