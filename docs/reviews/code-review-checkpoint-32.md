# Code Review Checkpoint 32: Task U1b

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-08
> **Scope:** Task U1b (final confirmation of TUI session lifecycle, bounded streaming key decoder, and terminal-safe sanitizer primitives)
> **Test suite:** 1,201 tests passing (68 files), typecheck ✅, build ✅, lint ✅; focused U1b suite 72 tests passing (3 files)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The checkpoint 31 C1 CSI/SS3 and protocol-specific BEL fixes are present and all verification gates pass. U1b is not ready to ship because the 7-bit SOS introducer is still omitted, resize fallback can turn an observer fault into an uncaught timer exception, and the public sanitizer profile can still widen non-chat contexts beyond their hard caps.

---

## Critical Issues

None.

## Important Issues

### 1. Suppress fragmented 7-bit SOS terminal strings

- **File:** `src/tui/keys.ts:31`
- **Problem:** `TERMINAL_STRING_START_RE` recognizes OSC (`ESC ]`), DCS (`ESC P`), PM (`ESC ^`), and APC (`ESC _`), but omits the 7-bit SOS introducer `ESC X`. `ESC X` is instead consumed as a complete finite escape, so a fragmented payload such as `ESC X`, then `q`, then ST decodes `q` as `quit`. This leaves checkpoint 31's all-family terminal-string requirement partially unresolved.
- **Fix:** Include `X` in the 7-bit terminal-string introducer set and in the split-`ESC` continuation branch, with `allowsBel` remaining false. Replace the DCS-only terminator test with a table-driven matrix covering 7-bit and C1 OSC/DCS/SOS/PM/APC, fragmented action-shaped payload (`q`, space, ETX), C1 ST, 7-bit ST, OSC BEL, and BEL inside every non-OSC family.

### 2. Contain resize-fallback callback failures

- **File:** `src/tui/session.ts:99`
- **Problem:** `onBelowMinimum` runs from a timer and is protected only by `finally`. If it throws, terminal state is restored but the exception escapes the timer callback as an uncaught exception, potentially terminating the process and active domain work. The spec requires below-minimum resize to restore the terminal and continue domain work with plain progress, and renderer/observer faults must not rewrite the product outcome.
- **Fix:** Catch callback failures inside the timer, restore in `finally`, and route the failure through a bounded renderer-fault/status callback rather than rethrowing from the timer. Add a fake-timer regression where `onBelowMinimum` throws and verify restoration completes once, listeners are removed, and no uncaught exception escapes.

### 3. Prevent chat profile from widening non-chat contexts

- **File:** `src/tui/sanitize.ts:239`
- **Problem:** The public `profile: "chat_visible"` option selects the 64 KiB cap independently of `context`. Callers can therefore produce a 64 KiB `single_line` cell or `action_identifier`, bypassing the normative 256-byte cell cap. The profile is hard only in byte magnitude, not in its permitted context.
- **Fix:** Encode chat-visible text as a dedicated helper or discriminated API that always uses multiline semantics, or reject `profile: "chat_visible"` unless `context === "multiline"`. Add tests proving the profile cannot widen `single_line` or `action_identifier`, while multiline chat remains capped at 64 KiB.

## Suggestions

None.

## What's Done Well

- Resize no longer bypasses pending signal cleanup, including the signal-plus-resize race.
- C1 CSI and SS3 input is normalized into bounded finite-sequence parsing, so fragmented action-shaped final bytes are swallowed.
- OSC permits BEL while DCS/PM/APC and their C1 forms remain suppressed until ST.
- Context byte overrides are bounded, visible escape tokens remain atomic, and the adversarial sanitizer corpus covers controls, bidi/default-ignorables, invalid surrogates, grapheme boundaries, frame bounds, and retained-message bounds.
- Full tests, focused tests, typecheck, lint, and build all pass.

## Verification Story

| Check            | Status | Notes |
| ---------------- | ------ | ----- |
| Tests reviewed   | ✅ | All 72 focused U1b tests reviewed first; focused suite passes 72/72 and full suite passes 1,201/1,201 across 68 files. |
| Build verified   | ✅ | Typecheck, repository-wide ESLint, and build all pass. |
| Security checked | ❌ | Fragmented 7-bit SOS payload can still become UI actions; sanitizer profile typing permits a non-chat cap bypass. |
| Coverage         | ⚠️ | Strong coverage overall, but no all-family 7-bit/C1 control-string matrix, throwing resize-fallback callback case, or invalid profile/context combinations. |

## Action Items

| #   | Priority | Issue | Target |
| --- | -------- | ----- | ------ |
| 1 | Important | Suppress fragmented 7-bit SOS strings and complete the control-string family matrix | Task U1b before ship |
| 2 | Important | Contain resize-fallback callback failures without terminating domain work | Task U1b before ship |
| 3 | Important | Bind the chat-visible sanitizer profile to multiline chat context | Task U1b before ship |
