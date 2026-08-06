# Security Audit Report #14

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** Uncommitted B12 changes — **backend surfacing** on the deterministic
> advice path. New CLI input handling (`--backend <name>`, `--available-backends`)
> and an opt-in installation-probing branch:
> [src/commands/recommend.ts](../../src/commands/recommend.ts) (`parseBackendName`,
> `backends[]`/`throughputBackend` on results, the `--available-backends` filter,
> and the gated `registry.available()` call in `runRecommend`),
> [src/commands/can-run.ts](../../src/commands/can-run.ts) (`--backend` scoping +
> `backends[]`/`throughputBackend`), and [src/cli.ts](../../src/cli.ts) (option
> wiring for both commands). Diffed against the `stripControl` sanitizer, the
> `z.enum(BACKEND_NAMES)` validator, the `shell:false` spawn posture in
> `runProcess`/`isInstalled`, and the pure `registry.all()` / `backendsForModel`
> resolution path.
> **Dependencies:** `npm audit` reports **6 vulnerabilities (2 critical, 1 high,
> 3 moderate)** — all in the **dev-only** `vitest`/`vite`/`vite-node`/`esbuild`
> closure, none in the shipped runtime deps (`cac`, `zod`, `systeminformation`).
> Pre-existing and unchanged by B12 (see INFO-2).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 2 |

**Verdict:** The B12 change is correct and defensively coded against every risk
called out in the brief. `--backend` is validated by a Zod enum before it can
influence any lookup, so unknown values fail closed with a `ValidationError`.
The raw invalid selector echoed in that error is `stripControl`-sanitized at the
CLI boundary before it reaches stderr, closing the terminal-escape vector. The
offline/determinism invariant holds: the default `recommend`/`can-run` path
never calls `isInstalled()` — a dedicated test asserts the probe flag stays
`false` — and the only branch that spawns a child process
(`registry.available()`) is gated strictly behind an explicit
`--available-backends === true`. Per-model `backends[]` come from the pure
`registry.all()` snapshot (no spawn), the opt-in filter renumbers but never
silently drops in default mode, and the honesty gate is preserved (an unsourced
`(class, backend)` efficiency pair yields `known:false` while the model stays
ranked). No secrets, no filesystem writes, and no new network egress are
introduced. The two Low findings are defense-in-depth hardening, not exploitable
defects.

---

## Findings

### [LOW-1] `parseBackendName` echoes the raw selector unsanitized; escape safety depends solely on the CLI catch

