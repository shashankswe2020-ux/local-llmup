# Code Review Checkpoint 24: Task B14b — llama.cpp serve/ready/stop lifecycle

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-07
> **Scope:** Task B14b — `LlamaCppAdapter` serve/waitUntilReady/stop lifecycle
> with loopback enforcement and port-ownership preflight (attach-vs-spawn),
> plus the `modelPath?` addition to the shared `ServeOptions`.
> **Test suite:** 841 tests passing (52 files, +14), typecheck ✅, build ✅,
> lint (changed files) ✅.
> **Files reviewed (uncommitted working tree):**
>
> - `src/backend/llamacpp.ts` (MODIFIED)
> - `src/backend/adapter.ts` (MODIFIED)
> - `tests/backend/llamacpp.test.ts` (MODIFIED)

---

## Verdict: ✅ APPROVE

**Overview:** A faithful, well-documented mirror of the Ollama serve/ready/stop
structure adapted to `llama-server`'s per-model, optionful CLI. All three B14b
acceptance criteria are met and enforced by tests: loopback is forced (non-loopback
refused, nothing spawned), a foreign listener is never claimed as owned, and stop
only signals an owned process with an ESRCH-idempotent, pid-reuse-guarded teardown.
No Critical issues. One Important item — the owned-spawn readiness probe never
consults llama.cpp's authoritative `/health` signal — should be confirmed and
addressed before llama.cpp is wired end-to-end in B14c/B15, but it does not block
this adapter-level slice.

---

## Critical Issues

None.

---

## Important Issues

### 1. Owned-spawn readiness never consults llama.cpp's `/health` signal

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L494-L497)
  (`this.waitUntilReady({ endpoint, requireOpenAiCompatibility: true })`), with
  probe semantics at [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L676-L706)
  (`probeReady` returns ready on the **first 2xx across paths**).
- **Problem:** For an **owned spawn**, `serve` passes `requireOpenAiCompatibility: true`,
  which restricts the readiness probe to `OPENAI_READINESS_PATHS = ["/v1/models"]`
  and never checks `/health`. llama.cpp added `/health` specifically to report
  model-load state (`503 {"status":"loading model"}` → `200 {"status":"ok"}`), which
  implies the HTTP surface — including `/v1/models` — is reachable _while the model
  is still loading_. If that holds, `serve` can return a `ready` handle (and the
  caller can persist an "active" server) before the model is actually loadable,
  which conflicts with the honesty posture (don't report ready when it isn't).
  Note the general `probeReady` "first 2xx across any path" rule would _also_ mask a
  `/health` 503 by falling through to `/v1/models` 200, so simply switching to the
  default paths is not sufficient.
- **Verification dependency:** This rests on `llama-server` answering `/v1/models`
  with 200 during model load. Please confirm against the targeted `llama-server`
  version (D4). If `/v1/models` only 200s post-load, the current choice is correct
  and this collapses to a no-op.
- **Fix (if confirmed):** Gate owned-spawn readiness on `/health` returning 200 and
  treat a `/health` 503 as authoritative "not ready" rather than falling through.
  For example, a llama.cpp-specific readiness that requires `/health`:

  ```ts
  // serve(): require the authoritative health signal for an owned spawn.
  await Promise.race([
    this.waitUntilReady({ endpoint, signal, requireHealth: true }),
    earlyFailure,
  ]);
  ```

  where `requireHealth` probes only `/health` and returns ready **only** on a 200
  (a 503 loading response is a definitive not-ready, so `probeReady` must not
  fall through to `/v1/models`). A focused test (`listening:true, healthy:false`
  must _not_ be ready) would pin the intended semantics — see Suggestion 4.

---

## Suggestions

