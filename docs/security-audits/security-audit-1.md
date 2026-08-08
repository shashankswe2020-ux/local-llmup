# Security Audit Report #1

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-05
> **Scope:** T17 — Ollama backend adapter daemon lifecycle (`serve` / `stop`, `defaultSpawn`, `defaultKill`, `isReachable`) in `src/backend/ollama.ts`; `buildEndpoint` in `src/backend/adapter.ts`. Process spawning, env injection, signal-based kill, attach-vs-spawn ownership only.
> **Dependencies:** 0 known vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity         | Count |
| ---------------- | ----- |
| Critical         | 0     |
| High (Important) | 2     |
| Medium           | 0     |
| Low (Minor)      | 3     |
| Info             | 0     |

---

## Findings

### [HIGH-1] `stop` can signal the whole process group / arbitrary processes via a non-positive or reused pid

- **Location:** `src/backend/ollama.ts:639` (`stop`), `src/backend/ollama.ts:172` (`defaultKill`)
- **Description:** `stop` guards only `handle.ownedByUs`; it never validates `handle.pid` before calling `this.kill(handle.pid)` → `process.kill(pid)`. `ServeHandle` values round-trip through `state.json`, which the project's own stateless-adapter contract treats as untrusted runtime data, and the adapter itself mints `pid: 0` for the attached case. Under POSIX `kill(2)` semantics (which `process.kill` inherits):
  - `process.kill(0, sig)` → signals **every process in the caller's process group** (the CLI, its parent shell, siblings).
  - `process.kill(-1, sig)` → signals **every process the user is allowed to signal**.
  - `process.kill(-N, sig)` → signals **process group N**.
- **Impact:** A corrupted, mis-merged, or tampered state entry of the form `{ pid: 0, ownedByUs: true }` (or a negative pid) turns a routine `down`/cleanup into a mass `SIGTERM` — self-terminating the CLI and potentially the user's shell session and unrelated processes. Separately, a **stale positive pid** (the daemon exited and the OS recycled the pid) causes `stop` to `SIGTERM` an innocent foreign process (`ESRCH` will not fire — a live, different process now owns that pid).
- **Proof of concept:**
  1. Write `state.json` with `{ "pid": 0, "ownedByUs": true, ... }` (simulating corruption or a partial write).
  2. Run the stop path → `defaultKill(0)` → `process.kill(0, undefined)` → SIGTERM to the entire process group, killing the running CLI/shell.
  3. Negative variant: `{ "pid": -1, "ownedByUs": true }` → `process.kill(-1)` → SIGTERM to all of the user's processes.
- **Recommendation:** Validate the pid at the kill boundary (fail closed) and never construct an owned handle without a real pid:
  ```ts
  async stop(handle: ServeHandle): Promise<void> {
    if (!handle.ownedByUs) return;
    if (!Number.isInteger(handle.pid) || handle.pid <= 0) {
      throw new BackendError(`refusing to stop: invalid owned pid ${handle.pid}`);
    }
    try {
      this.kill(handle.pid);
    } catch (error) { /* ESRCH → idempotent, else wrap */ }
  }
  ```
  In `serve`, the existing `pid === undefined` guard should also reject `pid <= 0` before returning `ownedByUs: true`. For defence against pid reuse, record a process fingerprint (start time / argv) in the handle and verify it before signalling.

### [HIGH-2] `serve` has no opt-in gate — the unauthenticated daemon can bind `0.0.0.0`

- **Location:** `src/backend/ollama.ts:506` (`serve`, `host` handling), `src/backend/adapter.ts:21` (`buildEndpoint` validates port only)
- **Description:** Spec §8 (lines 171, 499–504) requires the server to bind `127.0.0.1` by default and to bind non-loopback addresses **only** behind an explicit `--host` opt-in, because the endpoint is an unauthenticated model + memory store. `serve` accepts any `options.host` and injects it verbatim into `OLLAMA_HOST` (`${host}:${port}`). There is no allow-list and no opt-in flag: `serve({ host: "0.0.0.0" })` (or `"::"`, or `""` which Ollama treats as bind-all) silently exposes the daemon to the LAN. `buildEndpoint` validates the port but never the host charset or scope.
- **Impact:** Any caller (or a future `up` command that plumbs `--host` through without a gate) can expose an unauthenticated inference + memory endpoint to the local network — remote model use, resource abuse, data exfiltration/injection into the memory store, and a larger attack surface for known Ollama path-traversal/RCE CVEs.
- **Proof of concept:** `adapter.serve({ host: "0.0.0.0" })` → child spawned with `OLLAMA_HOST=0.0.0.0:11434` → daemon listens on all interfaces with no authentication. Nothing in the adapter warns or blocks.
- **Recommendation:** Enforce the loopback default in `serve`. Add a distinct opt-in (e.g. `allowNonLoopback: true`, wired from a `--host` flag that also emits the spec-mandated warning). Reject non-loopback hosts otherwise:
  ```ts
  const host = options?.host ?? DEFAULT_BIND_HOST;
  const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!options?.allowNonLoopback && !LOOPBACK.has(host)) {
    throw new ValidationError(`refusing non-loopback bind ${host}; pass --host to opt in`);
  }
  ```
  Also validate the host charset (reject empty, embedded ports, and control characters) before building `OLLAMA_HOST`.

