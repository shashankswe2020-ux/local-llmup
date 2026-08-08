# Code Review Checkpoint 1: Task T18 (`up` command)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T18 — the `up` command (resolve → disk preflight → ensure backend → pull+verify → serve → health → state write), plus the `ServerState.pid` schema relaxation and CLI wiring.
> **Test suite:** 300 tests passing (22 files), typecheck clean, build clean, lint clean.

---

## Verdict: ✅ APPROVE (with follow-ups)

**Overview:** The `up` command is well-structured, fully dependency-injected, and meets every T18 acceptance criterion (correct ordering, 127.0.0.1 bind, injectable disk preflight, install-hint on missing backend, attached-daemon persistence). Ordering, stdout/stderr routing, and control-character sanitization are all correct. No Critical issues. Several Important follow-ups concern the `pid: 0` sentinel design, cleanup on a state-write failure, port-range validation, and module-load side effects. None block merge, but each should be tracked.

---

## Critical Issues

None.

---

## Important Issues

### 1. `pid: 0` sentinel conflates "attached" with "unknown pid" and the schema no longer enforces the `ownedByUs` ⇄ `pid` invariant

- **File:** `src/state/state.ts` (`ServerStateSchema`), `src/commands/up.ts:~110` (`active` construction)
- **Problem:** Relaxing `pid` to `nonnegative()` lets a positive-or-zero pid mean two different things: "a real signalable pid" or "attached, pid unknown." The correlation that guarantees safety (`ownedByUs === false ⟺ pid === 0`) is a documented convention, not a type/schema invariant. The schema still accepts contradictory states such as `{ ownedByUs: true, pid: 0 }` and `{ ownedByUs: false, pid: 12345 }`. This matters because `process.kill(0, sig)` on POSIX targets the **entire process group** — a catastrophic no-op-turned-footgun if any future caller signals on pid alone. Today the `down`/`stop` guards (`ownedByUs && pid > 0`) prevent this, but nothing structurally stops a future path from regressing.
- **Fix:** Model the attached case without a fake pid. Prefer a discriminated union so illegal states are unrepresentable:
  ```ts
  const ServerStateSchema = z.discriminatedUnion("ownedByUs", [
    z.object({ ownedByUs: z.literal(true), pid: z.number().int().positive() /* ...*/ }).strict(),
    z.object({ ownedByUs: z.literal(false) /* no pid */ /* ...*/ }).strict(),
  ]);
  ```
  Or, minimally, make `pid` optional (`pid?: z.number().int().positive()`, present only when owned) and drop the `0` sentinel. Either removes the group-kill footgun by construction.

### 2. Owned server is orphaned if `withLock`/`writeState` fails after a successful `serve` + health check

- **File:** `src/commands/up.ts:~112-118`
- **Problem:** The health-failure path correctly calls `deps.adapter.stop(handle)`, but the state-write path has no equivalent guard. If `withLock` fails to acquire (`StateError`) or `writeState` throws (disk full, permissions, validation), the just-started **owned** daemon keeps running while no state file records it — so `down` can never find or stop it. This is an orphaned-process leak and an inconsistency with the health-failure cleanup.
- **Fix:** Wrap the persistence step and tear down an owned handle on failure:
  ```ts
  try {
    await deps.withLock(deps.config, () => {
      deps.writeState(deps.config, { schemaVersion: STATE_SCHEMA_VERSION, active });
    });
  } catch (error) {
    await deps.adapter.stop(handle); // no-op for attached; cleans up owned
    throw new StateError(`failed to persist state for ${model.id}`, { cause: error });
  }
  ```

### 3. Missing port-range validation at the CLI boundary

- **File:** `src/cli.ts` (`registerUp` action)
- **Problem:** The guard only checks `Number.isInteger(port)`. Integer-but-out-of-range values pass: `Number("0") === 0`, `Number("-1") === -1`, `Number("70000") === 70000`. These flow straight into `adapter.serve({ port })` **before** the state schema (which enforces `min(1).max(65535)`) ever sees them. Port `0` in particular causes the OS to assign an ephemeral port, producing a confusing endpoint mismatch, and a server is started before the invalid value is rejected.
- **Fix:** Validate the range at the boundary, before `runUp`:
  ```ts
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    process.stderr.write(`up: invalid --port ${JSON.stringify(options.port)}\n`);
    process.exitCode = 1;
    return;
  }
  ```

### 4. Module-load side effects in `defaultDeps` run on every CLI invocation

- **File:** `src/commands/up.ts:~40-49` (`const defaultDeps`)
- **Problem:** `defaultDeps` is a module-level constant, so `loadConfig()` and `new OllamaAdapter()` execute at import time. Because `cli.ts` imports `runUp` unconditionally, these run for **every** command (`--help`, `recommend`, etc.), not just `up`. If `loadConfig()` throws (missing/unwritable home, bad env), the entire CLI fails to start with an import-time error that is harder to route through the `up:`/command error handler.
- **Fix:** Make the defaults lazy — resolve them inside `runUp` only when `deps` is omitted, e.g. a `makeDefaultDeps()` factory called with `deps = arg ?? makeDefaultDeps()`, or default the individual fields lazily. This keeps import side-effect-free and preserves DI.

---

## Minor Issues

### 1. Explicit quant bypasses the memory-fit check

