# Code Review Checkpoint 36: Task U1d

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U1d (five read-only visual screens, accessible presentations, can-run picker, and CLI routing)
> **Test suite:** 1,293 tests passing (76 files), typecheck ✅, build ✅, lint ✅, pack ✅, diff ✅

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** U1d provides all five screen shells, stable-id list state, bounded visual list virtualization, compare limits, offline model selection, lazy renderer loading, and a passing real pseudo-TTY smoke. It does not satisfy the release contract because output authority, `--no-color`, renderer failure behavior, accessibility bounds/parity, controls, and frozen help output remain incorrect.

---

## Critical Issues

None.

## Important Issues

### 1. Parse `--no-color` from the option key CAC actually emits

- **File:** `src/cli.ts:95-116`
- **Problem:** CAC parses `--no-color` as `{ color: false }`, but `resolveReadOnlyMode()` reads `options.noColor`. The flag is therefore dropped and eligible visual mode can still enable color. The generated help also misleadingly says `--no-color ... (default: true)`.
- **Fix:** Represent the parsed option as `color?: boolean`, derive `noColor` from `options.color === false` (or inspect the raw flag consistently), and add CLI routing tests that assert the selector receives `noColor: true` for `--no-color` and that the help text does not claim negative flags default to true.

### 2. Always emit the authoritative plain result after command handoff

- **File:** `src/tui/read-only-command.ts:145`
- **Problem:** Pressing `p` changes stdout from the command's authoritative plain result to only the suggested next command. This contradicts the U1d acceptance rule that frames stay on stderr and the final authoritative plain result is emitted exactly once on stdout. The current unit test explicitly locks in the wrong replacement behavior.
- **Fix:** Keep `options.formatPlain(result)` as the single unconditional final stdout write after unmount. Treat command handoff as presentation state on stderr, or define a separately approved/versioned output contract; update visual and accessible tests to prove the plain result remains authoritative.

### 3. Implement the specified renderer failure matrix and notices

- **File:** `src/tui/read-only-command.ts:97-108`, `src/tui/read-only-command.ts:122-145`
- **Problem:** Auto-mode lazy-import failure silently falls back instead of emitting the exact `renderer_init` notice. Mount/runtime failures emit arbitrary sanitized `ui: <message>` text, even for explicit `--tui`, rather than the stable `renderer_pre_execution`/`renderer_runtime` behavior. Raw implementation errors therefore become user-facing contract text and explicit and automatic modes are conflated.
- **Fix:** Classify initialization, pre-execution, and runtime failure points; emit the exact spec strings; fail explicit initialization/pre-execution before domain work; restore before warning; and preserve the one authoritative final result without rerunning collection. Add synchronized tests for each matrix row.

### 4. Bound and paginate accessible model-list output

- **File:** `src/tui/read-only-accessible.ts:49-66`, `src/tui/read-only-accessible.ts:99-105`, `src/tui/read-only-accessible.ts:161-205`
- **Problem:** Accessible recommendation and catalog formatting eagerly serializes every row and every nested evidence collection. With accepted limits of up to 1,000 rows and nested arrays, one screen can allocate and write many megabytes, bypassing visual virtualization and the 256 KiB frame safety policy. Search results repeat the same unbounded serialization.
- **Fix:** Add line-oriented paging/windowing with bounded per-page evidence, cap nested detail lists consistently with visual mode, and enforce a byte budget using the existing terminal frame/builder primitives. Add maximum-cardinality tests that assert bounded writes and navigation to later pages.

### 5. Preserve accessible parity and make unknown evidence visible in visual screens

- **File:** `src/tui/screens/read-only.tsx:234-288`, `src/tui/screens/read-only.tsx:375-381`, `src/tui/screens/read-only.tsx:404-418`, `src/tui/read-only-accessible.ts:49-105`
- **Problem:** The accessible transcript exposes detailed RAM/disk/GPU scope, refresh identifiers, benchmark evidence, artifact byte counts, and full recommendation score evidence that visual screens omit or reduce to counts. The visual Doctor screen renders nothing when hardware score evidence is unavailable instead of displaying `unknown` and its diagnostic reason. Catalog also labels missing KV/benchmark values `unknown` without preserving a reason. This fails both accessible parity and the honesty requirement.
- **Fix:** Define one evidence inventory per command and render it in both presenters. Show an explicit unknown score card tied to the relevant diagnostic check; carry typed unknown reasons for catalog geometry/benchmark fields; expose refresh IDs and integrity/artifact evidence through bounded detail views; and add parity tests over the same fixtures.