### [LOW-1] No SIGTERM→SIGKILL escalation on cleanup; kill is not awaited

- **Location:** `src/backend/ollama.ts:506` (`serve` cleanup: no-pid and readiness-failure paths call `child.kill()`), `src/backend/ollama.ts:639` (`stop`)
- **Description:** Termination sends a single `SIGTERM` with no escalation and without awaiting exit. A daemon that ignores or is slow to handle `SIGTERM` lingers as an orphan while the caller believes cleanup succeeded.
- **Impact:** Occasional orphaned `ollama serve` holding the port/GPU. (Note: `child.kill()` on the `ChildProcess` handle is _not_ pid-reuse prone — it targets the tracked child and no-ops after exit; the reuse risk is confined to the raw-pid `stop` path in HIGH-1.)
- **Recommendation:** After a grace period, escalate to `SIGKILL` if the process has not exited, and await the close event where a handle is available.

### [LOW-2] Full parent-environment inheritance into the spawned daemon

- **Location:** `src/backend/ollama.ts:506` (`env: { ...process.env, OLLAMA_HOST: ... }`)
- **Description:** The daemon inherits the entire parent environment. Security-relevant Ollama variables present in the ambient environment are silently honoured — notably `OLLAMA_ORIGINS` (a `*` value opens CORS, enabling browser / DNS-rebinding access to the loopback daemon) and `OLLAMA_MODELS` (redirects the model store). Constructing `env` as a structured object correctly prevents any env-var _injection_ via the `host` string (there is no string concatenation to break out of), so the risk is inheritance semantics, not injection.
- **Impact:** The daemon's security posture is dictated by whatever is already in the environment rather than by explicit, safe defaults.
- **Recommendation:** Set safe defaults for security-relevant variables explicitly (e.g. force a restrictive `OLLAMA_ORIGINS` unless the user opts in) instead of passively inheriting them, or pass a curated allow-list of environment variables to the child.

### [LOW-3] Attach-vs-spawn trusts any listener on the port

- **Location:** `src/backend/ollama.ts` (`isReachable` / `serve` attach branch returning `ownedByUs: false`)
- **Description:** `serve` attaches to whatever returns a 2xx on `/v1/models` or `/api/tags` at `127.0.0.1:port`. A foreign local process squatting that port is accepted as the Ollama daemon, and subsequent `chat`/`embed` payloads (including memory-store content) are sent to it.
- **Impact:** On a shared or compromised host, a local process can impersonate the daemon and receive/alter model traffic. Loopback trust bounds this, but it is not identity verification.
- **Recommendation:** Perform a lightweight identity check (e.g. validate an expected Ollama response shape/header) before attaching, and surface attach vs spawn to the user.

---

## Positive Observations

- Spawning is `shell: false` with discrete argv throughout; `pull` additionally applies `assertSafeModelId` and a `--` end-of-options separator (strong argument-injection defence).
- `env` is built as a structured object, so the unvalidated `host` string cannot inject additional environment variables.
- The `ownedByUs` ownership rule correctly prevents `stop` from ever signalling an attached (foreign) daemon, and `ESRCH` is treated as an idempotent success.
- Readiness probing is fully bounded (per-request timeout + overall deadline + capped backoff), and the line buffer is capped against unbounded memory growth.
- Manifest resolution has layered path-traversal guards and digest verification fails closed; `npm audit` reports zero vulnerabilities.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                                  | Recommendation                                                                                                     |
| --- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | High     | Non-positive/reused pid reaches `process.kill` in `stop` | Reject `pid <= 0` at the kill boundary; never mint an owned handle without a real pid; fingerprint to resist reuse |
| 2   | High     | `serve` binds any host with no opt-in                    | Enforce loopback allow-list; require explicit `allowNonLoopback`/`--host` opt-in; validate host charset            |
| 3   | Low      | No SIGKILL escalation, kill not awaited                  | Escalate to SIGKILL after a grace period; await exit                                                               |
| 4   | Low      | Full env inheritance into daemon                         | Set safe defaults for `OLLAMA_ORIGINS`/`OLLAMA_MODELS` or pass a curated env allow-list                            |
| 5   | Low      | Attach trusts any port listener                          | Verify daemon identity before attaching                                                                            |
