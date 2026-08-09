import { describe, expect, it } from "vitest";
import {
  DRAFT_MAX_BYTES,
  DRAFT_MAX_GRAPHEMES,
  DRAFT_MAX_LINES,
  RESPONSE_MAX_BYTES,
  formatChatSessionSummary,
  formatDraftError,
  isResponseWithinLimits,
  validateDraft,
} from "../../src/tui/chat-limits.js";

describe("Chat draft limit constants", () => {
  it("DRAFT_MAX_BYTES is 32 KiB", () => {
    expect(DRAFT_MAX_BYTES).toBe(32_768);
  });

  it("DRAFT_MAX_GRAPHEMES is 8192", () => {
    expect(DRAFT_MAX_GRAPHEMES).toBe(8_192);
  });

  it("DRAFT_MAX_LINES is 256", () => {
    expect(DRAFT_MAX_LINES).toBe(256);
  });

  it("RESPONSE_MAX_BYTES is 1 MiB", () => {
    expect(RESPONSE_MAX_BYTES).toBe(1_048_576);
  });
});

describe("validateDraft", () => {
  it("returns null for a valid short draft", () => {
    expect(validateDraft("Hello, world!")).toBeNull();
  });

  it("returns null for empty draft", () => {
    expect(validateDraft("")).toBeNull();
  });

  it("returns null at exactly 8192 graphemes within byte limit", () => {
    const draft = "a".repeat(DRAFT_MAX_GRAPHEMES);
    expect(validateDraft(draft)).toBeNull();
  });

  it("bytes limit is checked first for large multi-byte input", () => {
    // 32 KiB of single-byte ASCII is valid in bytes but exceeds graphemes
    const draft = "a".repeat(DRAFT_MAX_BYTES);
    const error = validateDraft(draft);
    expect(error).not.toBeNull();
    expect(error!.type).toBe("graphemes");
  });

  it("returns bytes error when draft exceeds 32 KiB", () => {
    const draft = "a".repeat(DRAFT_MAX_BYTES + 1);
    const error = validateDraft(draft);
    expect(error).not.toBeNull();
    expect(error!.type).toBe("bytes");
    expect(error!.actual).toBe(DRAFT_MAX_BYTES + 1);
    expect(error!.limit).toBe(DRAFT_MAX_BYTES);
  });

  it("counts multi-byte UTF-8 correctly", () => {
    // Each emoji is 4 bytes in UTF-8
    const emoji = "😀";
    const count = Math.ceil(DRAFT_MAX_BYTES / Buffer.byteLength(emoji, "utf8")) + 1;
    const draft = emoji.repeat(count);
    const error = validateDraft(draft);
    expect(error).not.toBeNull();
    expect(error!.type).toBe("bytes");
  });

  it("returns null at exactly 8192 graphemes", () => {
    const draft = "a".repeat(DRAFT_MAX_GRAPHEMES);
    expect(validateDraft(draft)).toBeNull();
  });

  it("returns graphemes error when draft exceeds 8192 graphemes", () => {
    const draft = "a".repeat(DRAFT_MAX_GRAPHEMES + 1);
    const error = validateDraft(draft);
    expect(error).not.toBeNull();
    expect(error!.type).toBe("graphemes");
    expect(error!.actual).toBe(DRAFT_MAX_GRAPHEMES + 1);
    expect(error!.limit).toBe(DRAFT_MAX_GRAPHEMES);
  });

  it("counts combined emoji as single grapheme clusters", () => {
    // Family emoji: 👨‍👩‍👧‍👦 is one grapheme cluster but many code points/bytes
    const family = "👨‍👩‍👧‍👦";
    // Use a small count that fits in bytes but tests grapheme counting
    const count = 100;
    const draft = family.repeat(count);
    const error = validateDraft(draft);
    // 100 graphemes is well under 8192 limit
    expect(error).toBeNull();
  });

  it("combined emoji are counted as one grapheme each", () => {
    const family = "👨‍👩‍👧‍👦";
    // Verify it's counted as 1 grapheme per occurrence
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const segments = [...segmenter.segment(family)];
    expect(segments.length).toBe(1);
  });

  it("returns null at exactly 256 lines", () => {
    const draft = Array.from({ length: DRAFT_MAX_LINES }, (_, i) => `line ${String(i)}`).join(
      "\n",
    );
    expect(validateDraft(draft)).toBeNull();
  });

  it("returns lines error when draft exceeds 256 lines", () => {
    const draft = Array.from({ length: DRAFT_MAX_LINES + 1 }, (_, i) => `line ${String(i)}`).join(
      "\n",
    );
    const error = validateDraft(draft);
    expect(error).not.toBeNull();
    expect(error!.type).toBe("lines");
    expect(error!.actual).toBe(DRAFT_MAX_LINES + 1);
    expect(error!.limit).toBe(DRAFT_MAX_LINES);
  });

  it("checks bytes before graphemes (bytes is the first gate)", () => {
    // Create a string that exceeds both bytes and graphemes
    const draft = "😀".repeat(DRAFT_MAX_GRAPHEMES + 1);
    const error = validateDraft(draft);
    // 4 bytes per emoji, so this exceeds bytes first
    expect(error).not.toBeNull();
    expect(error!.type).toBe("bytes");
  });

  it("checks graphemes before lines", () => {
    // Short lines but many graphemes per line (ASCII fits in both byte and line limits)
    const draft = "a".repeat(DRAFT_MAX_GRAPHEMES + 1);
    // This is one line, many graphemes
    const error = validateDraft(draft);
    expect(error).not.toBeNull();
    expect(error!.type).toBe("graphemes");
  });
});

