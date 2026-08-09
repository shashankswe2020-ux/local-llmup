# Code Review Checkpoint 31: Task U1b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-08
> **Scope:** Task U1b (final confirmation of TUI session lifecycle, bounded streaming key decoder, and terminal-safe sanitizer primitives)
> **Test suite:** 1,198 tests passing (68 files), typecheck ✅, build ✅, lint ✅; focused U1b suite 69 tests passing (3 files)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** Checkpoint 30's resize/cleanup, C1 string-introducer, context-cap, and atomic visible-escape findings are fixed. Two terminal-protocol gaps remain: fragmented C1 CSI/SS3 sequences can release final bytes as actions, and BEL incorrectly terminates non-OSC control strings.

---

## Critical Issues

None.

## Important Issues

### 1. Suppress fragmented C1 CSI and SS3 sequences

- **File:** `src/tui/keys.ts:151`
- **Problem:** The decoder recognizes only 7-bit ESC-prefixed CSI/SS3 sequences. A fragmented 8-bit C1 CSI (`U+009B`, then `q`) or SS3 (`U+008F`, then `q`) drops the introducer through the raw-control guard and decodes the final `q` as `quit`. C1 input therefore remains capable of producing UI actions despite the terminal-control suppression contract.
- **Fix:** Add bounded pending states for C1 CSI and C1 SS3 before the generic raw-control guard. Consume through each sequence's valid final byte, return no action for unknown sequences, and add fragmented/coalesced regressions with action-shaped final bytes (`q`, space, and ETX).

### 2. Restrict BEL termination to OSC strings

- **File:** `src/tui/keys.ts:69`
- **Problem:** `consumeTerminalString()` treats BEL as a terminator for every terminal-string family. BEL terminates OSC, but DCS/SOS/PM/APC terminate only with ST. An input such as `ESC P`, BEL, `q`, ST therefore releases `q` as `quit` while it is still DCS payload; the same issue affects the C1 forms.
- **Fix:** Track the active terminal-string kind. Permit BEL termination only for OSC; require 7-bit ST (`ESC \\`) or C1 ST (`U+009C`) for DCS/SOS/PM/APC. Add table-driven tests for all 7-bit and C1 introducers, both valid ST forms, OSC BEL, and BEL inside every non-OSC string.

## Suggestions

None.

## What's Done Well

- Resize fallback now waits for pending signal cleanup instead of completing restoration early.
- C1 OSC/DCS/SOS/PM/APC introducers enter suppression state, and C1 ST is recognized.
- Context profiles make the 8 KiB detail and 64 KiB visible-chat limits non-bypassable.
- Visible `\\u{HEX}` escapes are atomic truncation units.
- Paste, OSC, and CSI parsing retains bounded state and recovers from oversized incomplete CSI input.
- Full and focused verification gates are green.

## Verification Story

| Check            | Status | Notes |
| ---------------- | ------ | ----- |
| Tests reviewed   | ✅ | All 69 focused tests reviewed first; focused suite passes 69/69 and full suite passes 1,198/1,198 across 68 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, and build all pass. |
| Security checked | ❌ | Fragmented C1 CSI/SS3 and premature BEL termination can still convert terminal payload bytes into UI actions. |
| Coverage         | ⚠️ | Strong U1b coverage, but no C1 CSI/SS3 fragmentation matrix or protocol-specific terminal-string terminator matrix. |

## Action Items

| #   | Priority | Issue | Target |
| --- | -------- | ----- | ------ |
| 1 | Important | Suppress fragmented C1 CSI and SS3 sequences | Task U1b before ship |
| 2 | Important | Restrict BEL termination to OSC strings | Task U1b before ship |