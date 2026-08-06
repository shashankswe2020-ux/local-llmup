# Security Audit Report #17

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** Task B14b — `LlamaCppAdapter` serve / waitUntilReady / stop lifecycle
> (preflight / identity / readiness / kill helpers + fetch/sleep/kill seams).
> Files audited (uncommitted working tree only):
> - `src/backend/llamacpp.ts` (MODIFIED — lifecycle + helpers)
> - `src/backend/adapter.ts` (MODIFIED — added optional `modelPath?: string` to `ServeOptions`)
> - `tests/backend/llamacpp.test.ts` (MODIFIED — lifecycle tests + fakes)
> **Dependencies:** `npm audit --omit=dev` reports **0 vulnerabilities** in the
> runtime deps (`cac`, `zod`, `systeminformation`). The dev-toolchain
> (`vitest`/`vite-node`) advisories noted in prior audits are out of scope for
> this slice.
> **Test status:** full suite 841 tests passing.

---

## Overall Risk: LOW

No exploitable vulnerability was found in the B14b slice. All four headline
invariants hold and are fail-closed:

1. **Loopback-only bind** — enforced *before* any spawn by a lexical
   `isLoopbackBindHost` check whose every edge case resolves in the *refuse*
   direction; `allowNonLoopback` is the only escape.
2. **`shell:false` discrete-arg execution** — `spawn(binary, args, {})` with
   `shell:false` and `modelPath` interpolated as a separate `-m` value arg; no
   shell metacharacter or flag-injection surface via string concatenation.
3. **Fail-closed attach** — a `/props` identity check gates attach; a trusted
   llama-server is attached read-only (`ownedByUs:false`), a foreign listener is
   refused with `BackendError`, and only a free port leads to an owned spawn.
4. **Safe kill** — `stop` signals only `ownedByUs` processes, refuses
   non-positive pids, treats `ESRCH` as idempotent success, and refuses to kill
   when the recorded endpoint is unreachable (pid-reuse guard).

The three Low findings are defence-in-depth hardening, not live vulnerabilities;
each requires either an already attacker-controlled local process on the target
port or attacker-controlled state-file contents (i.e. same-user local access,
which is already the trust boundary of a loopback, unauthenticated CLI). The two
Info notes document inherent limits of the unauthenticated-loopback model.

Also confirmed: audit-16 **LOW-1** (`isInstalled()` was not abort/timeout-bounded)
is **resolved** in the current tree — `isInstalled()` now arms an
`AbortController` with `VERSION_PROBE_TIMEOUT_MS` ([src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L268-L288)).

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 3 |
| Info | 2 |

---

## Invariant Verification

### 1. Loopback-only bind — HOLDS ✓ (fail-closed)

