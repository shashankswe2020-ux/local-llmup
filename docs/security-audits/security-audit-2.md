# Security Audit Report #2

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-05
> **Scope:** T18 `up` command — `src/commands/up.ts`, `up` wiring in `src/cli.ts`, `ServerState` schema in `src/state/state.ts`. Backend adapter internals (`pull`/`serve`/`stop`), `resolveModel`, and state persistence primitives are treated as trusted per the provided threat context.
> **Dependencies:** 6 known vulnerabilities via `npm audit` (2 critical, 1 high, 3 moderate) — **all** confined to the `vitest`/`vite` dev toolchain; none are runtime/shipped dependencies.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 0 |
| Info | 2 |

The `up` command's handling of untrusted input (model name, `--port`), its spawn model, its loopback binding, and its state-write path are all adequately mitigated. The single actionable finding concerns the **process-ownership lifecycle across repeated invocations**, not input handling.

---

## Findings

### [MEDIUM-1] Re-running `up` orphans a previously-tracked owned server; the lock does not cover spawn→persist as one unit

- **Location:** `src/commands/up.ts` — `runUp` (whole flow), specifically the absence of an `state.active` read and the narrow `deps.withLock` scope around `writeState` only.
- **Description:** `runUp` never reads the current `active` server before spawning. It unconditionally `pull`s, `serve`s, then overwrites `state.active` with the new `ServerState`. The `withLock` critical section wraps **only** `writeState`, not the `serve`+persist sequence. Consequently:
  1. **Sequential re-run:** `local-llmup up modelA` (spawns pid=1001, port 11434, `ownedByUs:true`) followed by `local-llmup up modelB --port 11500` overwrites `active` with modelB. Pid 1001 is now **erased from state**. `down`/`stop` can no longer see or signal it, so the modelA daemon leaks — it keeps running and holds port 11434 indefinitely.
  2. **Same-port re-run:** re-running on the already-bound port makes the second `serve` fail to bind; the tool is then unusable on that port until the orphan is manually killed, because state no longer records the owner.
  3. **Concurrent invocations:** two `up` processes both pass `isInstalled`, both `serve`, and serialize only at `writeState` — last-writer-wins, orphaning the loser's owned child.
- **Impact:** Loss of control over spawned, network-listening daemons: leaked local processes, port exhaustion, and defeat of the `down` cleanup contract (a process the tool *owned* becomes untrackable). For a tool whose entire safety model rests on the `ownedByUs`/`pid` bookkeeping, silently discarding an owned pid undermines that model.
- **Relationship to existing issues:** Distinct from issue #7 (which addresses orphaning when *the current* server's `writeState` fails — already fixed here via `stopQuietly`). This finding is about a *successful* `up` discarding a *previously recorded* owned server. Not a duplicate.
- **Proof of concept:**
  ```bash
  local-llmup up llama3            # spawns pid 1001 on :11434, state.active -> pid 1001
  local-llmup up mistral --port 11500  # spawns pid 2002 on :11500, state.active overwritten -> pid 2002
  local-llmup down                 # stops only pid 2002; pid 1001 leaks, :11434 stays bound
  ps aux | grep ollama             # pid 1001 still alive, now untrackable
  ```
- **Recommendation:** Before spawning, read `state.active` inside the lock and make `up` idempotent / explicit:
  - If an owned server for the same `modelId` is already live, attach/return instead of spawning a duplicate.
  - If a *different* owned server is recorded and live, either refuse with a clear error ("a server is already running; run `down` first") or stop it before starting the new one — never silently drop its pid.
  - Widen the lock to cover the read-check→spawn→write as one critical section so concurrent `up` invocations cannot both spawn. Sketch:
    ```ts
    await deps.withLock(deps.config, async () => {
      const current = deps.readState(deps.config).active;
      if (current?.ownedByUs && current.pid > 0 && isAlive(current.pid)) {
        if (current.modelId === model.id) return; // idempotent
        throw new ValidationError(`a server is already running (${current.modelId}); run 'down' first`);
      }
      const handle = await deps.adapter.serve({ host: DEFAULT_BIND_HOST, port });
      // ...waitUntilReady, then writeState(active)...
    });
    ```
    (Holding the lock across `serve` lengthens the critical section; keep the lock timeout generous and ensure `stopQuietly` runs on any failure inside the section.)

