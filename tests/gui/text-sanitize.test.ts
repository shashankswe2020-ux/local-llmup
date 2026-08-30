import { describe, expect, it } from "vitest";
import { GuiTextStreamSanitizer, sanitizeGuiText } from "../../src/gui/text-sanitize.js";

describe("sanitizeGuiText", () => {
  it("normalizes line endings while preserving line feeds and tabs", () => {
    expect(sanitizeGuiText("# Title\r\n\rParagraph\tvalue\n```ts\rconst x = 1;\r```"))
      .toBe("# Title\n\nParagraph\tvalue\n```ts\nconst x = 1;\n```");
  });

  it("removes terminal escapes, unsafe controls, bidi, and invisible characters", () => {
    const input = "safe\u001b[31m red\u001b[0m\u0000\u0008\u0085\u202e\u200b\u2060 text\nnext";
    expect(sanitizeGuiText(input)).toBe("safe red text\nnext");
  });

  it("removes OSC and other ECMA-48 control strings with their payloads", () => {
    const input = [
      "before",
      "\u001b]8;;https://example.com\u0007linked\u001b]8;;\u001b\\",
      "\u001b]52;c;Y2xpcGJvYXJk\u0007",
      "\u001bPprivate payload\u001b\\",
      "\u001bXservice message\u001b\\",
      "\u001b^privacy message\u001b\\",
      "\u001b_application command\u001b\\",
      "after",
    ].join("");

    expect(sanitizeGuiText(input)).toBe("beforelinkedafter");
  });

  it("is idempotent", () => {
    const once = sanitizeGuiText("a\r\nb\t\u001b[2Jc\u202e");
    expect(sanitizeGuiText(once)).toBe(once);
  });

  it("normalizes CRLF and removes ANSI when sequences cross stream chunks", () => {
    const sanitizer = new GuiTextStreamSanitizer();
    const output = [
      sanitizer.push("# Result\r"),
      sanitizer.push("\n\r\n```ts\r\nconst value = 1;\r\n```\t\u001b["),
      sanitizer.push("31mred\u001b[0"),
      sanitizer.push("m\u202e"),
      sanitizer.flush(),
    ].join("");

    expect(output).toBe("# Result\n\n```ts\nconst value = 1;\n```\tred");
  });

  it("drops fragmented OSC, DCS, SOS, PM, and APC strings at every boundary", () => {
    const source = "safe\u001b]52;c;Y2xpcGJvYXJk\u001b\\middle\u001bPprivate\u001b\\\u001bXservice\u001b\\\u001b^privacy\u001b\\\u001b_command\u001b\\end";
    for (let boundary = 1; boundary < source.length; boundary += 1) {
      const sanitizer = new GuiTextStreamSanitizer();
      const output = [
        sanitizer.push(source.slice(0, boundary)),
        sanitizer.push(source.slice(boundary)),
        sanitizer.flush(),
      ].join("");
      expect(output).toBe("safemiddleend");
    }
  });

  it("treats BEL as an OSC terminator but as payload in other control strings", () => {
    for (const starter of ["P", "X", "^", "_"]) {
      const source = `safe\u001b${starter}hidden\u0007still hidden\u001b\\end`;
      for (let boundary = 1; boundary < source.length; boundary += 1) {
        const sanitizer = new GuiTextStreamSanitizer();
        const output = [
          sanitizer.push(source.slice(0, boundary)),
          sanitizer.push(source.slice(boundary)),
          sanitizer.flush(),
        ].join("");
        expect(output).toBe("safeend");
      }
    }
    expect(sanitizeGuiText("safe\u001b]title\u0007end")).toBe("safeend");
  });
});
