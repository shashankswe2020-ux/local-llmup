import { describe, expect, it } from "vitest";
import { stripControl } from "../src/sanitize.js";

describe("stripControl", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["CSI color sequence", "\u001b[31mred\u001b[0m", "red"],
    ["standalone ESC Fe", "a\u001bMb", "ab"],
    ["C0 control (NUL/newline/tab)", "a\u0000b\nc\td", "abcd"],
    ["DEL (0x7f)", "a\u007fb", "ab"],
    ["C1 control (0x80)", "a\u0080b", "ab"],
    ["8-bit CSI (0x9b)", "a\u009bb", "ab"],
    ["zero-width space", "a\u200bb", "ab"],
    ["BiDi override", "a\u202eb", "ab"],
    ["BOM / zero-width no-break", "a\ufeffb", "ab"],
    ["line separator", "a\u2028b", "ab"],
    ["Arabic Letter Mark (bidi)", "a\u061cb", "ab"],
    ["soft hyphen", "a\u00adb", "ab"],
    ["word joiner", "a\u2060b", "ab"],
  ];

  for (const [name, input, expected] of cases) {
    it(`removes ${name}`, () => {
      expect(stripControl(input)).toBe(expected);
    });
  }

  it("leaves ordinary printable text untouched", () => {
    expect(stripControl("llama3.1:8b — 6 GB (apache-2.0)")).toBe("llama3.1:8b — 6 GB (apache-2.0)");
  });
});