- **File:** `src/commands/up.ts` (`chooseQuant` + disk preflight)
- **Problem:** When `resolved.quant` is provided, `chooseQuant` returns it without calling `evaluateFit`, so only the **disk** preflight runs afterward. A user-forced quant that fits on disk but exceeds RAM/VRAM proceeds to pull and serve with no warning. The auto path (via `evaluateFit`, which checks memory+disk) is protected; the explicit path is not.
- **Recommendation:** Even if forcing is intentional, emit a stderr warning when an explicitly requested quant fails the memory fit, so users aren't surprised by a model that pulls but runs poorly.

### 2. Double readiness wait can tear down a healthy owned daemon on a transient blip

- **File:** `src/commands/up.ts:~100-108`
- **Problem:** `serve()` already performs an internal readiness wait and only returns on success, so the explicit `waitUntilReady` is largely redundant for the just-started case. It satisfies the T18 "health" step (good, keep it), but a transient failure of the second check calls `stop(handle)` and tears down an owned server that `serve` already proved ready. Low probability, but worth a brief comment noting the health step is intentional and that `waitUntilReady` should probe something `serve`'s internal wait does not (e.g. an application-level endpoint) to justify the redundancy.
- **Recommendation:** Add a one-line comment documenting the intent, and confirm `waitUntilReady` checks a strictly stronger condition than `serve`'s internal wait.

### 3. Final success line skips `stripControl`

- **File:** `src/commands/up.ts:~120`
- **Problem:** `deps.write(\`${model.id} ready at ${handle.endpoint}\n\`)`writes`model.id`and`handle.endpoint` un-sanitized. Both are validated upstream (`assertSafeModelId`, URL schema), so risk is very low, but every other externally-derived string in this file is `stripControl`'d, so this is an inconsistency.
- **Recommendation:** For consistency, `stripControl` the interpolated values on the stdout success line.

---

## Nits

### 1. Disk-fit logic/messaging is duplicated

- **File:** `src/commands/up.ts` (`chooseQuant` fit reason vs. explicit `formatGiB` disk error)
- `evaluateFit` already encodes disk fit for the auto path, while the explicit path re-checks disk with a bespoke message. Consider centralizing the "insufficient disk" message so auto and explicit paths report consistently.

---

## What's Done Well

- **Clean, testable DI:** `UpDeps` fully abstracts catalog, hardware, adapter, state, and I/O, enabling the real-`writeState`/`withLock` integration tests against a temp home — high-fidelity coverage without hitting the real backend.
- **Correct ordering and routing:** The command follows the exact T18 sequence, binds `127.0.0.1`, routes result data to stdout and all progress/diagnostics to stderr, and consistently `stripControl`s external strings (`ollamaId`, progress `event.status`).
- **Health-failure cleanup is right:** `stop(handle)` on readiness failure is correctly a no-op for attached daemons and a real teardown for owned ones — and it's explicitly tested.
- **Attached-daemon persistence is exercised:** The `pid: 0, ownedByUs: false` case is covered end-to-end, and the schema doc comment clearly explains the convention.

---

## Verification Story

| Check            | Status | Notes                                                                                                                                                                        |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | Happy-path ordering, bind host, disk abort, missing backend, health-failure cleanup, attached daemon, unknown model, progress streaming — all covered with real state layer. |
| Build verified   | ✅     | `tsc` clean; `tsc --noEmit` clean.                                                                                                                                           |
| Lint             | ✅     | `eslint .` clean.                                                                                                                                                            |
| Security checked | ✅     | 127.0.0.1 bind, `stripControl` on external strings, 0600 atomic state write, path traversal handled by resolver. `kill(0)` footgun mitigated by guards (see Important #1).   |
| Coverage         | ⚠️     | Command paths well covered; state-write-failure cleanup (Important #2) and out-of-range port (Important #3) are untested gaps.                                               |

---

## Action Items

| #   | Priority  | Issue                                                                                                    | Target                     |
| --- | --------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Important | Replace `pid: 0` sentinel with discriminated union / optional pid to make illegal states unrepresentable | backlog (schema hardening) |
| 2   | Important | Stop owned handle on `withLock`/`writeState` failure to avoid orphaned server                            | hotfix candidate           |
| 3   | Important | Validate `--port` range (1–65535) at CLI boundary                                                        | hotfix candidate           |
| 4   | Important | Make `defaultDeps` lazy to remove import-time side effects                                               | backlog                    |
| 5   | Minor     | Warn when an explicitly requested quant fails memory fit                                                 | backlog                    |
| 6   | Minor     | Document/justify the double readiness wait; ensure health probes a stronger condition                    | backlog                    |
| 7   | Minor     | `stripControl` the final stdout success line for consistency                                             | backlog                    |
| 8   | Nit       | Centralize duplicated insufficient-disk messaging                                                        | backlog                    |

---

### On the design question under review (`pid` non-negative relaxation)

The relaxation is **safe today** but is **not the ideal model**. Using `0` as a sentinel for "attached, unknown pid" reintroduces a class of bug the type system could otherwise eliminate, and it leans entirely on the `ownedByUs && pid > 0` guards holding forever across every future signal call site. Prefer modeling the attached daemon as a distinct shape (discriminated union on `ownedByUs`, or an optional `pid` present only when owned). That makes `{ ownedByUs: false }` carry no pid at all, removes the `process.kill(0, …)` group-signal footgun by construction, and keeps the persisted invariant enforced by the schema rather than by convention. See Important #1.