- **Location:** [src/commands/recommend.ts](../../src/commands/recommend.ts) (`parseBackendName`), consumed in [src/cli.ts](../../src/cli.ts#L112) and [src/cli.ts](../../src/cli.ts#L259)
- **Description:** `parseBackendName` throws
  `` `--backend must be one of ${BACKEND_NAMES.join("|")}: ${raw}` `` with the
  **unsanitized** user-supplied `raw` value interpolated verbatim. Terminal-escape
  safety is entirely delegated to the two CLI `catch` blocks, which apply
  `stripControl(message)` before writing to stderr. For the current call graph
  this is safe — both `recommend` and `can-run` route the error through
  `stripControl` — so there is **no live vulnerability**.
- **Impact:** None today. The risk is latent: any future caller of
  `parseBackendName` (a new command, a programmatic path, or a JSON error
  channel) that surfaces `error.message` without re-applying `stripControl`
  would leak ANSI/BiDi/control bytes from `raw` straight to a terminal. This is
  the exact "sanitize at the source" pattern that Audit #13 (B11) praised for
  `probeVersion`; B12 sanitizes at the boundary instead, making the safety
  property non-local.
- **Proof of concept:** N/A (not exploitable through the current CLI — the
  boundary sanitizer intercepts it).
- **Recommendation:** Sanitize (and length-bound) the echoed value at the source
  so the invariant travels with the function rather than the call site:
  ```ts
  export function parseBackendName(raw: string): BackendName {
    const parsed = backendSchema.safeParse(raw);
    if (!parsed.success) {
      const shown = stripControl(raw).slice(0, 64);
      throw new ValidationError(`--backend must be one of ${BACKEND_NAMES.join("|")}: ${shown}`);
    }
    return parsed.data;
  }
  ```
  This mirrors the `parseContextTokens` / `probeVersion` sanitize-at-source
  convention already established in the codebase.

### [LOW-2] `DEFAULT_THROUGHPUT_BACKEND` is triplicated, weakening the determinism invariant's single source of truth

- **Location:** [src/advisor/throughput.ts](../../src/advisor/throughput.ts#L37), [src/commands/recommend.ts](../../src/commands/recommend.ts), [src/commands/can-run.ts](../../src/commands/can-run.ts)
- **Description:** The advice-path baseline `const DEFAULT_THROUGHPUT_BACKEND:
  BackendName = "ollama"` is declared independently in three modules. The
  determinism invariant ("default advice never varies with installed backends")
  depends on all three staying identical and staying a fixed literal — never an
  `isInstalled()`-derived value.
- **Impact:** No current defect (all three agree). This is a defense-in-depth /
  integrity concern: if a future edit changes one declaration (or wires one to a
  detected default), the default output of `recommend` and `can-run` could
  silently diverge or become environment-dependent, breaking the reproducibility
  guarantee that the honesty/determinism gate rests on — the kind of drift a
  single constant would prevent.
- **Proof of concept:** N/A (no live exploit).
- **Recommendation:** Export the constant once from `src/advisor/throughput.ts`
  (the module that owns the throughput baseline) and import it in both command
  modules, so the invariant has one authoritative definition.

---

## Positive Observations

- **Fail-closed input validation.** `--backend` is parsed by
  `z.enum(BACKEND_NAMES)` via `safeParse`; any value outside
  `{ollama, llamacpp, mlx, lmstudio}` throws a typed `ValidationError` and exits
  non-zero before it can reach a throughput lookup, a spawn, or output. The
  validated value is the only thing that flows onward — the raw string never
  reaches the success path.
- **Terminal-escape vector closed at the boundary.** Both `recommend` and
  `can-run` route the echoed selector through `stripControl(message)` before
  stderr, neutralizing ANSI, C0/C1 control, and Trojan-Source BiDi bytes.
- **Offline/determinism invariant proven by test.** The default advice path never
  reaches `isInstalled()`: `throughputBackend` is the fixed literal `"ollama"`
  and per-model `backends[]` come from the pure `registry.all()` snapshot via
  `backendsForModel` (no spawn). The test
  [tests/commands/recommend.test.ts](../../tests/commands/recommend.test.ts#L310)
  asserts default output is byte-identical whether a backend is installed or not
  and that the probe flag stays `false` — a direct, regression-proof guard on the
  no-network invariant.
- **Installation probe correctly gated.** `registry.available()` (the only branch
  that spawns `ollama --version`) is called solely when
  `options.availableBackends === true`; `buildRecommendation` applies the
  drop-and-renumber filter only when `availableBackendNames !== undefined`, whose
  default is `undefined`. `can-run` exposes no `--available-backends` flag at all.
  The opt-in filter therefore cannot be triggered in default mode and never
  silently drops a model there.
- **Honesty gate intact.** `resolveEfficiency` returns `undefined` for any
  backend lacking a class scalar (only `ollama`/`llamacpp` reuse the shared
  roofline), yielding `known:false` rather than a fabricated tok/s, while the
  model remains ranked — verified by the "unsourced pair is unknown but still
  ranked" tests in both command suites.
- **No command-injection surface.** The gated probe spawns a hardcoded binary
  with a discrete `["--version"]` arg array under `shell:false`; the `--backend`
  value never reaches `spawn` — it only selects an efficiency scalar. No user
  input is interpolated into a shell.
- **No new secrets, filesystem writes, or network egress.** The only new external
  interaction is the opt-in child-process version probe; there are no `fetch`
  calls, file writes, or `console.*` secret-leak paths in the changed code.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | `parseBackendName` echoes raw selector unsanitized (LOW-1) | `stripControl` + length-bound the echoed value at the source |
| 2 | Low | `DEFAULT_THROUGHPUT_BACKEND` triplicated (LOW-2) | Export once from `throughput.ts`; import in both commands |
| 3 | Info | `--available-backends` with nothing installed yields an empty set (INFO-1) | Emit an explicit "no installed backend" note instead of silent-empty output |
| 4 | Info | Dev-only `npm audit` vulnerabilities (INFO-2) | Track dev-toolchain CVEs; no runtime exposure |

---

## Informational

### [INFO-1] `--available-backends` with no installed backend produces a silent empty result

When `--available-backends` is passed on a machine with no installed backend,
the filter drops every model and the command emits an empty recommendation set.
This is *honest* (nothing is installed, so nothing is servable) and is opt-in, so
it is not a security defect. It is a UX sharp edge: an explicit line such as
"no installed backend detected — run `local-llmup doctor`" would distinguish
"nothing installed" from "nothing fits" and avoid a confusing blank result.

### [INFO-2] Dev-only dependency vulnerabilities (unchanged by B12)

`npm audit` reports 6 vulnerabilities (2 critical, 1 high, 3 moderate), all
within the `vitest` / `vite` / `vite-node` / `esbuild` dev closure. None are in
the shipped runtime dependencies (`cac`, `zod`, `systeminformation`), and none
are introduced or worsened by B12 — this is the same posture recorded in Audits
#12 and #13. No runtime exposure; track for the dev toolchain only.
