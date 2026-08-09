# Code Review Checkpoint 45: Task U2b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U2b (lifecycle review/progress screens, accessible parity, up/switch/down prepare-execute-result splits, lazy CLI routing, command-scoped `--yes`, and fail-closed unavailable migration)
> **Test suite:** 1,358 tests passing (81 files), typecheck ✅, build ✅, lint ✅, pack dry-run ✅, diff check ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The command splits preserve the authoritative lifecycle checks and final plain formatters, `down --yes` / `migrate --move --yes` stay command-scoped, and migration remains honestly fail-closed before store access. The lifecycle presenter is not yet safe to ship: reachable progress mode captures and ignores Ctrl+C while claiming cancellation, renderer faults can replace a committed product success with exit 1 and suppress its final stdout, progress claims stages that are not observed, picker initialization does not implement the required fallback matrix, switch offers impossible targets, and one plain warning changed. The approved unavailable migration screen is a valid partial increment, but it does not satisfy U2b's migration-preview acceptance criterion; U2b must remain unchecked/partial.

---

## Critical Issues

### 1. Do not ship a progress screen that traps Ctrl+C

- **File:** `src/tui/screens/lifecycle.tsx:85`
- **Problem:** Progress mode renders “Ctrl+C requests safe cancellation,” configures Ink with `exitOnCtrlC: false`, and installs an empty `useInput()` handler. The lifecycle entry awaits `executePrepared*()` without an `AbortSignal`, so Ctrl+C cannot cancel, restore the terminal, or trigger ownership-safe cleanup. A stalled pull/readiness/stop can therefore retain raw mode and resources indefinitely. Although the full cancellation/compensation model is planned for U2c, U2b makes this incomplete path production-reachable now; the truthful/safe options are to implement the bounded cancellation boundary before enabling it or keep lifecycle progress unavailable until U2c. This is also security-audit-33 HIGH-1 / issue #155.
- **Fix:** Wire a command-scoped `AbortController` and progress `onCancel` through supported backend operations, restore terminal ownership immediately, await bounded ownership-safe cleanup, and preserve cleanup-error precedence. Add pseudo-TTY tests for Ctrl+C during each phase, repeated Ctrl+C, hung cleanup, and exact 130 behavior. If that remains explicitly deferred to U2c, remove the cancellation claim and do not route production lifecycle commands into the progress screen yet.

## Important Issues

### 1. Preserve committed lifecycle outcomes across renderer failures

- **File:** `src/tui/lifecycle-entry.ts:453`
- **Problem:** Progress mount and every `progress.emit()` remain inside the product control path. If mount/emit throws before execution, `up`/`switch` leak the renderer error instead of applying the required pre-execution contract. If an emit throws after `executePreparedUp()` or `executePreparedSwitch()` commits state, the CLI catches it as a command failure, exits 1, and never writes the authoritative final stdout. `down` only guards mount; post-execution emit has the same committed-result failure. In addition, `mountLifecycleReview()` converts asynchronous renderer rejection into a silent cancellation at `src/tui/lifecycle-renderer.tsx:90`, producing exit 130 instead of the required sanitized renderer notice. This violates AC15/AC16 and can encourage a user to retry an operation that already succeeded.
- **Fix:** Put review, mount, emit, and unmount behind a lifecycle presentation boundary that records whether domain execution has started/committed. Before execution, restore and emit the exact `renderer_pre_execution` notice without calling the domain function. During/after execution, catch renderer faults, restore once, emit the exact `renderer_runtime` notice, continue with bounded plain progress, and always write the domain result once. Never retry execution because of a renderer fault. Add injected load/mount/emit/unmount/rejection tests before execution, in flight, and after commit for all three implemented commands.

### 2. Replace synthetic post-hoc progress with real validated domain events

- **File:** `src/tui/lifecycle-entry.ts:463`
- **Problem:** `up` marks resolve/preflight/backend complete, emits one acquire start, runs the entire pull/cleanup/serve/readiness/commit operation, and only afterward marks verify through state commit complete. `switch` similarly reports readiness/revalidation/commit only after the whole operation returns, including for an already-active no-op. Meanwhile real adapter pull progress still writes directly to stderr from command dependencies, bypassing the TUI. The separate three-field `LifecycleProgressItem` at `src/tui/lifecycle-types.ts:16` permits completed-without-started transitions, has no typed phase union/counts/totals/error codes, and is neither state-machine validated nor coalesced. The UI therefore shows fake timing/status and does not implement the spec's progress contract or AC10/AC17.
- **Fix:** Thread the shared `ExecutionContext.emit` contract into `executePreparedUp()`, `executePreparedSwitch()`, and `executePreparedDown()` (or equivalent phase callbacks), emitting transitions at the actual orchestration boundaries and routing adapter progress through validated events. Reuse the strict `UiProgressEvent`/`UiPhase` controller validation, enforce started→progress/message→completed|failed, bound retained bytes/messages, coalesce renders, and retain terminal transitions. Never report a stage that did not execute. Add phase-order and failure-at-each-stage tests.

### 3. Implement the renderer/picker lazy-load failure matrix

- **File:** `src/tui/lifecycle-entry.ts:440`
- **Problem:** `runInteractiveUp()` and `runInteractiveSwitch()` load the lifecycle renderer before resolving an omitted model, then import/mount the model picker outside any failure boundary. Auto-mode renderer/picker initialization cannot fall back as specified, explicit initialization failures do not consistently become pre-domain validation failures, and raw import/mount errors flow to the CLI's command error formatter. The required lazy-routing tests for lifecycle commands are absent; current CLI routing tests exercise only read-only commands.
- **Fix:** Resolve omitted intent through one guarded lazy UI driver. Distinguish auto initialization (`renderer_init` fallback only when explicit intent can safely continue), explicit `--tui` initialization failure, and post-mount pre-execution failure (`renderer_pre_execution`). Never reconstruct or execute an omitted choice after picker failure. Add module-evaluation assertions proving help/plain/JSON/`--no-tui` paths do not load Ink/React or lifecycle modules, plus picker import/mount/rejection tests for auto, explicit TUI, and accessible modes.

