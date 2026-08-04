# Security Audit Report #3

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-05
> **Scope:** T19 `down` and `ls` commands — `src/commands/down.ts`, `src/commands/ls.ts`, and their `cli.ts` wiring (try/catch → `${cmd}: ${stripControl(message)}` on stderr, exitCode 1). Backend `stop`, `resolveModel`, state persistence primitives (`readState`/`writeState`/`withLock`), `renderTable`, and `stripControl` are treated as trusted per the provided threat context.
> **Dependencies:** 6 known vulnerabilities via `npm audit` (2 critical, 1 high, 3 moderate) — **all** confined to the `vitest`/`vite` dev toolchain; none ship at runtime.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| Info | 2 |

The `down`/`ls` surface is tightly scoped and well-hardened. The untrusted `[model]` argument never reaches a signal or a shell; all state-sourced strings are sanitized before display; and `down` performs read → stop → write entirely inside `withLock`, eliminating intra-tool TOCTOU and double-signal races. The single new actionable finding concerns **state consistency after a successful stop** (a `down`-side analog of the already-fixed issue #7). The residual pid-trust concern is **already tracked by the still-open issue #1** and is not duplicated here.

---

## Findings

### [LOW-1] `down` does not guarantee state is cleared after a successful stop (non-atomic `stop` → `writeState`)

- **Location:** `src/commands/down.ts` — owned-server branch of `runDown`:
  ```ts
  if (active.ownedByUs) {
    await deps.adapter.stop({ endpoint: active.endpoint, pid: active.pid, port: active.port, ownedByUs: true });
    deps.writeState(deps.config, createEmptyState());   // <-- can throw after the process is already dead
    deps.write(`Stopped ${label} (${endpoint}).\n`);
    return;
  }
  ```
- **Description:** `stop` and `writeState` are two sequential, non-atomic operations. If `stop` succeeds (the owned Ollama process receives SIGTERM and dies) but `writeState` then throws (ENOSPC, EIO, a mid-run permission change on `~/.local-llmup/`), the exception propagates out of the `withLock` body and `state.json` is **left recording the now-dead server as `{ active: { ownedByUs: true, pid: <positive> } }`**. Unlike the `up` path — which audit #2 hardened with a `stopQuietly` guarantee (issue #7, fixed) — `down` has no compensating action to reconcile state once the process is confirmed stopped.
- **Impact:** State now points at a positive pid whose process no longer exists. This is benign only until the OS **recycles that pid** to an unrelated, user-owned process. A subsequent `down` reads the stale `active`, sees `ownedByUs: true` with a positive pid, and issues `SIGTERM` to the recycled process — i.e. it manufactures the exact pid-reuse signaling window described in issue #1. So this reliability gap has a direct security consequence: it can *create* the condition that #1 warns about.
- **Relationship to existing issues:** **Not a duplicate of #1.** #1 concerns the *kill semantics* inside `stop` (non-positive / group / reused pid) and its fix lives in the adapter. This finding concerns *state consistency in the command* after a confirmed-successful stop, and its fix lives in `down.ts`. It is the `down`-side analog of the `up`-side issue #7 (already fixed via `stopQuietly`).
- **Proof of concept (fault-injection):**
  ```text
  1. local-llmup up llama3        -> state.active = { ownedByUs:true, pid:4242, port:11434 }
  2. Make ~/.local-llmup/ un-writable (or fill the disk) to force writeState to throw.
  3. local-llmup down             -> adapter.stop kills pid 4242 successfully,
                                     writeState(empty) throws, error surfaces,
                                     state.json STILL says pid 4242 owned+active.
  4. OS later recycles pid 4242 to an unrelated user process.
  5. local-llmup down             -> SIGTERM sent to the recycled process (issue #1 window).
  ```
- **Recommendation:** Guarantee state is reconciled once the process is confirmed stopped. Either (a) clear state *before* signaling and treat the kill as best-effort, or (b) wrap the post-stop `writeState` so a failure still leaves a consistent record and is surfaced without stranding an owned pid. Example (b):
  ```ts
  if (active.ownedByUs) {
    await deps.adapter.stop({ endpoint: active.endpoint, pid: active.pid, port: active.port, ownedByUs: true });
    try {
      deps.writeState(deps.config, createEmptyState());
    } catch (err) {
      // Process is already dead; never leave a stale owned pid that a later `down` would re-signal.
      deps.log(`down: process stopped but failed to persist cleared state: ${stripControl(String(err))}\n`);
      throw err;
    }
    deps.write(`Stopped ${label} (${endpoint}).\n`);
    return;
  }
  ```
  A more complete fix mirrors the `up` path: adopt the same post-stop state-reconciliation guarantee (`stopQuietly`-equivalent) so the "process stopped ⇒ state no longer records it as owned" invariant always holds.

---

## Informational

### [INFO-1] Signaling a pid sourced from a tampered/stale `state.json` — already tracked by open issue #1

- **Location:** `src/commands/down.ts` (owned branch) → `adapter.stop({ pid: active.pid, ... })`.
- **Observation:** `down` forwards `active.pid` from `state.json` to `stop` → `process.kill(pid, SIGTERM)`. State validation forbids `{ownedByUs:true, pid:0}` and `stop` re-guards a positive pid, so the non-positive / process-group cases are blocked. The remaining risk — a tampered or stale `state.json` carrying a **large, valid, but wrong** pid, causing `down` to SIGTERM an arbitrary user-owned (or recycled) process — is **exactly the "reused pid / arbitrary process" residual already described and tracked by the open issue #1**. Per scope guidance this is referenced, **not** re-filed.
- **Note on privilege:** An attacker who can write `~/.local-llmup/state.json` already runs as the same local user and could invoke `kill` directly; `down` grants no new capability. The meaningful exposure is the *accidental* reused-pid path (INFO-1 chained from LOW-1), which #1's identity/positive-pid hardening is the right place to close.
- **Action:** Issue #1 remains **OPEN** and its residual applies to `down`. Flagging per unresolved-prior-findings policy. A complementary command-layer defense worth considering when #1 is addressed: verify a listener is still bound on `active.port` (or the process identity matches) before signaling, shrinking the reused-pid blast radius.

### [INFO-2] `ls` reads state outside `withLock` — acceptable given atomic writes

- **Location:** `src/commands/ls.ts` — `runLs` calls `deps.readState` with no lock.
- **Observation:** `ls` is read-only and takes no lock. Because `writeState` publishes via atomic temp-file + `rename`, a concurrent `up`/`down` cannot expose a torn read — `ls` observes either the complete previous or complete next state. The only visible effect of the missing lock is a benign, momentary display of a server that a concurrent `down` is in the middle of stopping. No integrity or injection impact. Documented as a deliberate, safe design choice.

---

## Positive Observations

- **No terminal injection.** Every state-sourced string reaching the terminal is sanitized: `down` applies `stripControl` to `modelId` and `endpoint` before display and routes error text through the CLI's `stripControl`; `ls` renders `modelId`/`endpoint` through `renderTable`, which strips control characters. No raw state string hits stdout/stderr.
- **Untrusted `[model]` arg is fully contained.** `options.model` flows only into `resolveModel` (strict `^[a-z0-9._:/-]+$`, `..` traversal rejected, typed errors) and is compared against `active.modelId`. It never reaches `process.kill`, a shell, or an unsanitized output path. The signaled pid is derived **only** from validated state, never from the argument.
- **No intra-tool TOCTOU or double-signal.** `down` performs `readState` → `stop` → `writeState` entirely within a single `withLock` critical section. Concurrent `down` invocations serialize; the second sees `active === null` and prints "No active server to stop." rather than re-signaling.
- **Safe attached path.** When `ownedByUs` is false, `down` never signals — it only clears state and reports the server was left running.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | `down` can strand a stale owned pid in state if `writeState` fails after a successful `stop` (LOW-1) | Guarantee post-stop state reconciliation (`stopQuietly`-equivalent); never leave an owned pid recorded once the process is confirmed dead |
| — | Info | Reused/wrong pid signaling from tampered/stale state (INFO-1) | Tracked by **open issue #1**; not re-filed. Consider a port/identity re-check at the command layer when #1 is addressed |
| — | Info | `ls` reads state without the lock (INFO-2) | Acceptable given atomic writes; no change required |
