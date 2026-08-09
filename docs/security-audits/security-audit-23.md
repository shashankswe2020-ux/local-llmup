# Security Audit Report #23

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 8 August 2026
> **Scope:** Final Task U1b security confirmation of TUI key decoding, terminal sanitization, and session cleanup after C1 CSI/SS3, OSC-vs-DCS termination, cleanup gating, and hard-cap fixes.
> **Dependencies:** 6 known vulnerabilities (`npm audit`, development toolchain only); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 1     |
| Low      | 0     |
| Info     | 0     |

---

## Findings

### [MEDIUM-1] 7-bit SOS terminal strings release action-shaped payload

- **Location:** `src/tui/keys.ts:41`
- **Description:** `TERMINAL_STRING_START_RE` recognizes the 7-bit OSC (`ESC ]`), DCS (`ESC P`), PM (`ESC ^`), and APC (`ESC _`) introducers, but omits the 7-bit SOS introducer (`ESC X`). `isCompleteFiniteEscape()` consequently consumes `ESC X` as a finite escape and returns to normal key decoding while the SOS payload is still active.
- **Impact:** A terminal-originated or injected SOS response can convert payload bytes into documented UI actions. Action-shaped bytes such as `q`, space, or raw ETX can quit, toggle, or cancel rather than remaining suppressed through the required ST terminator.
- **Proof of concept:** Feed the decoder three chunks: `ESC X`, `q`, and `ESC \\`. The current decoder returns `null`, then `quit`, then `null`; `q` should remain suppressed until ST.
- **Recommendation:** Add `X` to `TERMINAL_STRING_START_RE` so `ESC X` enters the same ST-only terminal-string state as C1 SOS (`U+0098`). Add fragmented and coalesced regressions for 7-bit SOS with `q`, space, and ETX payloads, and prove that only 7-bit or C1 ST terminates it.

---

## Positive Observations

- The C1 CSI and SS3 pending states now suppress fragmented action-shaped final bytes with a bounded 64-byte finite-sequence state.
- BEL termination is correctly restricted to OSC; DCS, PM, and APC remain suppressed until 7-bit or C1 ST.
- Signal cleanup is gated against public close, resize fallback, and repeated signals, with a validated hard timeout.
- Terminal text, frames, and retained messages have context-specific hard caps, and visible control escapes remain atomic during truncation.
- The focused U1b suite passes all 72 tests; type checking and repository-wide lint pass.
- Production dependencies have zero known vulnerabilities, sensitive environment files are ignored, and no `.env` or `tokens.json` history was found.

---

## Action Items (Priority Order)

| #   | Severity | Finding                              | Recommendation |
| --- | -------- | ------------------------------------ | -------------- |
| 1   | Medium   | 7-bit SOS payload escapes suppression | Recognize `ESC X` as SOS and suppress through ST, with fragmented/coalesced regressions |