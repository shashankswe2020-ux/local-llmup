# Security Audit Report #8

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B5 — "Backend selection." Two new files only:
> [src/backend/select.ts](../../src/backend/select.ts) and
> [tests/backend/select.test.ts](../../tests/backend/select.test.ts). Supporting
> files read for context (not in scope): `src/backend/registry.ts`,
> `src/backend/adapter.ts`, `src/errors.ts`, `src/types.ts`, `src/sanitize.ts`,
> `src/cli.ts`.
> **Threat model:** S-sized, single-user local CLI. `select()` reads three
> untrusted inputs — the `--backend` CLI flag, the `LOCAL_LLMUP_BACKEND`
> environment variable, and the config's `defaultBackend` (already Zod-validated
> to the `BackendName` enum) — plus `state.active.backend` (same-UID `0600`
> file, validated by the state schema). Flag and env sit at the invoking user's
> own trust level; the realistic external vector is a `LOCAL_LLMUP_BACKEND` value
> injected by a parent process, sourced `.env`, or wrapper script.
> **Dependencies:** `npm audit` reports 6 advisories (2 critical, 1 high, 3
> moderate), **all in the dev-only `vitest`/`vite` toolchain** (tracked in prior
> audits) — none in the shipped runtime closure (`cac`, `zod`,
> `systeminformation`). Out of scope for B5.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| Info | 3 |

**Verdict:** B5 is clean and safe to commit. The one Low finding is a
defense-in-depth improvement (a masked attach-intent env conflict); it is **not**
exploitable — no code path can retarget a running server — so it does not block
the commit.

---

## Findings

### [LOW-1] Attach-intent env conflict is silently masked when a matching flag is present

- **Location:** [src/backend/select.ts:105-116](../../src/backend/select.ts#L105-L116) (`selectAttach`)
- **Description:** Conflict detection collapses flag and env into a single
  `requested = flag ?? envBackend` before comparing to `activeBackend`. When the
  user passes a flag that **matches** the active backend but the environment
  variable **conflicts** with it (`flag === activeBackend` and
  `envBackend !== activeBackend`), the conflicting env value is discarded by the
  `??` and never compared, so no `ValidationError` is raised. The audit brief
  explicitly asks to "verify attach-intent conflict detection covers both flag
  and env"; the individual cases are covered by tests, but the combined case is
  not.
- **Impact:** None to server integrity. This is a **fail-closed** outcome by
  construction: the attach path *always* resolves `registry.get(activeBackend)`
  (line 118) and has no code path that returns a flag/env-derived adapter, so a
  running server can never be retargeted. The only effect is that a genuinely
  conflicting `LOCAL_LLMUP_BACKEND` is ignored silently instead of surfacing an
  explicit error, which weakens the "tell the user their env is stale" signal.
- **Proof of concept:** `select({ intent: "attach", registry, activeBackend: "ollama", flag: "ollama", env: { LOCAL_LLMUP_BACKEND: "llamacpp" } })` resolves to the ollama adapter with `source: "state"` and no error, even though the env requests a different backend.
- **Recommendation:** Check flag and env independently against the active
  backend so any conflicting override is reported, e.g.:

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

  Add a test for the combined `flag-matches / env-conflicts` case.

---

## Info-Level Observations

### [INFO-1] Untrusted names are interpolated into error messages — mitigated centrally

`selectAttach` interpolates the raw `requested` value, and `registry.get()`
interpolates the raw unknown name, into `ValidationError` messages
([select.ts:112-114](../../src/backend/select.ts#L112-L114),
[registry.ts:50-52](../../src/backend/registry.ts#L50-L52)). A hostile
`LOCAL_LLMUP_BACKEND` containing ANSI/BiDi/control bytes would otherwise reach
the terminal. This is **already neutralized** at the CLI boundary: every serving
command's catch block writes `stripControl(message)`
([cli.ts:128](../../src/cli.ts#L128), and the `down`/`switch`/`chat`/`migrate`
handlers), and `stripControl` removes ANSI, C0/C1 control, and Trojan-Source
BiDi codepoints. No action required for B5; keep relying on the central
sanitizer rather than sanitizing inside `select()`.

### [INFO-2] Backend-name comparison is case-sensitive

Flag/env values are trimmed but not case-folded before `registry.get()` /
active-backend comparison. `--backend Ollama` is rejected as unknown
(create-intent) or reported as a conflict (attach-intent) rather than matching
`ollama`. This is fail-closed and harmless, but yields a slightly confusing
message for a case-only typo. Optional: normalize case before lookup if desired.
No security impact.

### [INFO-3] Config-preference fall-through never reaches `registry.get()` with an unregistered name

The honesty/fail-safe requirement — a Zod-valid but unregistered
`configBackend` (e.g. `"llamacpp"` before Phase 2) must fall through to
auto-detect and never be passed to `registry.get()` (which throws) — is
correctly enforced by the `isRegistered()` guard
([select.ts:135-137](../../src/backend/select.ts#L135-L137)) and covered by a
dedicated test. Verified correct.

---

## Positive Observations

- **No prototype-pollution surface.** No untrusted string is ever used as a
  plain-object property key. Env is read from a fixed constant key
  (`ENV_BACKEND_OVERRIDE`), registry lookups go through `Map.get()` (literal
  keys, immune to `__proto__`/`constructor` tricks), and membership checks use
  array iteration (`.some()`, `.find()`) rather than indexed access.
- **Fail-closed is structural, not incidental.** Attach-intent resolves the
  adapter *only* via `registry.get(activeBackend)`; there is no branch that can
  substitute a flag/env-derived backend, so silent retargeting of a running
  server is impossible by construction (the strongest form of the requirement).
- **Explicit-intent inputs fail hard; stored preferences fail soft.** Flag and
  env go straight to `registry.get()` (unknown → `ValidationError`), while the
  config preference is guarded by `isRegistered()` first — exactly the spec's
  precedence/honesty contract.
- **Determinism / advice-path guard preserved.** `isInstalled()` is reached only
  via the auto-detect branch (`registry.available()`); flag, env, config-hit,
  and attach paths never probe it, and dedicated tests assert `isInstalled` is
  not called on those paths. The advice commands never import `select()`.
- **No `any`, explicit return types, no fabricated values.** All exported
  functions have explicit return types, inputs are `readonly`, and the
  no-servable-backend path emits a real `BackendError` with install hints rather
  than a fabricated default. Install hints are static, non-sensitive OS commands
  (no paths, secrets, or internal detail).
- **Thorough tests.** Precedence, blank-flag skipping, unknown-flag rejection,
  Apple-Silicon vs. non-Apple ordering, installed-only ranking, the
  never-auto-select-lmstudio rule, and both attach conflict cases are all
  covered.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | [LOW-1] Masked attach env conflict when flag matches active | Compare flag and env independently against `activeBackend`; add the combined-case test |
