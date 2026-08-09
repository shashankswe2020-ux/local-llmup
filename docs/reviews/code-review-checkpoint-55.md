# Code Review Checkpoint 55: Task U3a — Chat Interaction Model & Limits

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-09
> **Scope:** Task U3a (Chat draft validation, interactive chat entry, Ink chat screen, limits enforcement)
> **Test suite:** 43 focused tests passing (2 files), typecheck ✅, build ✅, lint ✅

---

## Verdict: ✅ APPROVE

**Overview:** Clean, well-separated implementation of the chat interaction model. Draft limits are enforced at the domain layer before backend calls, the auto-TUI stdout contract is correctly maintained (session summary only), and no fake streaming is present. The Ink component is a stateless presentational shell awaiting wiring. Two important items below; nothing blocks merge.

---

## Critical Issues

None.

## Important Issues

### 1. `countGraphemes` allocates a new `Intl.Segmenter` on every call

- **File:** `src/tui/chat-limits.ts:37`
- **Problem:** `validateDraft` is called per-turn, and each invocation constructs a new `Intl.Segmenter` instance. While cheap for single calls, this will add GC pressure in long sessions or if validation is ever called in a tighter loop (e.g., incremental paste counting per the spec). The Segmenter is locale-independent and stateless — safe to reuse.
- **Fix:** Hoist a module-level singleton:
  ```typescript
  const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  function countGraphemes(text: string): number {
    let count = 0;
    for (const _ of GRAPHEME_SEGMENTER.segment(text)) count += 1;
    return count;
  }
  ```

### 2. Oversized response is `.slice(0, 2000)` truncated without grapheme-safety

- **File:** `src/tui/chat-entry.ts:175`
- **Problem:** When a response exceeds 1 MiB, the display truncation uses `reply.slice(0, 2000)` which can split a multi-byte character or grapheme cluster mid-sequence, producing malformed output on the TUI stream. The spec calls for display escaping through `sanitizeTerminalText()` and bounded visible lines/bytes.
- **Fix:** Route the truncated preview through `sanitizeTerminalText()` or the bounded visible-escape renderer used elsewhere, which already handles grapheme-safe truncation and control suppression. This ensures no broken UTF-8 reaches stderr.

## Suggestions

### 1. ChatScreen: key in list uses index — React reconciliation concern

- **File:** `src/tui/screens/chat.tsx:93`
- **Problem:** `key={\`${String(index)}:${msg.role}\`}` uses the array index. Since `visibleMessages` is a sliding window that shifts as messages accumulate, Ink/React may mis-reconcile nodes, causing unnecessary re-renders or flicker.
- **Recommendation:** Use a stable message ID (e.g., a monotonically increasing turn counter assigned at push time) as the key instead.

### 2. Consider a test for zero-turn session summary

- **File:** `tests/tui/chat-entry.test.ts`
- **Problem:** If the user sends only rejected drafts (all exceed limits) or immediately exits, `turns === 0`. The summary `"Chat session ended: 0 turns, 0 memory warnings.\n"` is emitted, which is technically correct but worth an explicit regression test to document this edge case intentionally.
- **Recommendation:** Add a one-line test asserting the zero-turn summary string.

### 3. `MAX_CONTEXT_MESSAGES` could be a named export for test assertion

- **File:** `src/tui/chat-entry.ts:33`
- **Recommendation:** If tests ever need to verify context windowing behavior (e.g., that the 21st message drops the first), exporting the constant allows the test to stay in sync. Low priority — current tests don't exercise this boundary.

## What's Done Well

- **Clean domain/UI separation:** `chat-limits.ts` is pure, testable, and UI-agnostic — all three modes (TUI, accessible, piped) share the same validation gate.
- **Dependency injection in `chat-entry.ts`:** Every side effect is injectable, making the 12 integration tests fast (15ms) with zero mocks on global state.
- **Spec fidelity:** The stdout contract (summary only) and stderr TUI stream split match §5.6 exactly. The "no fake streaming" requirement is fulfilled with explicit `"Waiting for response..."` pending state.
- **Thorough boundary tests:** Limits are tested at exact boundaries (N and N+1), multi-byte/grapheme cases are covered, and the priority ordering (bytes → graphemes → lines) is explicitly asserted.
- **Security:** `stripControl()` is applied to all model-generated content before stderr rendering, preventing terminal injection.

## Verification Story

| Check            | Status | Notes                                             |
| ---------------- | ------ | ------------------------------------------------- |
| Tests reviewed   | ✅     | 43 tests, thorough boundary and contract coverage |
| Build verified   | ✅     | `tsc` clean                                       |
| Security checked | ✅     | stripControl on all model content, no raw output  |
| Coverage         | ✅     | All exported functions exercised                  |

## Action Items

| #   | Priority   | Issue                                              | Target  |
| --- | ---------- | -------------------------------------------------- | ------- |
| 1   | Important  | Hoist `Intl.Segmenter` to module-level singleton   | Task U3 |
| 2   | Important  | Use grapheme-safe truncation for oversized display | Task U3 |
| 3   | Suggestion | Use stable message key in ChatScreen               | Backlog |
| 4   | Suggestion | Add zero-turn session summary test                 | Backlog |
| 5   | Suggestion | Export MAX_CONTEXT_MESSAGES constant               | Backlog |
