# Code Review Checkpoint 30: Task U1b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-08
> **Scope:** Task U1b (TUI session lifecycle, bounded streaming key decoder, and terminal-safe sanitizer primitives)
> **Test suite:** 1,194 tests passing (68 files), typecheck ✅, build ✅, lint ✅; focused U1b suite 65 tests passing (3 files)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The final fixes correctly gate public close during signal cleanup, restore partially mutated terminal state, suppress repeated signals, and cover fragmented/coalesced input. Three remaining boundary violations can prematurely finish signal restoration, admit fragmented C1 control-string payload as actions, or exceed context-specific sanitizer caps; one display-integrity edge case remains minor.

---

## Critical Issues

None.

## Important Issues

### 1. Resize can bypass pending signal cleanup

- **File:** `src/tui/session.ts:92`
- **Problem:** The below-minimum resize callback calls `restore()` directly even when `signalCleanupPending` is true. A resize arriving after SIGINT/SIGTERM/SIGHUP therefore clears the cleanup timeout and resolves `waitUntilRestored()` before `onSignal` settles, violating the first-signal contract that restoration waits for product cleanup or its timeout. The new public `close()` gate does not protect this private path.
- **Fix:** Route every non-timeout restoration request through one gated completion function (for example, `requestRestore()`), which records a pending close/resize request while signal cleanup is active. Only the signal cleanup completion or cleanup timeout should invoke the final `restore()`. Add a fake-timer regression that emits a signal, resizes below minimum, verifies raw mode remains enabled, then resolves cleanup and verifies restoration.

### 2. Fragmented C1 terminal strings release payload as UI actions

- **File:** `src/tui/keys.ts:135`
- **Problem:** `RAW_CONTROL_RE` suppresses a C1 OSC/DCS/SOS/PM/APC introducer (`U+009D`, `U+0090`, `U+0098`, `U+009E`, `U+009F`) only for its current chunk, but does not enter terminal-string suppression state. With fragmented input, `U+009D`, then `q`, then BEL decodes `q` as `quit`. The decoder handles only the 7-bit ESC-prefixed forms, leaving equivalent C1 forms unsafe.
- **Fix:** Recognize C1 terminal-string introducers before the generic raw-control guard and enter `terminalString` state until BEL or ST. Recognize C1 ST (`U+009C`) as a terminator as well. Add fragmented tests for every C1 string introducer and both terminators, including payload containing `q`, space, and ETX.

### 3. Caller overrides can exceed context-specific sanitizer caps

- **File:** `src/tui/sanitize.ts:226`
- **Problem:** `options.maxBytes` is validated against the global 1 MiB input limit rather than the selected context's cap. For example, `sanitizeTerminalText(value, "multiline", { maxBytes: 70_000 })` returns more than the normative 8 KiB detail limit. This makes the default safe but permits callers to bypass the required cell/detail bounds accidentally.
- **Fix:** Clamp or reject `maxBytes` above the context-specific maximum. Introduce an explicit bounded context or dedicated helper for the 64 KiB chat limit instead of widening generic multiline detail. Add tests proving every context rejects or clamps an override one byte above its cap.

## Suggestions

### 1. Preserve visible escapes atomically at truncation boundaries

- **File:** `src/tui/sanitize.ts:191`
- Truncation segments escaped output as ordinary graphemes, so an invalid action character near the byte limit can render as a partial token such as `\u…` rather than the required deterministic `\u{HEX}`. Build truncation units while scanning original code points (or mark visible escapes as atomic units), then append the ellipsis only between units. Add a boundary regression for an invalid final identifier character.

## What's Done Well

- Public `close()` no longer bypasses an in-flight signal cleanup, and both cleanup completion and timeout restore terminal resources.
- Startup rollback covers `setRawMode()` and `resume()` implementations that mutate before throwing.
- Repeated signals are status-only and cannot invoke cleanup twice or force process exit.
- The finite escape parser handles coalesced/fragmented bracketed paste, split 7-bit OSC ST, oversized incomplete CSI recovery, the 64-byte pending-sequence cap, and raw ETX after suppression.
- Sanitization scans original code units, visibly escapes unsafe controls/default-ignorables/surrogates, NFC-normalizes prose after escaping, and enforces frame/message retention bounds.

## Verification Story

| Check            | Status | Notes |
| ---------------- | ------ | ----- |
| Tests reviewed   | ✅ | All 65 focused tests reviewed first; focused suite passes 65/65 and full suite passes 1,194/1,194 across 68 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, and build all pass. |
| Security checked | ❌ | Fragmented C1 terminal strings can expose payload as actions; context-specific byte caps are caller-bypassable. |
| Coverage         | ⚠️ | Strong happy/error/race coverage, but missing signal-plus-resize, fragmented C1 strings, override-above-context-cap, and atomic escape truncation cases. |

## Action Items

| #   | Priority | Issue | Target |
| --- | -------- | ----- | ------ |
| 1 | Important | Gate resize-triggered restoration during signal cleanup | Task U1b |
| 2 | Important | Suppress fragmented C1 terminal strings | Task U1b |
| 3 | Important | Enforce context-specific sanitizer caps on overrides | Task U1b |
| 4 | Suggestion | Keep visible escapes atomic during truncation | Task U1b/backlog |
