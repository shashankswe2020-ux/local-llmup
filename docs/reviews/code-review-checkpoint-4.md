# Code Review Checkpoint 4: Task T21 (`doctor` command)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T21 — the read-only `doctor` command: four isolated probes (hardware, backend, catalog, state) that each convert a thrown error into a `fail` check, plus the `registerDoctor` CLI wiring that maps `!report.ok` → `process.exitCode = 1`. Deps T7 (`detectHardware`), T12 (`readState`), T13 (`BackendAdapter`), T17 (`OllamaAdapter`).
> **Test suite:** 328 tests passing (26 files), typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE

**Overview:** `doctor` meets every T21 acceptance criterion. It reports a missing backend (with install hint), unsupported hardware (usable memory < 1 GiB → `fail`), a corrupt catalog and corrupt state (both throw-to-`fail`), surfaces `digestVerified:false` as a non-fatal `warn`, and returns nonzero via `checks.every(status !== "fail")` wired to `process.exitCode`. Probe isolation is correct and complete: I traced every probe and confirmed no thrown error can escape a per-check `try/catch` (notably `usableMemoryBytes` only reads the memory fields here — it never reaches the `requiredMemoryBytes` path that throws `ValidationError` on bad `diskBytes`). Sanitization is thorough (every registry/state/hint string is `stripControl`'d, and `renderTable` re-sanitizes each cell), and the raw `endpoint` is correctly used for the reachability probe while only the sanitized copy is displayed. No Critical or Important issues. Findings are Minor/Nit: a dead `log` dep, disk shown-but-never-evaluated, an empty catalog reported `ok`, and the exit-code judgment call on `warn` (both `digestVerified:false` and an unreachable recorded server). The `warn`-doesn't-flip-exit choice is defensible and documented — `digestVerified:false` is explicitly "surfaced" (spec §11.8, decision 8), not required to fail — so it stays a Minor discussion item rather than a blocker.

---

## Critical Issues

None.

---

## Important Issues

None.

---

## Minor Issues

### 1. `log` dep is dead code — declared, defaulted, never called (Focus Q4)
- **File:** `src/commands/doctor.ts:53` (interface member) and `:63` (default factory)
- **Problem:** `DoctorDeps.log` (documented "Diagnostics → stderr") is declared and wired in `createDefaultDeps` to `process.stderr.write`, but `runDoctor` and every `check*` helper only ever call `deps.write`. Nothing in `doctor` writes to stderr. The unused member is confusing (it implies a stderr diagnostic path that does not exist), and every test has to supply a `log` fake it never exercises.
- **Fix:** Remove the member and its default until there is a real stderr use:
  ```ts
  export interface DoctorDeps {
    readonly config: Config;
    readonly detectHardware: () => Promise<HardwareProfile>;
    readonly loadCatalog: () => Catalog;
    readonly readState: (config: Config) => RuntimeState;
    readonly adapter: BackendAdapter;
    /** Command result data → stdout. */
    readonly write: (text: string) => void;
  }
  ```
  Drop `log: (text) => process.stderr.write(text)` from `createDefaultDeps` and `log: () => undefined` from the test `baseDeps`. (If a stderr progress line is wanted for the ~1.5 s reachability wait, keep it — but then actually call it.)

### 2. Free disk is displayed but never evaluated — no low-disk `warn`/`fail` (Focus Q3)
- **File:** `src/commands/doctor.ts:93` (`checkHardware` summary)
- **Problem:** The command line and spec both say `doctor` should "diagnose … disk" (`src/cli.ts:40`, spec §7 command table line 82). Today `freeDiskBytes` is only interpolated into the hardware summary string; there is no threshold, so a nearly-full disk that would make the next `pull` fail still reports hardware `ok`. Ports are legitimately folded into the state reachability probe, but disk is shown without a verdict.
- **Assessment:** Not in the T21 *acceptance* list (which names backend/hw/catalog/state/digest), so folding disk into the summary is acceptable coverage — but a full disk is the single most common `pull` failure and is cheap to gate.
- **Fix:** Add a `warn` (or split "disk" into its own check) when free disk is below a floor, e.g.:
  ```ts
  const MIN_FREE_DISK_BYTES = 5 * 1024 ** 3; // headroom for one small pull
  // in checkHardware, after the usable-memory gate:
  if (hw.freeDiskBytes < MIN_FREE_DISK_BYTES) {
    return { name: "hardware", status: "warn", detail: `low free disk (${summary})` };
  }
  ```

### 3. Empty catalog reports `ok` ("0 model(s), all digests verified")
- **File:** `src/commands/doctor.ts` (`checkCatalog`, `catalog.models.length === 0` path)
- **Problem:** If `loadCatalog()` returns a valid-but-empty catalog, the check reports `ok` with `0 model(s), all digests verified`. A catalog with no models means nothing is runnable — `up`/`recommend` will have nothing to offer — which is a diagnosable problem `doctor` currently hides behind a green row.
- **Fix:** Treat an empty model list as `warn`:
  ```ts
  if (catalog.models.length === 0) {
    return { name: "catalog", status: "warn", detail: "catalog contains no models" };
  }
  ```

### 4. Unreachable recorded server is `warn`, so it does not flip exit (Focus Q1)
- **File:** `src/commands/doctor.ts` (`checkState` catch → `status: "warn"`)
- **Problem:** T21 acceptance says "returns nonzero when problems found." A recorded-but-unreachable server is a real state/reality mismatch (`state.json` claims a live daemon that is not answering). It is surfaced as `warn`, which does **not** set `process.exitCode`, so a CI gate of `local-llmup doctor` passes despite the stale record.
- **Assessment:** Defensible as designed — the condition is recoverable (the detail already tells the user to run `local-llmup down`), transient (the daemon may be starting), and distinct from a broken subsystem. `digestVerified:false` correctly stays `warn` per spec §11.8 / decision 8 ("surfaced," not "fails"). The gap is only that "problem found" is ambiguous between "any non-`ok`" and "any `fail`."
- **Fix:** No code change required for correctness. Either (a) document the exit contract explicitly ("exit nonzero on `fail` only; `warn` is advisory") in the command help / a code comment, or (b) if CI should catch stale state, promote the unreachable-server branch to `fail` while keeping `digestVerified:false` as `warn`.

---

## Suggestions (Nit)

### 1. Independent probes run serially; the reachability probe can block ~1.5 s
- **File:** `src/commands/doctor.ts` (`runDoctor` — sequential `await`s)
- The four probes are independent, but `checkHardware`, `checkBackend`, and `checkState` are awaited one after another, so the up-to-`REACHABILITY_TIMEOUT_MS` (1500 ms) state wait is fully additive. `Promise.all([...])` over the async probes would cut worst-case latency with no behavior change (order the resulting array to keep the table stable). Low value for a one-shot command — optional.

### 2. `unverified.join(", ")` is unbounded in a single table cell
- **File:** `src/commands/doctor.ts` (`checkCatalog` warn detail)
- For a large catalog with many size-only quants, the detail becomes one enormous cell and `renderTable` pads the column to that width, producing an unreadable row. Consider capping the list (e.g. first N + "and K more") or reporting a count with the full list behind `--verbose`.

### 3. "all digests verified" overstates when `digestVerified` is `undefined`
- **File:** `src/commands/doctor.ts` (`checkCatalog` ok detail)
- The check only flags `digestVerified === false`; quants where the field is `undefined` (never asserted either way) are counted into "all digests verified." Cosmetic, but the message claims more than the data proves. Consider "N model(s), no size-only quants" or counting explicitly-verified entries.

### 4. `createDefaultDeps()` runs `loadConfig()` eagerly at default-arg evaluation
- **File:** `src/commands/doctor.ts:57-64`
- If `loadConfig()` throws, it throws during default-parameter evaluation of `runDoctor()`, before any probe runs. The CLI's `try/catch` catches it → `exit 1` on stderr, which is safe, but it means `doctor` cannot diagnose its own config/path problem as a `check` row. Minor — a config failure is rare and the fallback is correct — but if config robustness matters, wrap config resolution in its own probe.

---

## What's Done Well

- **Airtight probe isolation.** Every probe is individually `try/catch`'d and converts a throw into a `fail` row, so one corrupt subsystem still lets the other three report — exactly the read-only "diagnose everything" contract. I verified no throw escapes: `usableMemoryBytes` touches only memory fields (never the `diskBytes` `ValidationError` path), and `detectHardware`/`readState`/`isInstalled`/`waitUntilReady` are all guarded.
- **Correct probe-vs-display data handling.** `checkState` probes the *raw* `active.endpoint` (right — you must dial the real value) while displaying only the `stripControl`'d copy. This is the subtle detail that is easy to get wrong.
- **Defense-in-depth sanitization.** Every model/quant/state/hint string is `stripControl`'d at the source, and `renderTable` re-sanitizes each cell — untrusted registry data cannot smuggle ANSI/control sequences into the terminal.
- **Consistent architecture.** The lazy `createDefaultDeps()` seam, pure `check*` builders, and result-data-to-stdout routing match the shipped `ls`/`switch`/`up`/`down` siblings, so the command reads as part of a coherent family.
- **Thorough, behavior-focused tests.** All eight tests are fully faked (no fs), and they cover every status and the exit-flip: healthy `ok`, backend-missing `fail` + hint, low-memory `fail`, catalog throw `fail`, state throw `fail`, `digestVerified:false` `warn` (exit stays `true`) with the model id asserted on stdout, unreachable-server `warn`, and reachable-server `ok`.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 8 doctor tests, fully faked, cover every status + exit flip + stdout routing |
| Build verified | ✅ | `tsc` clean; `tsc --noEmit` clean; `eslint .` clean |
| Security checked | ✅ | Every registry/state/hint string `stripControl`'d; `renderTable` double-sanitizes; raw endpoint used only for the loopback probe |
| Coverage | ✅ | Every branch of all four probes exercised; CLI wiring maps `!ok → exitCode 1` |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Minor | Remove dead `log` dep from `DoctorDeps` + default factory | backlog |
| 2 | Minor | Add a low-free-disk `warn` (disk is shown but never evaluated) | backlog |
| 3 | Minor | Report an empty catalog as `warn`, not `ok` | backlog |
| 4 | Minor | Document (or reconsider) the `warn`-doesn't-flip-exit contract for an unreachable recorded server | backlog |
| 5 | Suggestion | Parallelize independent probes with `Promise.all` | backlog |
| 6 | Suggestion | Cap the unbounded `unverified.join(", ")` detail cell | backlog |
| 7 | Suggestion | Tighten "all digests verified" wording when `digestVerified` is `undefined` | backlog |
| 8 | Suggestion | Consider wrapping config resolution in its own probe so `doctor` can diagnose config errors | backlog |