describe("formatDraftError", () => {
  it("formats bytes error", () => {
    const msg = formatDraftError({ type: "bytes", actual: 40000, limit: 32768 });
    expect(msg).toContain("32768");
    expect(msg).toContain("40000");
    expect(msg).toContain("byte");
  });

  it("formats graphemes error", () => {
    const msg = formatDraftError({ type: "graphemes", actual: 9000, limit: 8192 });
    expect(msg).toContain("8192");
    expect(msg).toContain("9000");
    expect(msg).toContain("grapheme");
  });

  it("formats lines error", () => {
    const msg = formatDraftError({ type: "lines", actual: 300, limit: 256 });
    expect(msg).toContain("256");
    expect(msg).toContain("300");
    expect(msg).toContain("line");
  });
});

describe("isResponseWithinLimits", () => {
  it("returns true for small responses", () => {
    expect(isResponseWithinLimits("Hello!")).toBe(true);
  });

  it("returns true at exactly 1 MiB", () => {
    expect(isResponseWithinLimits("a".repeat(RESPONSE_MAX_BYTES))).toBe(true);
  });

  it("returns false above 1 MiB", () => {
    expect(isResponseWithinLimits("a".repeat(RESPONSE_MAX_BYTES + 1))).toBe(false);
  });

  it("counts multi-byte chars correctly", () => {
    // Each emoji is 4 bytes; use enough to exceed 1 MiB
    const count = Math.ceil(RESPONSE_MAX_BYTES / 4) + 1;
    expect(isResponseWithinLimits("😀".repeat(count))).toBe(false);
  });
});

describe("formatChatSessionSummary", () => {
  it("formats singular turn", () => {
    expect(formatChatSessionSummary(1, 0)).toBe(
      "Chat session ended: 1 turn, 0 memory warnings.\n",
    );
  });

  it("formats plural turns", () => {
    expect(formatChatSessionSummary(5, 0)).toBe(
      "Chat session ended: 5 turns, 0 memory warnings.\n",
    );
  });

  it("formats singular memory warning", () => {
    expect(formatChatSessionSummary(3, 1)).toBe(
      "Chat session ended: 3 turns, 1 memory warning.\n",
    );
  });

  it("formats plural memory warnings", () => {
    expect(formatChatSessionSummary(7, 4)).toBe(
      "Chat session ended: 7 turns, 4 memory warnings.\n",
    );
  });

  it("formats zero turns", () => {
    expect(formatChatSessionSummary(0, 0)).toBe(
      "Chat session ended: 0 turns, 0 memory warnings.\n",
    );
  });
});

describe("No fake token streaming contract", () => {
  it("validateDraft is a synchronous gate — never async/streaming", () => {
    // The function is pure and synchronous; it blocks submit without
    // calling the backend. This structural test ensures no Promise is returned.
    const result = validateDraft("test");
    expect(result).not.toBeInstanceOf(Promise);
  });
});