---

## Informational / Residual (no issue filed)

### [INFO-1] `runUp` trusts caller-supplied `port` without re-validating range (defense-in-depth) — overlaps with #8

`runUp` uses `options.port ?? DEFAULT_OLLAMA_PORT` and passes it straight to `serve` without bounds-checking. Untrusted `--port` is already validated at the CLI boundary (issue #8, fixed in this code), and `writeState`'s Zod schema rejects out-of-range ports — but only *after* a process has been spawned, relying on `stopQuietly` to clean up. As an internal API, `runUp` re-validating `port` (1..65535, integer) at entry would fail fast before any spawn. Overlaps with issue #8; **not re-filed**. Recommend a one-line guard at the top of `runUp` as defense-in-depth.

### [INFO-2] Dev-toolchain dependency vulnerabilities (`vitest`/`vite`)

`npm audit` reports 6 vulnerabilities (2 critical, 1 high, 3 moderate), all transitive through `vitest`/`vite`/`vite-node`. These are **dev-only** (test runner) and are not part of the shipped runtime (the project ships with no runtime deps beyond the MCP SDK + Zod per project conventions). Runtime exposure is nil, but keeping the test toolchain current is good hygiene. Recommend upgrading `vitest` to a patched major and re-running `npm audit`. Not a finding against the `up` feature; **not filed** as a security issue.

---

## Overlaps with prior audit (#1) noted, not re-filed

- **Reused-pid signaling:** `ServerState` persists a bare `pid`; a later `down` signals it. If an owned daemon dies and the OS recycles its pid, `down` could signal an unrelated process. This is the residual of issue #1 (non-positive/reused pid). The new `.refine(ownedByUs ⇒ pid > 0)` closes the non-positive vector but not pid-reuse. Tracked under #1 — **not re-filed**. (A start-time/`starttime` fingerprint alongside pid would fully close it; out of scope for `up` alone.)

---

## Positive Observations

- **No shell, ever:** both `pull` and `serve` spawn with `shell:false`, and `pull` uses a `--` argument terminator — eliminating command/argument injection even before charset constraints.
- **Layered input validation:** `resolveModel` + `assertSafeModelId` (regex-constrained) mean the model id reaching the backend cannot contain traversal (`..`) or shell/space metacharacters; `--port` is integer/range-checked at the CLI boundary.
- **Secure-by-default binding:** `up` binds loopback only and cannot reach the non-loopback code path; the `0.0.0.0` gate (issue #2) is never opened from here.
- **Terminal-injection hygiene:** backend `status` output and `ollamaId` are `stripControl`'d before being written to stderr, and CLI error messages are sanitized — preventing ANSI/escape injection from backend output.
- **Atomic, least-privilege state writes:** Zod validation → temp file in a 0700 staging dir → atomic rename → 0600 mode, guarded by an `O_EXCL` lock. Strong integrity posture.
- **Failure cleanup:** `stopQuietly` on readiness failure and on `writeState` failure prevents orphaning of the *current* server (issue #7 addressed).

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | `up` orphans a previously-tracked owned server; lock excludes spawn | Read `state.active` inside the lock; make `up` idempotent or refuse/stop-first; widen lock to cover check→spawn→write |
| 2 | Info | `runUp` doesn't re-validate `port` (overlaps #8) | Add a range guard at `runUp` entry (defense-in-depth) |
| 3 | Info | Dev-toolchain CVEs (`vitest`/`vite`) | Upgrade `vitest`, re-run `npm audit` (dev-only, no runtime risk) |
