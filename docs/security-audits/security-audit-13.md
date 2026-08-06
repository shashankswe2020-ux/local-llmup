# Security Audit Report #13

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Uncommitted B11 changes — the `doctor` command's offline **backends
> section**. New child-process version probe and untrusted version-string
> handling: [src/backend/adapter.ts](../../src/backend/adapter.ts) (optional
> `version()` on `BackendAdapter`), [src/backend/ollama.ts](../../src/backend/ollama.ts)
> (`OllamaAdapter.version` + `parseVersion`), [src/backend/select.ts](../../src/backend/select.ts)
> (exported `autoDetectPriority`), and [src/commands/doctor.ts](../../src/commands/doctor.ts)
> (`probeBackends` / `probeVersion` / `probeInstalled` / `renderBackends` + the
> `BackendInfo` type). Diffed against the existing `shell:false` spawn posture in
> `runProcess`/`isInstalled` and the `stripControl` sanitizer.
> **Dependencies:** `npm audit` reports **6 vulnerabilities (2 critical, 1 high,
> 3 moderate)** — all in the **dev-only** `vitest`/`vite`/`esbuild` closure, none
> in the shipped runtime deps (`cac`, `zod`, `systeminformation`). Pre-existing,
> unchanged by B11 (see INFO-1).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 2 |

**Verdict:** The B11 change is well-constructed and defensively coded. The four
attack surfaces called out in the brief — command injection, terminal-escape
injection, output DoS, and the offline invariant — are each handled correctly.
Command injection is structurally impossible (`shell:false` + a hardcoded binary
+ a discrete `["--version"]` arg array with no user input). Untrusted version
output is `stripControl`-sanitized **at the source** (`probeVersion`) before it
is stored in `BackendInfo`, so both the JSON and the rendered-table emit paths
are clean, and a dedicated test proves it. Output is bounded on three axes (line
cap, buffer cap, length slice) and the semver regex is ReDoS-safe. No probe can
flip `ok` or abort the health check. The only findings are two defense-in-depth
LOWs: the spawn has no timeout (a **hung** binary — not a throwing one — can wedge
`doctor`), and `parseVersion` delegates sanitization to its caller by contract
rather than at the source.

---

## Findings

### [LOW-1] Version/install probes have no timeout — a hung backend binary wedges `doctor`

- **Location:** [src/backend/ollama.ts](../../src/backend/ollama.ts) — `version()` (calls `runProcess(this.spawn, this.binary, ["--version"], { onLine })` with **no** `signal`); same pattern pre-exists in `isInstalled()`.
- **Description:** `version()` and `isInstalled()` spawn `ollama --version` and resolve on the child's `close` event. Neither passes an `AbortSignal`/timeout. `runProcess` only ever resolves via `child.onClose` (or rejects via `onError`); it has no deadline. If the spawned binary **hangs** — never exits, never emits a newline — the returned promise never settles. The `try/catch` around the probe cannot catch a hang (there is no error to throw), so `probeBackends`'s `await Promise.all(...)` never resolves and `runDoctor` blocks forever.
- **Impact:** Availability only. This directly contradicts the change's stated invariant that "no probe can … abort the health check" — a hang is worse than an abort because it silently wedges the command with no verdict and no exit code, defeating `doctor` as a CI/script gate. In-scope trigger is a **stuck real `ollama`** (e.g., a wedged install), not just a hostile binary. (A *malicious* planted binary on `PATH` is out of scope: whoever can plant it already has local code execution via `pull`/`serve`, so a hang is not an escalation.)
- **Proof of concept:** Place an executable named `ollama` earlier on `PATH` that does `sleep infinity` (or `read`), then run `local-llmup doctor`. The command hangs indefinitely with no output past the checks table; CI never gets an exit code.
- **Recommendation:** Give the probes the same bounded deadline the reachability check already uses (`REACHABILITY_TIMEOUT_MS = 1500`). Thread an `AbortSignal` with a timeout into `runProcess` and kill the child on expiry, e.g.:
  ```ts
  async version(): Promise<string | null> {
    const lines: string[] = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), VERSION_PROBE_TIMEOUT_MS);
    try {
      const code = await runProcess(this.spawn, this.binary, ["--version"], {
        signal: ac.signal,
        onLine: (line) => { if (lines.length < 8) lines.push(line); },
      });
      if (code !== 0) return null;
    } catch {
      return null; // AbortError → null, exactly like any other failure
    } finally {
      clearTimeout(timer);
    }
    return parseVersion(lines.join(" "));
  }
  ```
  Apply the same treatment to `isInstalled()`. (`runProcess`/`defaultSpawn` already accept and forward `options.signal` to `nodeSpawn`, so an aborted signal terminates the child — the plumbing is present and unused here.)

### [LOW-2] `parseVersion` returns un-sanitized output — sanitization is a caller contract, not a source guarantee

- **Location:** [src/backend/ollama.ts](../../src/backend/ollama.ts) — `parseVersion()` / `OllamaAdapter.version()`.
- **Description:** `version()` returns `parseVersion(lines.join(" "))` **without** applying `stripControl`. The fallback branch (`output.trim().slice(0, 100)`) can carry ANSI/C0/C1/BiDi bytes; only the semver branch is intrinsically clean (its character class cannot contain control/escape codepoints). The value is scrubbed **downstream** in `doctor`'s `probeVersion` (`stripControl(raw)`) before it is stored in `BackendInfo`, and both the interface JSDoc and `parseVersion`'s comment document "callers `stripControl` before display." Today `doctor` is the only caller and it honors the contract, so there is no live vulnerability — this is a latent, defense-in-depth risk.
- **Impact:** None currently. The exposure is future-tense: any new consumer that calls `adapter.version()` and prints/logs the result directly (e.g., an `up`/`ls` banner or a new command) without re-applying `stripControl` would reintroduce terminal-escape / Trojan-Source (BiDi) injection from an untrusted binary's `--version` banner.
- **Proof of concept:** Given a hypothetical future `write(\`ollama ${await adapter.version()}\`)`, a binary printing `0.0.0\u001b]0;pwned\u0007` (or an RLO BiDi override) would smuggle escapes/BiDi to the terminal.
- **Recommendation:** Sanitize at the trust boundary so safety does not depend on every caller remembering. Since `parseVersion` already knows the value is untrusted, wrap its return in `stripControl` (importing the shared sanitizer), making the adapter contract "returns display-safe or null." `doctor`'s second `stripControl` then becomes a harmless idempotent belt-and-suspenders. This is the same "sanitize at the source, not at each call site" principle the `sanitize.ts` module header already states.

