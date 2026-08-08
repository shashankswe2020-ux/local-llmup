import { describe, expect, it } from "vitest";
import { createUiKeyDecoder, type UiKey } from "../../src/tui/keys.js";

function key(overrides: Partial<UiKey> = {}): UiKey {
  return {
    upArrow: false,
    downArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    tab: false,
    shift: false,
    ctrl: false,
    ...overrides,
  };
}

describe("decodeUiKey", () => {
  it.each([
    ["", key({ upArrow: true }), "move_up"],
    ["k", key(), "move_up"],
    ["", key({ downArrow: true }), "move_down"],
    ["j", key(), "move_down"],
    ["", key({ pageUp: true }), "page_up"],
    ["", key({ pageDown: true }), "page_down"],
    ["\u001b[H", key(), "first"],
    ["\u001b[F", key(), "last"],
    ["/", key(), "search"],
    ["", key({ return: true }), "accept"],
    [" ", key(), "toggle"],
    ["", key({ tab: true }), "focus_next"],
    ["", key({ tab: true, shift: true }), "focus_previous"],
    ["", key({ escape: true }), "back"],
    ["?", key(), "help"],
    ["q", key(), "quit"],
    ["c", key({ ctrl: true }), "cancel"],
  ] as const)("maps documented key %#", (input, pressed, action) => {
    expect(createUiKeyDecoder().decode(input, pressed)).toBe(action);
  });

  it("ignores undocumented keys and prevents single-key destructive actions", () => {
    for (const input of ["d", "x", "y", "!", "\u001b]8;;https://example.test\u0007"]) {
      expect(createUiKeyDecoder().decode(input, key())).toBeNull();
    }
  });

  it("ignores shortcuts while text input is focused except Ctrl+C", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("q", key(), { textInputFocused: true })).toBeNull();
    expect(decoder.decode("", key({ upArrow: true }), { textInputFocused: true })).toBeNull();
    expect(decoder.decode("c", key({ ctrl: true }), { textInputFocused: true })).toBe("cancel");
  });

  it("ignores bracketed-paste content outside text editors", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001b[200~", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode(" ", key())).toBeNull();
    expect(decoder.decode("\u001b[201~", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("suppresses pasted Ctrl+C and fragmented paste markers", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001b", key())).toBeNull();
    expect(decoder.decode("[20", key())).toBeNull();
    expect(decoder.decode("0~", key())).toBeNull();
    expect(decoder.decode("c", key({ ctrl: true }))).toBeNull();
    expect(decoder.decode("\u001b", key())).toBeNull();
    expect(decoder.decode("[201~", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("suppresses coalesced paste start plus payload", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001b[200~q ", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode("\u001b[201~", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("ignores unknown OSC/control sequence contents", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001b]0;", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode("\u0007", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("suppresses fragmented OSC but recovers after a complete unknown CSI", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001b", key())).toBeNull();
    expect(decoder.decode("]0;", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode("\u0007", key())).toBeNull();
    expect(decoder.decode("\u001b[3~", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("recognizes a split OSC ST terminator", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001b]0;", key())).toBeNull();
    expect(decoder.decode("title", key())).toBeNull();
    expect(decoder.decode("\u001b", key())).toBeNull();
    expect(decoder.decode("\\", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("suppresses C1 terminal-string payloads until C1 ST", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u009d", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode("\u009c", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it.each(["\u009b", "\u008f"])("suppresses fragmented C1 finite sequence %j", (introducer) => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode(introducer, key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("allows BEL to terminate OSC but not DCS", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001bPpayload", key())).toBeNull();
    expect(decoder.decode("\u0007", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode("\u001b\\", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("suppresses fragmented 7-bit SOS payload until ST", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode("\u001bX", key())).toBeNull();
    expect(decoder.decode("q", key())).toBeNull();
    expect(decoder.decode(" ", key())).toBeNull();
    expect(decoder.decode("\u0003", key({ ctrl: true }))).toBeNull();
    expect(decoder.decode("\u0007", key())).toBeNull();
    expect(decoder.decode("\u001b\\", key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });

  it("maps raw ETX to controlled cancellation outside paste", () => {
    expect(createUiKeyDecoder().decode("\u0003", key({ ctrl: true }))).toBe("cancel");
  });

  it("caps oversized incomplete CSI input and recovers for the next key", () => {
    const decoder = createUiKeyDecoder();
    expect(decoder.decode(`\u001b[${"1".repeat(1_000_000)}`, key())).toBeNull();
    expect(decoder.decode("q", key())).toBe("quit");
  });
});
