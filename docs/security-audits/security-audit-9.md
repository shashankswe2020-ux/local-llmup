# Security Audit Report #9

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Uncommitted working-tree changes for task **B6** of the
> pluggable-backends plan — routing all serving-path commands through the
> backend registry + `select()` instead of `new OllamaAdapter()`. Files:
> `src/backend/adapter.ts`, `src/commands/{up,down,switch,chat,migrate,doctor,ls}.ts`,
> and the mirrored `tests/commands/*`. Supporting files read for context:
> `src/backend/{select,registry,ollama}.ts`, `src/state/state.ts`,
> `src/output.ts`, `src/types.ts`.
> **Dependencies:** 6 known vulnerabilities (`npm audit`: 2 critical, 1 high,
> 3 moderate) — all in the **dev-only** `vitest → vite → vite-node → esbuild`
> chain. None ship in the runtime package (runtime deps: `cac`, `zod`,
> `systeminformation`). Pre-existing and out of scope for B6.

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 2     |
| Info     | 2     |

**Verdict:** B6 is a clean, behavior-preserving refactor. All five non-negotiable
domain security principles are intact. No Critical or Important (High/Medium)
findings. The two Low items are defense-in-depth observations about code paths
that B6 leaves unreachable in Phase 0.

---

## Non-Negotiable Principle Verification

### 1. Integrity / fail-closed (up + switch pull verification) — PASS

