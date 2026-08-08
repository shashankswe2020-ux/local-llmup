# Code Review Checkpoint 20: Task B11

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B11 — `doctor` backends section (offline). Uncommitted changes only.
> **Test suite:** 774 tests passing (49 files), typecheck ✅, build ✅, lint ✅ (scope files clean)

---

## Verdict: ✅ APPROVE

**Overview:** B11 adds an offline, informational `Backends` section to `doctor` that
lists every registered backend, its install state, a best-effort `stripControl`-clean
version, and the machine's auto-selected default. The change is well-isolated, fully
tested (11 new doctor tests + 5 new `version()` tests), respects the honesty gate
(`unknown` for missing versions), keeps the exit-code contract with the existing
`backend` check, spawns with an arg array (`shell:false`), and makes no network calls.
Only minor, non-blocking findings.

---

## Critical Issues

None.

## Important Issues

None.

## Suggestions (Minor)

### 1. Redundant `ollama --version` spawns in a single `doctor` run

- **File:** [src/backend/ollama.ts](src/backend/ollama.ts#L554-L560), [src/backend/ollama.ts](src/backend/ollama.ts#L581-L595), [src/commands/doctor.ts](src/commands/doctor.ts#L136-L162)
- **Problem:** `OllamaAdapter.isInstalled()` and the new `version()` both run the _identical_ command `ollama --version` (isInstalled checks exit code, version parses stdout). In one `runDoctor` call the first adapter's `ollama --version` executes up to **three** times: once via `checkBackend` → `isInstalled`, once via `probeBackends` → `probeInstalled` → `isInstalled`, and once via `probeBackends` → `probeVersion` → `version`. Offline and harmless functionally, but wasteful.
- **Fix:** Optional. The cleanest reduction is to have `version()` also satisfy the install signal (a non-null version implies installed) so `probeBackends` can derive `installed` from the same probe, e.g.:
  ```ts
  // in probeBackends: run one probe per adapter, not two
  const version = await probeVersion(adapter);
  const installed = version !== null ? true : await probeInstalled(adapter);
  ```
  Keeping the two probes fully separate is a defensible isolation choice, so this is a nicety, not a requirement. The `checkBackend` vs `probeBackends` duplication is justified (separate exit-code vs informational concerns) and should stay.

### 2. No timeout / `AbortSignal` on the `version()` probe

- **File:** [src/backend/ollama.ts](src/backend/ollama.ts#L581-L595)
- **Problem:** `version()` calls `runProcess(...)` without a `signal`. `runProcess` supports an `AbortSignal`, but neither `version()` nor the pre-existing `isInstalled()` passes one. A hung `ollama --version` (e.g. a wedged binary) would hang `doctor` indefinitely — `doctor` otherwise bounds its slow probe (state reachability) with `REACHABILITY_TIMEOUT_MS`.
- **Fix:** Optional but recommended for a health-check command. Pass a short deadline, mirroring the readiness probe:
  ```ts
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const code = await runProcess(this.spawn, this.binary, ["--version"], {
      signal: controller.signal,
      onLine: (line) => {
        if (lines.length < 8) lines.push(line);
      },
    });
    if (code !== 0) return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  ```
  Note this is a pre-existing gap in `isInstalled()` too, not a B11 regression — B11 merely adds one more unguarded spawn. Track separately if you want consistency across both probes.

### 3. Magic number in `parseVersion` length bound

- **File:** [src/backend/ollama.ts](src/backend/ollama.ts#L365-L372)
- **Problem:** The fallback `trimmed.slice(0, 100)` uses a bare literal. The input is already bounded (≤8 lines, each capped by `MAX_LINE_BUFFER_BYTES`), so there is no safety issue, but the `100` reads as arbitrary.
- **Fix:** Extract a named constant, e.g. `const MAX_VERSION_LABEL_CHARS = 100;`, to document intent.

### 4. Direct-unit coverage gap for `parseVersion` edge behaviors

- **File:** [tests/backend/ollama-pull.test.ts](tests/backend/ollama-pull.test.ts#L236-L275)
- **Problem:** The new tests exercise `version()` end-to-end (semver extraction, non-zero exit, ENOENT, trimmed fallback), which is good. Two `parseVersion` behaviors are not directly asserted: the 8-line capture cap and the 100-char truncation of the fallback banner.
- **Fix:** Optional. Add one case where `--version` emits a long (>100 char) non-semver banner and assert the returned label is truncated, plus a multi-line banner where the semver appears on a later line. Low value given the input is bounded, but it locks the contract.

## What's Done Well

- **Honesty gate respected:** missing versions render as `unknown` and serialize as `null` in `--json`, never fabricated — consistent with project domain principles.
- **Defence in depth on untrusted output:** `parseVersion` bounds length, then `probeVersion` applies `stripControl`, and the hostile-escape test (`"0.3.14\u001b[31m\u0007evil"` → `"0.3.14evil"`, no ESC/BEL in stdout) proves ANSI/control neutralization end-to-end.
- **Exit-code contract preserved:** the informational `Backends` section and its probes are fully isolated (`probeInstalled`/`probeVersion` swallow throws) and never flip `report.ok`; tests explicitly assert `ok === true` when both `isInstalled` and `version` throw.
- **DRY architecture:** exporting `autoDetectPriority` lets `doctor` compute the auto-selected default from the single source of truth used by `select()`, so the reported default cannot drift from actual selection. Tests cover Apple-Silicon (MLX), non-Apple (Ollama), and no-install (no default) paths.
- **Security posture:** arg-array spawn (`["--version"]`), `shell:false` via existing `runProcess`, no network — matches the offline/loopback boundaries. The `--version` arg array is verified by a dedicated test.
- **Documentation:** interface JSDoc on the optional `version?()` correctly instructs callers to treat the result as untrusted and `stripControl` it; the `select.ts` comment explains why the helper is now exported.

## Verification Story

| Check            | Status | Notes                                                                                                                                                 |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 16 new tests (11 doctor, 5 `version()`); cover install/missing, version, stripControl, throwing probes, default selection across platforms, `--json`. |
| Build verified   | ✅     | `tsc` clean; `tsc --noEmit` clean.                                                                                                                    |
| Security checked | ✅     | Untrusted version double-sanitized (bound + `stripControl`); arg-array `shell:false`; no network; install hints also `stripControl`-clean.            |
| Coverage         | ⚠️     | Strong behavioral coverage; only the `parseVersion` line-cap/truncation edges lack a direct assertion (Suggestion 4).                                 |

## Action Items

| #   | Priority   | Issue                                                                                                                  | Target  |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Suggestion | Collapse redundant `ollama --version` spawns (isInstalled/version identical command; up to 3× per doctor run)          | backlog |
| 2   | Suggestion | Add short `AbortSignal` deadline to `version()` (and consider `isInstalled()`) so a hung `--version` can't hang doctor | backlog |
| 3   | Suggestion | Name the `parseVersion` 100-char bound as a constant                                                                   | backlog |
| 4   | Suggestion | Add direct `parseVersion` tests for 8-line cap and 100-char truncation                                                 | backlog |