### 4. Enforce switch picker eligibility before presenting targets

- **File:** `src/tui/lifecycle-entry.ts:163`
- **Problem:** The switch picker only removes the active model id. For a single-model backend such as llama.cpp or MLX, it offers every other catalog model and rejects the selected target later in `prepareSwitch()`. If the catalog contains only the active model, the shared picker throws the generic `model picker requires 1..1000 choices` error. This does not explain single-model restrictions before work and produces an unusable empty state, contrary to §5.8 and AC4/AC5.
- **Fix:** Build a typed switch-choice result from active state/backend capability before mounting: either eligible canonical target ids, or a command-specific unavailable/empty-state view with the exact `up <model> --backend <backend>` remediation. Keep the current model excluded/disabled with an explanation, and test Ollama, llama.cpp, MLX, one-model, and no-eligible-target cases in both visual and accessible modes.

### 5. Restore byte-compatible plain fit-warning output

- **File:** `src/commands/up.ts:204`
- **Problem:** Moving the warning into `fitWarning` dropped `for <model id>` from the existing stderr message. Plain `runUp()` now emits `up: requested quant <quant> may not fit...` instead of `up: requested quant <quant> for <model> may not fit...`. The existing test only checks a substring, so all tests pass despite violating AC2's unchanged plain-output contract.
- **Fix:** Preserve the previous message exactly in the plain formatter/log path while deriving separately sanitized review copy for the TUI. Add a byte-for-byte golden assertion for the complete warning, including model id and newline.

## Suggestions

### 1. Make prepared lifecycle evidence deeply immutable

- **File:** `src/commands/up.ts:258`
- `Object.freeze()` protects only the outer `UpPrepared`/`SwitchPrepared` object; nested catalog, quantization, hardware, and snapshot references remain mutable, and the prepared object also carries a live adapter object. The tests call the preparation “immutable” but do not attempt mutation. Use owned immutable snapshots for all plain evidence (for example the repository's `immutableSnapshot()` helper), keep execution capabilities outside UI-visible DTOs, and add deep-mutation regression tests. This makes the stale-review invariant explicit instead of relying on current call-site discipline.

## What's Done Well

- `prepareUp()`/`executePreparedUp()`, `prepareSwitch()`/`executePreparedSwitch()`, and `prepareDownConfirmation()`/`executePreparedDown()` preserve the original command wrappers and final formatters; the real built llama.cpp prepare→execute smoke provides useful evidence that the split did not bypass verified acquisition, loopback serving, state commit, or owned cleanup.
- The interactive entry executes the same reviewed prepared object, returns typed results, writes final stdout only through the existing formatter, refreshes the review after typed drift, and fails closed on `--yes` drift.
- `down` keeps Cancel as the visual and accessible default and distinguishes owned stop from attached detach consequences.
- CLI imports the lifecycle entry dynamically only after interactive mode selection, keeps omitted models invalid on noninteractive paths, and limits `--yes` registration to `down` and `migrate`; `migrate --yes` without `--move` fails before domain work.
- The migration-unavailable screen is honest: it states that no store was read or changed and ultimately throws the same fail-closed `MemoryError`. This preserves U2a rather than weakening filesystem containment.
- Review view-model strings and renderer progress labels pass context-aware terminal sanitization, accessible interaction uses cooked bounded input, and visual confirmation defaults to Cancel.

## Verification Story

| Check            | Status | Notes          |
| ---------------- | ------ | -------------- |
| Tests reviewed   | ✅ | Reviewed lifecycle/CLI/command tests first; independently reran 1,358/1,358 tests across 81 files. Coverage proves down's basic at-most-once path and formatter splits, but not lifecycle renderer fault phases, real progress transitions, up/switch interactive control flow, picker restrictions, or unavailable migration rendering. |
| Build verified   | ✅ | `npm run typecheck`, repository-wide `npm run lint`, `npm run build`, `npm pack --dry-run`, and `git diff --check` independently pass. |
| Security checked | ❌ | U2a snapshot/lock/process protections remain intact and migration remains fail-closed, but reachable raw-mode progress swallows Ctrl+C, renderer faults can suppress a committed result, and progress bypasses the validated shared controller contract. |
| Coverage         | ⚠️ | Full suite is green, yet the new lifecycle-entry suite contains only three accessible-down tests and the screen suite contains four happy-path/default-choice tests. Required fault, drift, phase, output-golden, picker, and migrate-unavailable matrices are missing. |

## Action Items

| #   | Priority                      | Issue         | Target                  |
| --- | ----------------------------- | ------------- | ----------------------- |
| 1 | Critical | Wire bounded cancellation before enabling lifecycle progress (issue #155) | Task U2b before ship / U2c prerequisite |
| 2 | Important | Preserve committed lifecycle outcomes across renderer failures | Task U2b before ship |
| 3 | Important | Replace synthetic lifecycle progress with real validated domain events | Task U2b before ship |
| 4 | Important | Implement renderer/picker lazy-load failure semantics and tests | Task U2b before ship |
| 5 | Important | Enforce switch picker eligibility and empty-state rules | Task U2b before ship |
| 6 | Important | Restore byte-compatible plain fit-warning output | Task U2b before ship |
| 7 | Suggestion | Deep-freeze prepared lifecycle evidence and separate capabilities | Task U2b follow-up |
