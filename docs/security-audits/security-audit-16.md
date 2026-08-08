# Security Audit Report #16

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** Task B14a — `LlamaCppAdapter` descriptor/install/registration skeleton. Files audited (uncommitted working tree only):
>
> - `src/backend/llamacpp.ts` (NEW)
> - `src/backend/registry.ts` (MODIFIED)
> - `tests/backend/llamacpp.test.ts` (NEW)
> - `tests/backend/registry.test.ts` (MODIFIED)
>   **Dependencies:** `npm audit` reports 6 vulnerabilities (3 moderate, 1 high, 2 critical) — all in the `vite-node`/`vitest` dev toolchain, none in the runtime deps (`cac`, `zod`, `systeminformation`). Out of scope for this slice; pre-existing and dev-only.

---

## Overall Risk: LOW

No exploitable vulnerability was found in the B14a slice. The command/process
execution seam is `shell:false` with discrete argument arrays and no
user-controlled input reaches it. The `version()` probe treats binary output as
untrusted (capped, abort-bounded, `stripControl`-clean). The offline-determinism
and `shell:false` invariants both hold. Two Low/Info observations are
defence-in-depth hardening, not live vulnerabilities; each requires an already
attacker-controlled binary on `PATH` (i.e. prior local compromise).

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 1     |
| Info     | 2     |

---

## Invariant Verification

### 1. `shell:false`, discrete args, no interpolation — HOLDS ✓