- `up` still passes the integrity floor into `pull()` unchanged:
  `expectedSizeBytes: quant.diskBytes` (always) plus `expectedSha256` when the
  catalog has a digest ([src/commands/up.ts](../../src/commands/up.ts#L178-L184)).
  B6 only renamed `deps.adapter` → `adapter` (the value returned by `select()`);
  the verification arguments are identical.
- `switch` still passes `expectedSha256`/`expectedSizeBytes` on its pre-serve
  `pull()` ([src/commands/switch.ts](../../src/commands/switch.ts#L82-L89)),
  unchanged from pre-B6.
- The digest/size-floor enforcement lives inside `OllamaAdapter.pull()`, which
  B6 does not touch. The refactor cannot weaken a check it does not modify.
- **Reconcile-under-lock is byte-for-byte preserved**
  ([src/commands/up.ts](../../src/commands/up.ts#L188-L246)): `serve` →
  second `waitUntilReady({ requireOpenAiCompatibility: true })` → `readState`
  prior-owned reconcile → `writeState` → cleanup-on-failure, all inside one
  `withLock`. The only change is the adapter binding and `backend = adapter.name`
  replacing the hard-coded `"ollama" as const`.

### 2. Loopback-only (up binds 127.0.0.1) — PASS

- `serve({ host: DEFAULT_BIND_HOST, port })` is unchanged; `DEFAULT_BIND_HOST`
  is still `"127.0.0.1"` ([src/backend/adapter.ts](../../src/backend/adapter.ts#L11)).
- The port source changed from `DEFAULT_OLLAMA_PORT` to
  `adapter.capabilities.defaultPort` ([src/commands/up.ts](../../src/commands/up.ts#L190)),
  but `OllamaAdapter.capabilities.defaultPort === DEFAULT_OLLAMA_PORT === 11434`
  ([src/backend/ollama.ts](../../src/backend/ollama.ts#L515-L520),
  [src/backend/adapter.ts](../../src/backend/adapter.ts#L15)), so the effective
  wiring is identical. `defaultPort` is a compile-time constant on a
  registry-constructed adapter, never attacker-controllable. An explicit
  `--port` is still validated to the `1..65535` integer range before use
  ([src/commands/up.ts](../../src/commands/up.ts#L135-L140)).

### 3. Port-ownership (never claim ownership of a foreign process) — PASS

- `ownedByUs` and `pid` are still sourced **only** from the `serve()` handle:
  `handle.ownedByUs ? { …, pid: handle.pid, ownedByUs: true } : { …, ownedByUs: false }`
  ([src/commands/up.ts](../../src/commands/up.ts#L214-L237)). B6 did not
  introduce any path that stamps `ownedByUs: true` from state, config, or user
  input. `backend = adapter.name` is metadata only and does not influence the
  ownership discriminant.

### 4. Injection / sanitization (state.active.backend rendered/logged) — PASS

- `active.backend` is a Zod-validated `z.enum(BACKEND_NAMES)` field
  ([src/state/state.ts](../../src/state/state.ts#L31)); it can only ever be one
  of `"ollama" | "llamacpp" | "mlx" | "lmstudio"`. It cannot carry
  attacker-controlled bytes — a malformed value fails state validation at read
  time.
- `ls` renders `active.backend` as a new column
  ([src/commands/ls.ts](../../src/commands/ls.ts#L27-L45)). Even though the cell
  is passed raw, `renderTable` calls `stripControl` on every header and cell
  before measuring width ([src/output.ts](../../src/output.ts#L23-L24)), so the
  ANSI-safety guarantee still holds.
- `doctor` additionally wraps the value in `stripControl(active.backend)` in its
  failure detail ([src/commands/doctor.ts](../../src/commands/doctor.ts#L171)) —
  belt-and-suspenders on an already-constrained enum.

### 5. select() attach path cannot be retargeted — PASS

- Attach-intent (`down`/`switch`/`chat`/`migrate`) calls
  `select({ intent: "attach", registry, activeBackend: active.backend })` and
  passes **no** `flag` and **no** `env`
  ([src/commands/down.ts](../../src/commands/down.ts#L80-L82),
  [src/commands/switch.ts](../../src/commands/switch.ts#L78-L80),
  [src/commands/chat.ts](../../src/commands/chat.ts#L146-L148),
  [src/commands/migrate.ts](../../src/commands/migrate.ts#L152-L156)).
- `selectAttach` treats `activeBackend` as authoritative and, if a `flag`/env
  override were supplied and differed, throws a `ValidationError`
  ([src/backend/select.ts](../../src/backend/select.ts#L92-L118)). Because the
  commands supply neither, an untrusted `--backend`/`LOCAL_LLMUP_BACKEND` is
  simply **ignored** on the attach path — the running server's recorded backend
  always wins. This is strictly fail-closed: no retargeting vector exists.
- `registry.get(activeBackend)` throws `ValidationError` for a backend not
  registered in this build ([src/backend/registry.ts](../../src/backend/registry.ts#L46-L53)),
  so a state file naming a not-yet-shipped backend fails closed rather than
  silently attaching.

---

## Findings

### [LOW-1] Attach-path override conflict is silently ignored rather than surfaced

- **Location:** `src/commands/{down,switch,chat,migrate}.ts` (all attach
  `select()` call sites), e.g. [src/commands/switch.ts](../../src/commands/switch.ts#L78-L80)
- **Description:** The spec (`select.ts` header, §2.2) states that an explicit
  `--backend`/env that conflicts with the active backend is a `ValidationError`.
  The `selectAttach` code implements that check, but the attach commands never
  pass `flag`/`env` into `select()`, so the conflict branch is unreachable from
  the CLI. A user who sets `LOCAL_LLMUP_BACKEND=mlx` and runs `llmup down`
  against an Ollama server gets the correct (Ollama) behavior, but with no
  diagnostic that their override was ignored.
- **Impact:** No security exposure — the outcome is fail-closed (the active
  backend always wins). The only cost is reduced operator feedback and an
  untested guard rail that a future refactor could accidentally rely on.
- **Recommendation:** When B6-era `--backend`/env plumbing lands (or now, for
  defense-in-depth), thread the resolved `flag`/`env` into the attach `select()`
  calls so the existing conflict `ValidationError` actually fires. Until then,
  add a unit test asserting that attach commands pass no override, to document
  the intentional gap.

### [LOW-2] Create-intent flag/env/config paths in `select()` skip the install probe

- **Location:** [src/backend/select.ts](../../src/backend/select.ts#L128-L152)
- **Description:** On create-intent, the `flag`, `env`, and `config` branches
  return `registry.get(name)` **without** calling `isInstalled()`; only the
  `autoSelect` branch filters to `registry.available()`. `up` currently passes
  none of flag/env/config, so it always takes the auto path and the install gate
  is preserved for B6. But once `up` starts forwarding `--backend`/env/config
  (a later task), a user could select an uninstalled backend and reach `serve()`
  without the fail-closed "not installed → install hint" gate that pre-B6 `up`
  enforced inline.
- **Impact:** No exposure today (paths unreachable from `up` in Phase 0). Future
  risk is a confusing hard failure deep in `serve()` instead of the clear
  install-hint error, i.e. a degraded fail-closed message rather than a bypass.
- **Recommendation:** When wiring flag/env/config into `up`'s `select()`,
  probe `isInstalled()` on the explicitly-chosen adapter and throw the
  `BackendError` install hint on false, matching the pre-B6 guard. Cover with a
  test that an explicitly-selected-but-uninstalled backend fails before `serve()`.

---

## Positive Observations

- **Ownership invariant untouched:** `ownedByUs`/`pid` remain sourced solely
  from the `serve()` handle; B6 resisted the temptation to derive ownership from
  the newly-available `adapter.name`.
- **Enum-constrained backend field:** `state.active.backend` is a
  `z.enum(BACKEND_NAMES)` value, so the new `ls` column and `doctor` message
  render a closed set of trusted tokens — and `renderTable`/`stripControl` still
  sanitize regardless.
- **Fail-closed registry resolution:** both `registry.get()` (unknown name →
  `ValidationError`) and `selectAttach` (override conflict → `ValidationError`)
  fail closed; an unrecognized or mismatched backend never silently proceeds.
- **Isolated install probes:** `registry.available()` wraps each `isInstalled()`
  in try/catch so one throwing backend cannot mask the others or crash `up`'s
  auto-detect ([src/backend/registry.ts](../../src/backend/registry.ts#L55-L67)).
- **Reconcile-under-lock preserved verbatim:** the concurrency-race mitigation in
  `up` (stop prior owned daemon inside the lock, cleanup-on-persist-failure) is
  unchanged by the refactor.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                                          | Recommendation                                                                                      |
| --- | -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Low      | LOW-1: attach override silently ignored                          | Thread flag/env into attach `select()` so the conflict `ValidationError` fires; add a guard test    |
| 2   | Low      | LOW-2: create flag/env/config skip install probe                 | Probe `isInstalled()` on explicitly-selected adapters before `serve()` when `up` forwards overrides |
| —   | Info     | Dev-chain `npm audit` (vitest/vite/esbuild)                      | Track; not shipped in runtime package — no action required for B6                                   |
| —   | Info     | `doctor` picks `registry.all()[0]` for the generic backend check | Cosmetic only in Phase 0 (single backend); revisit when multiple backends register                  |