---

## Positive Observations

- **Command injection is structurally impossible.** `version()` spawns via the existing `runProcess` → `defaultSpawn`, which calls `nodeSpawn(command, [...args], { shell: false })`. The binary is a hardcoded constant (`OLLAMA_BINARY = "ollama"`), the argument list is a discrete literal array `["--version"]`, and **no user- or catalog-controlled string reaches the command or args**. There is no shell, no interpolation, and no attacker-influenced token — the primary concern in the brief is fully mitigated.
- **Untrusted version output is sanitized at the source of the report.** `doctor`'s `probeVersion` applies `stripControl` to the adapter's return value *before* it is placed in `BackendInfo.version`. Because sanitization happens at storage time (not at render time), **every** downstream emit path inherits the clean value: the `--json` path (`JSON.stringify(report)`) and the human table (`renderBackends`) both serialize the already-scrubbed field. The dedicated test `passes hostile version strings through stripControl` proves `0.3.14\u001b[31m\u0007evil` becomes `0.3.14evil` and that stdout contains neither the ESC nor the BEL byte — covering exactly the "is stripControl applied everywhere, including JSON?" question.
- **Output DoS is bounded on three independent axes.** (1) `version()` stores at most 8 lines (`if (lines.length < 8) lines.push(line)`); (2) `lineConsumer` caps the un-newlined buffer to `MAX_LINE_BUFFER_BYTES` (64 KiB); (3) `parseVersion` truncates the fallback to `slice(0, 100)`. Peak transient memory for a hostile stream is ~1 MiB, and the stored version is ≤100 chars.
- **The version regex is ReDoS-safe.** `/\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/` runs once (non-global `exec`) with no nested or overlapping quantifiers and a single trailing `+` inside an optional group — worst-case linear in input length, so even a ~1 MiB `lines.join(" ")` is safe.
- **Full failure isolation; informational-only.** `probeInstalled` maps any throw to `false`; `probeVersion` maps any throw/`null` to `null`; both are gathered under `Promise.all` inside `probeBackends`, which itself feeds only `report.backends` (never the `ok`/exit contract, which the separate `backend` check owns). A broken probe degrades one row to `unknown`/`no` without hiding the others or flipping the verdict — consistent with the project's honesty gate.
- **Offline invariant preserved.** `version()`/`isInstalled()` are local binary spawns with no `fetch`; `probeBackends`, `autoDetectPriority`, and hardware detection make no network calls. The determinism guard for advice commands (`recommend`/`can-run`) is untouched. (See INFO-2 for the one loopback nuance.)
- **`autoDetectPriority` export is a pure refactor.** `select.ts` merely renames/exports the previously-private `autoPriority` and re-points its two internal callers; behavior (the Apple-Silicon `mlx > ollama > llamacpp` ordering, LM Studio's deliberate exclusion) is byte-for-byte identical. No new decision surface.

---

## Info / Out-of-Scope Notes

### [INFO-1] Dev-only dependency advisories (unchanged, out of scope for B11)
`npm audit` reports 6 advisories (2 critical, 1 high, 3 moderate) across
`vitest`, `@vitest/coverage-v8`, `@vitest/mocker`, `vite`, `vite-node`, and
`esbuild`. These are **devDependencies** only — they are absent from the shipped
runtime closure (`cac`, `zod`, `systeminformation`) and never execute on an
end-user machine. They predate B11 and are tracked in prior audits (see Audit #6
[LOW-3]). No production remediation is required for this task; schedule the
`vitest@4` upgrade (`npm audit fix --force`, a breaking change) as separate
maintenance with a full test re-run.

### [INFO-2] `ollama --version` may touch the loopback server (still "offline")
The real `ollama --version` prints the client version and *also* attempts to
contact a locally-running Ollama server to report the server version. That is a
**loopback** (`127.0.0.1:11434`) connection, not external network egress, so the
project's offline invariant for advice determinism (no outbound/reproducibility-
affecting network calls) holds. The version probe influences only the
informational backends table, never `recommend`/`can-run` output. Noted so a
future reader does not mistake the local socket attempt for a network call.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | LOW-1: probes have no timeout — a hung binary wedges `doctor` | Thread an `AbortSignal` + `~1.5s` timeout into `version()` and `isInstalled()` via the already-plumbed `options.signal`; treat `AbortError` as `null`/`false` |
| 2 | Low | LOW-2: `parseVersion` returns un-sanitized output (caller contract) | Apply `stripControl` at the source so `adapter.version()` is display-safe by construction; `doctor`'s scrub becomes idempotent belt-and-suspenders |
| — | Info | INFO-1: dev-only `vitest`/`vite`/`esbuild` CVEs | Track separately; not shipped, not runtime — schedule `vitest@4` upgrade as maintenance |
| — | Info | INFO-2: `ollama --version` loopback socket | No action; documents that the local socket attempt is not external network egress |