### 1. `serve` omits `signal` in the `waitUntilReady` call (divergence from Ollama)

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L494-L497)
- The Ollama analog passes the caller signal
  ([src/backend/ollama.ts](../../src/backend/ollama.ts#L782) —
  `this.waitUntilReady({ endpoint, signal })`); the llama.cpp call drops it. A
  caller that aborts during the readiness wait would not short-circuit the loop
  (bounded by `timeoutMs`, default 30 s) as it would with Ollama. This is currently
  **latent** — `up` calls `adapter.serve({ host, port })` without a signal
  ([src/commands/up.ts](../../src/commands/up.ts#L194)) — but it is a real
  behavioral divergence from the stated mirror. Thread `signal` through:
  `this.waitUntilReady({ endpoint, signal, requireOpenAiCompatibility: true })`.

### 2. Seam types imported from a sibling concrete adapter couple `llamacpp` → `ollama`

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L35-L42)
- `FetchFn`, `KillFn`, `ProcessOutputStream`, `SleepFn`, `SpawnFn`, and
  `SpawnedProcess` are imported from `./ollama.js`, so the llama.cpp adapter now
  depends on the Ollama module purely for shared seam types. This is acceptable
  for now (the plan schedules consolidation in B16), but the seam contracts belong
  in a neutral home (e.g. `adapter.ts` or a `backend/seams.ts`) so no adapter
  imports another. Flagging so B16 doesn't lose it.

### 3. Missing-`modelPath` throws `BackendError` while non-loopback refusal throws `ValidationError`

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L454-L457)
  (`BackendError` for missing path) vs
  [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L422-L426)
  (`ValidationError` for non-loopback).
- Both are pre-spawn refusals derived from `ServeOptions`. The distinction is
  defensible — `modelPath` is only required on the _spawn_ branch (attach needs
  none), so it is contextual rather than pure input validation — but it is a subtle
  inconsistency a future reader may trip on. Either keep it and note the rationale
  in the comment, or align on `ValidationError`. Test currently pins `BackendError`
  intentionally, so this is a judgement call, not a defect.

### 4. Test coverage gaps

- **File:** [tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts)
- Two paths present in Ollama's suite are unexercised here:
  - **Readiness loading-state:** no case with `listening:true, healthy:false`
    asserting `serve`/`waitUntilReady` does **not** report ready — this is exactly
    what would pin Important 1's semantics.
  - **Abort path:** no `serve` case with a pre-aborted / mid-readiness
    `AbortSignal` (ties to Suggestion 1).
    Adding these would lock in the intended readiness and cancellation behavior.

---

## What's Done Well

- **Fail-closed identity boundary.** The `/props` fingerprint
  ([src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L299-L312)) is a sound,
  llama.cpp-specific trust check: a reachable OpenAI listener that lacks `/props`
  (a foreign server) is refused rather than attached. The heuristic is permissive
  across `total_slots`/`default_generation_settings`/`chat_template`/`model_path`
  (tolerant of version drift) yet still fail-closed — the right trade for a
  loopback attach decision.
- **Ownership + pid safety.** `stop` refuses non-positive pids
  ([L577-L581](../../src/backend/llamacpp.ts#L577-L581)), guards against pid reuse
  by refusing to kill when the endpoint is unreachable
  ([L586-L601](../../src/backend/llamacpp.ts#L586-L601)), and treats `ESRCH` as an
  idempotent success throughout — a faithful, safe mirror of the Ollama teardown.
- **Spawn hygiene.** Arg-array, `shell:false`, explicit `--host 127.0.0.1`, and
  correctly **no `--` separator** (llama-server has no positional args; the model
  is the `-m` value) — asserted exactly by the test.
- **Small, minimal interface change.** `modelPath?: string` on `ServeOptions`
  ([src/backend/adapter.ts](../../src/backend/adapter.ts#L69-L74)) is optional,
  additive, precisely documented (per-model runtimes require it, daemon runtimes
  ignore it), and enforced in the adapter — not leaked into command code.
- **Naming discipline.** `ReadinessResult` is named distinctly from the version
  `ProbeResult` to avoid a collision, and `isEsrch` is extracted into a helper
  ([L727-L729](../../src/backend/llamacpp.ts#L727-L729)) — a small readability
  improvement over Ollama's inlined `code === "ESRCH"` checks.
- **Documentation.** Every trust/lifecycle decision (why the caller signal is not
  passed to the persistent child, why `/props` gates attach, why pid-reuse is
  guarded) is explained in-comment at the point of decision.

---

## Verification Story

| Check            | Status | Notes                                                                                                                                                                                                                                                         |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 26 llamacpp cases; loopback refusal, attach, foreign refusal, owned spawn arg-array, missing-path, readiness-never/early-exit, stop ownership/pid-reuse all covered. Two gaps noted (Suggestion 4).                                                           |
| Full suite       | ✅     | 841 passing (52 files), `npx vitest run`.                                                                                                                                                                                                                     |
| Typecheck        | ✅     | `tsc --noEmit` clean.                                                                                                                                                                                                                                         |
| Build            | ✅     | `tsc` clean.                                                                                                                                                                                                                                                  |
| Lint (changed)   | ✅     | `eslint` clean on the three changed files.                                                                                                                                                                                                                    |
| Security checked | ✅     | Loopback fail-closed; `shell:false` arg array; `/props` attach gate is fail-closed; pid-reuse + non-positive-pid guards. `modelPath` flows as a discrete arg (no injection). `response.json()` on `/props` is unbounded but loopback-only and mirrors Ollama. |
| Coverage         | ⚠️     | Strong on the acceptance paths; missing loading-state readiness and abort-path cases.                                                                                                                                                                         |

---

## Action Items

| #   | Priority   | Issue                                                                                                                                 | Target                          |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Important  | Confirm `llama-server` `/v1/models` load-state behavior; gate owned-spawn readiness on `/health` 200 if `/v1/models` 200s during load | B14c / before end-to-end wiring |
| 2   | Suggestion | Thread `signal` into `serve`'s `waitUntilReady` call (mirror Ollama)                                                                  | B14c                            |
| 3   | Suggestion | Hoist shared seam types out of `ollama.ts` into a neutral module                                                                      | B16                             |
| 4   | Suggestion | Align/annotate missing-`modelPath` error type vs the non-loopback `ValidationError`                                                   | backlog                         |
| 5   | Suggestion | Add loading-state readiness + serve abort-path tests                                                                                  | B14c / B16                      |