`isLoopbackBindHost` ([src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L215-L229)) strips a single `[...]` bracket pair, lowercases, then accepts only `localhost`, `::1`, or `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`. `serve` calls it *before* the preflight and any spawn ([L422-L427](../../src/backend/llamacpp.ts#L422-L427)); a non-match throws `ValidationError` unless `allowNonLoopback` is set. The requested bypass vectors all resolve to **refuse** (fail-closed), and none allow a *non-loopback* address to masquerade as loopback:

| Input | Result | Direction |
|-------|--------|-----------|
| `0x7f.0.0.1` | regex requires decimal `\d` → no match → **refused** | safe (fail-closed) |
| `127.1` | regex requires 4 octets → no match → **refused** | safe (a real loopback form, but refused, not exposed) |
| `LOCALHOST` / `127.0.0.1` uppercase | `.toLowerCase()` normalises → accepted / accepted | correct |
| `127.0.0.1.` (trailing dot) | `$` anchor after 4th octet → no match → **refused** | safe (fail-closed) |
| `::ffff:127.0.0.1` (IPv4-mapped IPv6) | not `::1`, not `127.x` → **refused** | safe (fail-closed) |
| `[::1]` | bracket-stripped → `::1` → accepted | correct |
| `127.255.255.255` | in-range 127/8 loopback → accepted | correct |

No non-loopback interface address (`0.0.0.0`, a LAN IP, a public IP) passes the check. The regex admits syntactically-invalid octets (`127.999.0.1`), but such an address fails at OS bind time — it never binds a routable interface — so it is not a loopback-escape. The test suite asserts `0.0.0.0` is refused with zero spawn calls ([tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L265-L275)). The `allowNonLoopback` opt-in is the sole documented escape and is `false` by default.

### 2. Process-execution safety — HOLDS ✓ (see LOW-1 for residual)

`serve` builds `args = ["-m", modelPath, "--host", host, "--port", String(port)]` ([L461](../../src/backend/llamacpp.ts#L461)) and calls `this.spawn(this.binary, args, {})`; `defaultSpawn` sets `shell: false` explicitly and spreads args into a fresh array ([L88-L110](../../src/backend/llamacpp.ts#L88-L110)). `modelPath` is a *separate array element* (the value of `-m`), never concatenated into a command string, so no shell metacharacter or space in the path can inject additional flags, commands, or a subshell. `port` is stringified from a number and range-validated in `buildEndpoint`. The test asserts the exact arg array ([tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L296-L322)). The residual (a leading-dash path being *parsed* as a flag by `llama-server` rather than consumed as the `-m` value) is documented as **LOW-1**.

### 3. Fail-closed attach + no SSRF — HOLDS ✓

`probeAttachTarget` ([L631-L639](../../src/backend/llamacpp.ts#L631-L639)) returns `unreachable | trusted | untrusted`. `serve` attaches (read-only, `ownedByUs:false`, `pid:0`) only on `trusted`, throws `BackendError` on `untrusted`, and spawns only when the port is free ([L437-L462](../../src/backend/llamacpp.ts#L437-L462)). Trust requires a `2xx` `/props` whose JSON matches the llama-server fingerprint (`isLikelyLlamaServerProps`, [L297-L307](../../src/backend/llamacpp.ts#L297-L307)); a non-2xx, non-JSON, or wrong-shape response yields `untrusted` → refused. Foreign-listener refusal is tested ([tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L286-L294)).

**SSRF:** every fetch target is `buildEndpoint(host, port)` where `host` has already passed the loopback gate (or an explicit opt-in) and `port` is range-checked; paths are fixed constants (`/props`, `/health`, `/v1/models`). No request URL is derived from a network response, catalog value, or unvalidated user input, so there is no attacker-steerable request target. The identity-body-read is time-bounded but not byte-bounded (see **LOW-2**).

### 4. Safe kill — HOLDS ✓ (see LOW-3 for residual)

`stop` ([L560-L620](../../src/backend/llamacpp.ts#L560-L620)):
- Returns immediately for `!ownedByUs` (attached servers never signalled) — tested ([tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L367-L379)).
- `isUsablePid` ([L237-L239](../../src/backend/llamacpp.ts#L237-L239)) rejects `pid <= 0`, non-integers, and `undefined`, so `kill(0)`/`kill(-n)` process-group signalling is impossible — tested ([tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L381-L389)).
- Pid-reuse guard: if the recorded endpoint is *unreachable*, it probes `kill(pid, 0)`; a live pid → refuse to kill (`BackendError`), `ESRCH` → idempotent success — tested ([tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L410-L419)).
- Escalation `SIGTERM` → poll `kill(pid,0)` → `SIGKILL` → poll, with `ESRCH` short-circuiting to success at every step.

### 5. Readiness DoS bounds — HOLDS ✓ (see LOW-2 for one gap)

`waitUntilReady` ([L508-L556](../../src/backend/llamacpp.ts#L508-L556)) bounds each attempt by `min(READINESS_REQUEST_TIMEOUT_MS=5s, remaining-deadline)` via a per-request `AbortController`, caps total time at `timeoutMs` (default 30s), caps attempts at `retries` (default 20), and backs off with capped exponential delay. A hung/hostile local listener cannot block indefinitely: the abort fires at ≤5s per request and the overall deadline terminates the loop. Readiness bodies are not read at all (`probeReady` checks only `response.ok`, [L659-L688](../../src/backend/llamacpp.ts#L659-L688)). The one unbounded read is the `/props` identity body (**LOW-2**), which is time-bounded (5s abort) but not byte-bounded.

### 6. No secrets / no non-loopback network / no fs writes — HOLDS ✓

- No credentials, tokens, or env reads (beyond `process.platform`) in the slice.
- All network I/O targets the loopback endpoint; scheme is plaintext `http://` by design (loopback-only, spec §8).
- `serve`/`waitUntilReady`/`stop` perform **no filesystem writes** — runtime state (pid/endpoint/ownership) is persisted by the caller via the state module, not the adapter.
- **`modelPath` addition does not weaken Ollama:** `modelPath?` is an *optional* field on `ServeOptions` ([src/backend/adapter.ts](../../src/backend/adapter.ts#L64-L71)); daemon backends that serve from a shared store ignore it. The Ollama adapter is unchanged and reads no new field, so its loopback/attach behaviour is unaffected. Purely additive, backward-compatible.

---

## Findings

### [LOW-1] `modelPath` is spawned without leading-dash / path validation (flag-injection residual)

- **Location:** `src/backend/llamacpp.ts:454-461` (`serve` — `const modelPath = options?.modelPath?.trim()` → `const args = ["-m", modelPath, ...]`)
- **Description:** `serve` validates only that `modelPath` is non-empty after trimming; it does not verify the value is a plausible filesystem path (absolute, no leading `-`, exists). Because the spawn is `shell:false` with a discrete arg array, a path cannot inject a *shell* command. The residual is argument-parser dependent: if `modelPath` begins with `-` (e.g. `--verbose`, `-ngl`), `llama-server` may interpret it as a *flag* rather than the value of `-m`, depending on its option parser. llama.cpp's parser consumes the token after `-m` as the value, so exploitation is unlikely — but the code does not guarantee it.
- **Impact:** In B14b the model path originates from the trusted pull/cache path, not raw user input, so real-world exploitability is very low. If a future caller ever forwarded a user- or catalog-derived path unvalidated, a crafted leading-dash value could alter server flags (e.g. change GPU-layer count or enable an endpoint), not achieve code execution.
- **Proof of concept:** N/A for a confirmed exploit (parser-dependent). Defence-in-depth hardening.
- **Recommendation:** Reject a `modelPath` that begins with `-` and require an absolute path, before building the arg array:

  ```ts
  const modelPath = options?.modelPath?.trim();
  if (modelPath === undefined || modelPath.length === 0) {
    throw new BackendError(`refusing to serve ${endpoint}: no model path was provided`);
  }
  if (modelPath.startsWith("-") || !isAbsolute(modelPath)) {
    throw new BackendError(`refusing to serve ${endpoint}: model path must be an absolute path`);
  }
  ```

  This mirrors the forward-looking note recorded in audit-16 (§Invariant 1) for when user-controlled model paths land. An explicit existence check (`fs.stat`) is optional; the leading-dash guard is the material one.

### [LOW-2] `/props` identity body read is not byte-bounded

- **Location:** `src/backend/llamacpp.ts:679` (`isLikelyLlamaServer` — `return isLikelyLlamaServerProps(await response.json())`)
- **Description:** The attach identity check awaits `response.json()` on the `/props` response with no size cap. The readiness paths (`probeReady`) never read a body, and the `--version` probe caps output at 8 KiB (`VERSION_CAPTURE_MAX_BYTES`), but this JSON read has no equivalent ceiling. A hostile process squatting on the target loopback port could return an enormous (or slowly-streamed) `/props` body.
- **Impact:** Bounded denial-of-service. The read is time-bounded — the enclosing `AbortController` fires at `requestTimeoutMs` (5s) and aborts the in-flight body stream — so it cannot hang forever, but up to ~5s of loopback-speed data can be buffered into memory per attach attempt. The attacker must already be a local process listening on the port (same-user trust boundary), which can DoS the machine by other means; hence Low.
- **Proof of concept:** Run a local HTTP server on port 8080 that answers `GET /props` with `Content-Type: application/json` and streams multi-hundred-MB of `{"total_slots":1,...` padding for ~5s; call `serve({ port: 8080, modelPath })`. The adapter buffers the body until the 5s abort.
- **Recommendation:** Bound the identity read the way the version probe is bounded — read a capped prefix and parse that, instead of `response.json()`:

  ```ts
  const text = (await response.text()).slice(0, IDENTITY_BODY_MAX_BYTES); // e.g. 64 KiB
  try {
    return isLikelyLlamaServerProps(JSON.parse(text));
  } catch {
    return false;
  }
  ```

  (A streaming reader that stops after N bytes is stronger still, but a capped `text()` + `JSON.parse` is a proportionate fix given the 5s abort already caps duration.)

### [LOW-3] `stop` liveness guard checks endpoint reachability, not pid↔endpoint binding

- **Location:** `src/backend/llamacpp.ts:574` (`stop` — `if (!(await this.isReachable(handle.endpoint, undefined)))`)
- **Description:** The pid-reuse guard treats a *reachable* recorded endpoint as sufficient proof that `handle.pid` is still our server, then proceeds to `SIGTERM`/`SIGKILL` that pid. It does not verify that `handle.pid` is the process actually bound to the endpoint. Two conditions must coincide to misfire: (a) our original server died *and* its pid was reused by an unrelated process, and (b) *some* listener is now answering on the recorded port (a restarted llama-server, or any other service). Under both, `isReachable` returns true and the guard signals the reused, unrelated pid. The guard closes the common "endpoint down + pid reused" case but not "endpoint back up under a different process + pid reused."
- **Impact:** Termination of an unrelated same-user process. Requires pid reuse *and* port reoccupation *or* an attacker who can write `state.json` (pid + endpoint round-trip through the untrusted state file). A caller who can write the state file already runs as the same user and can `kill` arbitrary own processes directly, so this is defence-in-depth, not a privilege boundary crossing — hence Low.
- **Proof of concept:** Craft `state.json` with `ownedByUs:true`, `pid=<victim same-user pid>`, `endpoint=<any reachable local URL, e.g. a running server>`; run `down`. `stop` sees the endpoint reachable and sends `SIGTERM` to the victim pid.
- **Recommendation:** Before signalling, re-confirm identity/ownership rather than mere reachability — e.g. re-run the `/props` identity check on the endpoint (as attach does) so a *foreign* listener does not license a kill; and where the platform allows, confirm the pid owns the listening socket (e.g. `lsof -ti :<port>` / `ss -ltnp` on the recorded port) before escalating. At minimum, gate the kill on `probeAttachTarget(endpoint) === "trusted"` so a non-llama-server occupant of the port blocks the signal. Note there is no fully-portable pid→socket mapping without extra privilege; document the residual explicitly.

---

## Info / Best-Practice Notes

### [INFO-1] Attach identity check is spoofable by a co-located malicious local process

The `/props` fingerprint (`isLikelyLlamaServerProps`) is a *heuristic* shape match, not authentication. Any local process can trivially answer `/props` with `{"total_slots":1}` to be classified `trusted`, after which the adapter attaches and (in B14c) will send chat prompts to it. This is inherent to llama.cpp's unauthenticated loopback model: the trust boundary is "any process the same user can run on that port." The identity check correctly prevents *accidental* attach to a different legitimate local service; it is not, and cannot be, a defence against a deliberately malicious same-user impersonator. Acceptable under the documented threat model — worth a one-line comment at the `isLikelyLlamaServer` call site so future readers do not over-trust it.

### [INFO-2] `isLoopbackBindHost` is a lexical check; `localhost` trust depends on the hosts file

The loopback gate is explicitly a lexical check on the bind string, not a resolution. `localhost` is accepted on the assumption it maps to `127.0.0.1`/`::1`; a tampered `/etc/hosts` could remap it, but editing that file already requires root/admin (prior local compromise), so this is not a practical bypass. No action required; documenting the assumption for completeness. The check's fail-closed behaviour on all ambiguous forms (see Invariant 1 table) is the right default.

---

## Positive Observations

- **Fail-closed everywhere it matters:** the loopback gate, the attach preflight, and the kill guard all default to *refuse/throw* on any ambiguity, and every one of these paths is covered by a test asserting **zero side effects** (no spawn, no kill).
- **Clean seam injection:** `spawn`/`fetch`/`sleep`/`kill` are all injectable, so the lifecycle is tested without touching a real `llama-server`, a real socket, or a real signal — the tests never spawn a process or hit the network.
- **Orphan-safe spawn:** on any readiness failure the spawned child is torn down via `stopSpawnedChild` (TERM→KILL), and early `error`/`close` events are observed so a crashing server short-circuits the wait and cannot leak as an unhandled `'error'` or an orphan.
- **Request-scoped abort correctly *not* propagated to the persistent child:** the caller's signal is deliberately withheld from the long-lived server spawn, with ownership of shutdown handed to `stop`/state — a subtle correctness/safety detail done right.
- **Prior finding resolved:** audit-16 LOW-1 (`isInstalled()` unbounded probe) is fixed — it is now abort-bounded identically to `version()`.
- **Additive, non-regressive interface change:** `modelPath?` is optional and ignored by daemon backends; Ollama is untouched.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | LOW-1 — `modelPath` flag-injection residual | Reject leading-dash / non-absolute `modelPath` before building the arg array |
| 2 | Low | LOW-2 — unbounded `/props` identity body read | Cap the identity read (`text().slice(cap)` + `JSON.parse`) like the version probe |
| 3 | Low | LOW-3 — kill guard checks reachability, not pid↔endpoint | Gate the kill on a re-run `/props` identity (`trusted`) and, where portable, pid→socket confirmation |
| 4 | Info | INFO-1 — spoofable attach heuristic | Add a comment noting the identity check is not authentication |
| 5 | Info | INFO-2 — lexical loopback check | Document the `localhost`/hosts-file assumption |

---

## Verdict

The **loopback-only**, **`shell:false` arg-array**, **fail-closed-attach**, and
**safe-kill** invariants all **hold**. No Critical/High/Medium issues. The three
Low findings are proportionate defence-in-depth improvements for a
same-user/local threat boundary; none blocks the slice. Recommend addressing
LOW-1 and LOW-2 in the current slice (both are small, self-contained edits) and
scheduling LOW-3 alongside the B14c chat path, where attach trust is exercised.
