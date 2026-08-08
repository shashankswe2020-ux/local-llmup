import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import {
  TERMINAL_TEXT_LIMITS,
  assertTerminalFrameSize,
  createTerminalFrameBuilder,
  createTerminalMessageBuffer,
  sanitizeActionIdentifier,
  sanitizeTerminalText,
} from "../../src/tui/sanitize.js";

// eslint-disable-next-line no-control-regex -- security assertion must detect raw terminal controls
const UNSAFE_OUTPUT_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

describe("sanitizeTerminalText", () => {
  it("pins every normative terminal byte/count limit", () => {
    expect(TERMINAL_TEXT_LIMITS).toEqual({
      cellBytes: 256,
      detailBytes: 8 * 1024,
      chatVisibleMessageBytes: 64 * 1024,
      frameBytes: 256 * 1024,
      inputBytes: 1024 * 1024,
      retainedMessageBytes: 50 * 1024,
      retainedMessageCount: 200,
    });
  });

  it("visibly escapes terminal controls, bidi/default-ignorables, and invalid surrogates", () => {
    const input = "a\u001b]0;owned\u0007b\u202ec\u200bd\ud800e";
    const result = sanitizeTerminalText(input, "single_line");
    expect(result).toBe("a\\u{1B}]0;owned\\u{7}b\\u{202E}c\\u{200B}d\\u{D800}e");
    expect(result).not.toMatch(UNSAFE_OUTPUT_RE);
  });

  it.each(["\u034f", "\u115f", "\u17b4", "\u180b", "\u3164", "\ufe00", "\u{e0001}", "\u{e007f}"])(
    "visibly escapes Unicode default-ignorable %j",
    (value) => {
      const result = sanitizeTerminalText(`a${value}b`, "single_line");
      expect(result).toMatch(/^a\\u\{[0-9A-F]+\}b$/u);
      expect(result).not.toContain(value);
    },
  );

  it("prevents single-line row spoofing but preserves normalized multiline newlines", () => {
    expect(sanitizeTerminalText("one\r\ntwo\rthree\nfour\tfive", "single_line")).toBe(
      "one\\ntwo\\nthree\\nfour  five",
    );
    expect(sanitizeTerminalText("one\r\ntwo\rthree\nfour\tfive", "multiline")).toBe(
      "one\ntwo\nthree\nfour  five",
    );
  });

  it("normalizes prose to NFC only after unsafe values are escaped", () => {
    expect(sanitizeTerminalText("Cafe\u0301 \u202e", "single_line")).toBe(
      "Café \\u{202E}",
    );
  });

  it("keeps canonical ASCII action characters and visibly escapes every invalid character", () => {
    expect(sanitizeTerminalText("qwen3:14b/Q4_K_M", "action_identifier")).toBe(
      "qwen3:14b/Q4_K_M",
    );
    expect(sanitizeTerminalText("qwen 3:模型?", "action_identifier")).toBe(
      "qwen\\u{20}3:\\u{6A21}\\u{578B}\\u{3F}",
    );
  });

  it("truncates only at grapheme boundaries and accounts for the ellipsis", () => {
    const flag = "🇺🇳";
    const result = sanitizeTerminalText(`${flag}${flag}`, "single_line", {
      maxBytes: Buffer.byteLength(flag, "utf8") + Buffer.byteLength("…", "utf8"),
    });
    expect(result).toBe(`${flag}…`);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      Buffer.byteLength(flag, "utf8") + 3,
    );
  });

  it("uses terminal cell width without splitting wide or combining graphemes", () => {
    expect(
      sanitizeTerminalText("A界e\u0301Z", "single_line", { maxBytes: 256, maxColumns: 4 }),
    ).toBe("A界…");
  });

  it("enforces cell, detail, and visible-chat byte limits", () => {
    const cell = sanitizeTerminalText("x".repeat(1_000), "single_line");
    const detail = sanitizeTerminalText("x".repeat(20_000), "multiline");
    const chat = sanitizeTerminalText("🙂".repeat(20_000), "multiline", {
      maxBytes: TERMINAL_TEXT_LIMITS.chatVisibleMessageBytes,
      profile: "chat_visible",
    });
    expect(Buffer.byteLength(cell, "utf8")).toBeLessThanOrEqual(
      TERMINAL_TEXT_LIMITS.cellBytes,
    );
    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(
      TERMINAL_TEXT_LIMITS.detailBytes,
    );
    expect(Buffer.byteLength(chat, "utf8")).toBeLessThanOrEqual(
      TERMINAL_TEXT_LIMITS.chatVisibleMessageBytes,
    );
  });

  it("returns an empty string when a byte budget cannot hold an ellipsis", () => {
    expect(sanitizeTerminalText("hello", "single_line", { maxBytes: 2 })).toBe("");
  });

  it("never permits overrides above the selected context cap", () => {
    expect(() =>
      sanitizeTerminalText("x", "single_line", {
        maxBytes: TERMINAL_TEXT_LIMITS.cellBytes + 1,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      sanitizeTerminalText("x", "multiline", {
        maxBytes: TERMINAL_TEXT_LIMITS.chatVisibleMessageBytes,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      sanitizeTerminalText("x", "single_line", { profile: "chat_visible" }),
    ).toThrow(ValidationError);
  });

  it("never splits a visible escape token during truncation", () => {
    expect(sanitizeTerminalText("\u0000x", "single_line", { maxBytes: 4 })).toBe("…");
  });

  it("rejects oversized sanitizer input before escape expansion", () => {
    expect(() => sanitizeTerminalText("\u0000".repeat(TERMINAL_TEXT_LIMITS.inputBytes + 1), "single_line"))
      .toThrow(ValidationError);
  });

  it("separates action validation from escaped display", () => {
    const isModelId = (value: string): boolean => /^[a-z0-9._:/-]+$/u.test(value);
    expect(sanitizeActionIdentifier("qwen3:14b", isModelId)).toEqual({
      actionable: true,
      canonical: "qwen3:14b",
      display: "qwen3:14b",
    });
    expect(sanitizeActionIdentifier("Qwen 3", isModelId)).toEqual({
      actionable: false,
      display: "\\u{51}wen\\u{20}3",
    });
  });
});

describe("terminal frame and retained-message bounds", () => {
  it("accepts a frame at the cap and rejects one byte over", () => {
    expect(() => assertTerminalFrameSize("x".repeat(TERMINAL_TEXT_LIMITS.frameBytes))).not.toThrow();
    expect(() =>
      assertTerminalFrameSize("x".repeat(TERMINAL_TEXT_LIMITS.frameBytes + 1)),
    ).toThrow(ValidationError);
  });

  it("prevents oversized frames during incremental construction", () => {
    const frame = createTerminalFrameBuilder();
    frame.append("x".repeat(TERMINAL_TEXT_LIMITS.frameBytes));
    expect(() => frame.append("x")).toThrow(ValidationError);
    expect(Buffer.byteLength(frame.build(), "utf8")).toBe(TERMINAL_TEXT_LIMITS.frameBytes);
  });

  it("retains at most 200 messages and 50 KiB", () => {
    const buffer = createTerminalMessageBuffer();
    for (let index = 0; index < 205; index += 1) buffer.append(`message-${String(index)}`);
    expect(buffer.snapshot()).toHaveLength(TERMINAL_TEXT_LIMITS.retainedMessageCount);
    expect(buffer.snapshot()[0]).toBe("message-5");

    for (let index = 0; index < 20; index += 1) buffer.append("x".repeat(8_000));
    expect(buffer.bytes()).toBeLessThanOrEqual(TERMINAL_TEXT_LIMITS.retainedMessageBytes);
    expect(buffer.snapshot().length).toBeLessThanOrEqual(
      TERMINAL_TEXT_LIMITS.retainedMessageCount,
    );
  });
});