- `defaultSpawn` ([src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L59-L82)) calls `nodeSpawn(command, [...args], { shell: false, ... })`. `shell:false` is set explicitly; args are spread into a fresh array — no string concatenation, no shell metacharacter exposure.
- Every spawn in this slice passes the literal arg array `["--version"]` (isInstalled [L184](../../src/backend/llamacpp.ts#L184), version [L221-L227](../../src/backend/llamacpp.ts#L221-L227)). No user- or catalog-derived value reaches the spawn.
- Binary is the constant `LLAMA_SERVER_BINARY = "llama-server"` ([L33](../../src/backend/llamacpp.ts#L33)), resolved from `PATH`. The `options.binary` override exists only as a constructor test seam and is never wired to user input in this slice.
- No `--` end-of-options separator is present, but it is unnecessary here: the sole arg is a fixed flag and no positional/user data follows. (When user-controlled model paths land in B14b/B14c, an explicit `--` separator like Ollama's `pull` path should be added — flagged as a forward-looking note, not a current finding.)

### 2. `version()` treats output as untrusted — HOLDS ✓

- Output capped at `VERSION_CAPTURE_MAX_BYTES` (8 KiB) in `probe()` ([L112-L131](../../src/backend/llamacpp.ts#L112-L131)).
- Abort-bounded: `version()` arms an `AbortController` with a 1.5 s deadline and passes the signal through to the spawn, so a wedged binary cannot block `doctor` ([L215-L237](../../src/backend/llamacpp.ts#L215-L237)); the timer is always cleared in `finally`.
- `stripControl` is applied at the source before the value can reach a terminal ([L233](../../src/backend/llamacpp.ts#L233)), and `doctor`'s `probeVersion` applies `stripControl` a second time ([src/commands/doctor.ts](../../src/commands/doctor.ts#L112-L123)) — defence in depth. No ANSI/BiDi/control byte can escape to the terminal.
- `parseVersion` regexes ([L146-L165](../../src/backend/llamacpp.ts#L146-L165)) have no nested quantifiers over overlapping character classes; combined with the 8 KiB input cap there is no ReDoS exposure. The non-semver fallback is further length-bounded to `VERSION_BANNER_MAX_CHARS` (100).

### 3. Error handling never leaks — HOLDS ✓

- `wrapSpawnError` ([L85-L96](../../src/backend/llamacpp.ts#L85-L96)) maps `AbortError`/`ENOENT`/other onto typed `BackendError`.
- `isInstalled()` catches everything and returns `false` ([L179-L186](../../src/backend/llamacpp.ts#L179-L186)); `version()` catches everything and returns `null` ([L235](../../src/backend/llamacpp.ts#L235)). Raw spawn errors never surface in this slice.
- The unimplemented lifecycle methods reject with a static `"... is not implemented yet"` `BackendError` ([L282-L284](../../src/backend/llamacpp.ts#L282-L284)) carrying no untrusted data.

### 4. Offline-determinism invariant — HOLDS ✓

- Adding `LlamaCppAdapter` to `createDefaultRegistry()` ([src/backend/registry.ts](../../src/backend/registry.ts#L71-L75)) does **not** cause the advice path to probe `isInstalled()`. The registry constructor and `all()`/`get()` never probe; only `available()` does, and it is invoked solely behind the opt-in `--available-backends` branch in `runRecommend` ([src/commands/recommend.ts](../../src/commands/recommend.ts#L490-L494)). The default advice path never calls `available()`/`isInstalled()`, so output remains deterministic and network-free.
- `available()` isolates each probe in its own `try/catch` ([src/backend/registry.ts](../../src/backend/registry.ts#L58-L69)), so a broken llama.cpp probe cannot hide other backends or throw.

### 5. No secrets / no network / no fs writes — HOLDS ✓

- `llamacpp.ts` imports only `node:child_process`, `node:stream` (type), the local `BackendError`, `stripControl`, and type-only backend imports. No `fetch`, no `node:fs`, no credentials, no environment reads beyond `process.platform`. SSRF is N/A (no HTTP in this slice).

---

## Findings

### [LOW-1] `isInstalled()` probe is not abort/timeout-bounded

- **Location:** `src/backend/llamacpp.ts:183` (`isInstalled`) → `probe(this.spawn, this.binary, ["--version"], undefined, false)`
- **Description:** Unlike `version()`, `isInstalled()` passes `signal: undefined` and arms no timeout. A `llama-server` binary that never exits on `--version` (hung or hostile) causes `isInstalled()` to hang indefinitely, which in turn hangs `doctor` and the `--available-backends` path (both `await` the probe). `version()` correctly bounds this with a 1.5 s `AbortController`; `isInstalled()` does not. Note this mirrors the existing Ollama adapter's `isInstalled()` (`src/backend/ollama.ts:583`), so it is a consistent, pre-existing pattern rather than a regression introduced by B14a.
- **Impact:** Denial-of-service by hang on the `doctor` / `--available-backends` commands. Requires an attacker-controlled or defective binary named `llama-server` on `PATH` — i.e. the attacker already controls the local execution environment — so real-world exploitability is low.
- **Proof of concept:** Place a `llama-server` shim on `PATH` that runs `sleep infinity` (or `read`) on any argument; run `llmup doctor`. The command blocks forever with no timeout.
- **Recommendation:** Bound `isInstalled()` the same way `version()` is bounded — reuse the abort pattern (a short deadline, e.g. `VERSION_PROBE_TIMEOUT_MS`) so a wedged binary maps to `false` rather than hanging:

  ```ts
  async isInstalled(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_PROBE_TIMEOUT_MS);
    try {
      const { code } = await probe(
        this.spawn, this.binary, ["--version"], controller.signal, false,
      );
      return code === 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  ```

  Consider applying the same fix to the Ollama adapter for parity (separate change).

### [INFO-1] Capture cap is checked before append and counts UTF-16 code units, not bytes

- **Location:** `src/backend/llamacpp.ts:120-124` (the `onData` accumulator) and the `VERSION_CAPTURE_MAX_BYTES` constant at `:42`
- **Description:** The guard `if (text.length < VERSION_CAPTURE_MAX_BYTES) text += chunk;` tests the length _before_ appending, so a single chunk received while `text.length` is at 8 191 can push the buffer to ~8 191 + one chunk. Additionally, `text.length` is a JS string length (UTF-16 code units) while the constant is named `..._MAX_BYTES`, so for multi-byte output the true byte ceiling is higher than 8 KiB. Overall memory remains bounded (a Node child-process pipe emits chunks bounded by the stream `highWaterMark`, and `version()`'s 1.5 s abort caps total runtime), so there is no unbounded-memory / DoS risk — this is a precision/naming nit, not a live vulnerability.
- **Impact:** None exploitable; at most a few tens of KiB of transient memory before the abort fires.
- **Recommendation:** For clarity, either (a) check the cap after computing the prospective length and truncate the appended slice, or (b) rename the constant to `VERSION_CAPTURE_MAX_CHARS` to match the `text.length` semantics. Example:

  ```ts
  const onData = (chunk: string): void => {
    if (text.length >= VERSION_CAPTURE_MAX_CHARS) return;
    text += chunk.slice(0, VERSION_CAPTURE_MAX_CHARS - text.length);
  };
  ```

### [INFO-2] Dev-toolchain dependency vulnerabilities (out of scope, noted for tracking)

- **Location:** `node_modules/vite-node` (via `vitest`)
- **Description:** `npm audit` reports 6 vulnerabilities (3 moderate, 1 high, 2 critical) in the test toolchain. None are in the three runtime dependencies (`cac`, `zod`, `systeminformation`) and none are reachable from shipped code. Unrelated to B14a.
- **Recommendation:** Address in a dedicated dependency-maintenance change (`npm audit fix` / bump `vitest`), tracked separately from this slice. Do not couple to B14a.

---

## Positive Observations

- **Untrusted-output discipline is exemplary.** `version()` caps captured output, abort-bounds the probe, and `stripControl`s at the source — then `doctor` `stripControl`s again. Trojan-Source / ANSI / control-byte injection from a hostile `--version` banner is genuinely closed off, with defence in depth.
- **`shell:false` with discrete arg arrays** is enforced in the single `defaultSpawn` seam, and no user-controlled data reaches the spawn in this slice. Injection surface is effectively nil.
- **Offline-determinism invariant is respected by construction:** registration does not probe, and `isInstalled()` is reached only through the opt-in `available()` path. The comment at `recommend.ts:489-490` documents the invariant at the call site.
- **Fail-safe error mapping:** every spawn/child failure funnels through `wrapSpawnError` into a typed `BackendError`, and both probes swallow failures into safe sentinels (`false`/`null`) rather than leaking raw errors or crashing.
- **Honest capability declaration:** `canEmbed: false` with an inline rationale avoids fabricating an embedding endpoint that isn't enabled — consistent with the project's honesty gate.
- **Process seam is injectable**, so tests never spawn a real `llama-server` (827 tests passing, network/fs/child-process fully mocked).

---

## Action Items (Priority Order)

| #   | Severity | Finding                                                                            | Recommendation                                                                                                        |
| --- | -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Low      | [LOW-1] `isInstalled()` unbounded probe can hang `doctor` / `--available-backends` | Wrap the `--version` probe in an `AbortController` deadline (mirror `version()`); consider same fix for Ollama parity |
| 2   | Info     | [INFO-1] Capture cap off-by-one-chunk + byte/char naming mismatch                  | Truncate the appended slice and/or rename `VERSION_CAPTURE_MAX_BYTES` → `..._MAX_CHARS`                               |
| 3   | Info     | [INFO-2] Dev-toolchain CVEs in `vite-node`/`vitest`                                | Fix in a separate dependency-maintenance change                                                                       |

---

## GitHub Issues

Per the audit request, GitHub issues were **not** created. Pausing for confirmation before opening issues for the findings above.