### 6. Make every advertised visual control functional and discoverable

- **File:** `src/tui/screens/read-only.tsx:91-95`, `src/tui/screens/read-only.tsx:151-158`, `src/tui/screens/read-only.tsx:183`, `src/tui/screens/read-only.tsx:307-330`
- **Problem:** Help advertises Home/End, but input handling implements undocumented `g`/`G` instead and Ink exposes no Home/End branch here. `CanRunScreen` advertises `? Help` while calling `useStaticExit()` without a help callback, so the key does nothing. The shared footer prints Unicode arrows even when Unicode is disabled. The visible action surface is therefore inaccurate and incomplete.
- **Fix:** Handle actual Home/End key sequences (or decode them before Ink), either implement Can Run help or remove the advertised action, document any retained `g`/`G` aliases, and render ASCII footer labels when `style.unicode` is false. Add input-level tests for every visible control.

### 7. Resolve the frozen help-contract regression

- **File:** `src/cli.ts:98-104`, `src/cli.ts:460-466`
- **Problem:** A clean build of `HEAD` compared with U1d shows byte differences in both top-level and `can-run --help` output: four new options are inserted, with two misleading `(default: true)` annotations. This directly fails the stated byte-stable help acceptance gate, and existing tests only check that command names are present rather than freezing help bytes.
- **Fix:** Either obtain and document an explicit versioned exception for the required interactive flags and update authoritative fixtures, or register them in a way that preserves the frozen help contract. Add exact-byte golden tests for top-level and each changed subcommand help output.

## Suggestions

### 1. Assert the latest frame instead of cumulative terminal history

- **File:** `tests/tui/read-only-screens.test.ts:90-132`
- Several state-transition assertions search `stderr.chunks.join("")`, so stale prior frames can satisfy them even when the current frame is wrong. Normalize Ink output into the latest rendered frame and assert selection/search/detail/compare state there.

## What's Done Well

- Command collectors separate one domain execution from formatting, and the full suite confirms existing plain/JSON result bytes remain green.
- Visual renderer loading occurs only after eligibility, and accessible mode does not import Ink.
- Stable model IDs drive selection across filtering; visual lists use bounded overscan; comparison is capped at four.
- The omitted `can-run` model picker is restricted to interactive paths and validates a bounded offline catalog list.
- All five read-only screens exist, visual frames use stderr, implicit `ls` exits automatically, and the built pseudo-TTY `recommend` smoke rendered and exited successfully.

## Verification Story

| Check            | Status | Notes |
| ---------------- | ------ | ----- |
| Tests reviewed   | ✅ | New U1d tests reviewed first; full suite passes 1,293/1,293 across 76 files. |
| Build verified   | ✅ | Typecheck, repository-wide lint, build, pack dry-run, and `git diff --check` pass. |
| Security checked | ⚠️ | No new read-only mutation/network action found, but accessible output lacks enforced aggregate bounds. |
| Coverage         | ⚠️ | Missing exact help goldens, no-color parsing, failure-matrix, max-cardinality accessibility, parity, and complete-control tests. |

## Action Items

| #   | Priority | Issue | Target |
| --- | -------- | ----- | ------ |
| 1 | Important | Parse and honor `--no-color` | Task U1d |
| 2 | Important | Preserve authoritative final plain stdout after handoff | Task U1d |
| 3 | Important | Implement stable renderer failure behavior | Task U1d |
| 4 | Important | Bound and paginate accessible list output | Task U1d |
| 5 | Important | Restore visual/accessibility evidence parity and unknown reasons | Task U1d |
| 6 | Important | Complete the advertised control surface | Task U1d |
| 7 | Important | Resolve byte-stable help regression | Task U1d |
| 8 | Suggestion | Assert latest terminal frames in screen tests | Backlog |
