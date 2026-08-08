import { describe, expect, it } from "vitest";
import { renderJson, renderTable, type Column } from "../src/output.js";

const COLUMNS: readonly Column[] = [
  { header: "Rank", align: "right" },
  { header: "Model" },
  { header: "RAM", align: "right" },
];

describe("renderTable", () => {
  it("aligns columns to the widest cell and respects alignment", () => {
    const out = renderTable(COLUMNS, [
      ["1", "llama3.1:8b", "6 GB"],
      ["2", "gemma2:2b", "2 GB"],
    ]);
    const [header, row1, row2] = out.split("\n");
    // "Model" column is 11 wide ("llama3.1:8b"); "gemma2:2b" is left-padded.
    expect(header).toBe("Rank  Model         RAM");
    expect(row1).toBe("   1  llama3.1:8b  6 GB");
    expect(row2).toBe("   2  gemma2:2b    2 GB");
  });

  it("renders just the header when there are no rows", () => {
    expect(renderTable(COLUMNS, [])).toBe("Rank  Model  RAM");
  });

  it("strips ANSI and control characters so they cannot break alignment", () => {
    const out = renderTable(
      [{ header: "Model" }, { header: "Note" }],
      [
        ["\u001b[31mllama\u001b[0m", "ok\u0000"],
        ["gemma\u200b", "fine"],
      ],
    );
    expect(out.includes("\u001b")).toBe(false);
    expect(out.includes("\u0000")).toBe(false);
    expect(out.includes("\u200b")).toBe(false);
    const [header, row1, row2] = out.split("\n");
    expect(header).toBe("Model  Note");
    // "llama" and "gemma" both 5 wide → aligned; escapes did not inflate width.
    expect(row1).toBe("llama  ok");
    expect(row2).toBe("gemma  fine");
  });

  it("pads short rows and never leaves trailing whitespace", () => {
    const out = renderTable([{ header: "A" }, { header: "B" }], [["x", ""]]);
    for (const line of out.split("\n")) expect(line).toBe(line.replace(/ +$/u, ""));
  });
});

describe("renderJson", () => {
  it("produces stable, pretty, parseable JSON preserving key order", () => {
    const out = renderJson({ rank: 1, model: "llama3.1:8b", fits: true });
    expect(out).toBe('{\n  "rank": 1,\n  "model": "llama3.1:8b",\n  "fits": true\n}');
    expect(JSON.parse(out)).toEqual({ rank: 1, model: "llama3.1:8b", fits: true });
  });

  it("strips control characters from nested string values and keys", () => {
    const out = renderJson({ "a\u0000": ["x\u001b[31my", { b: "z\u200b" }] });
    expect(out.includes("\u0000")).toBe(false);
    expect(out.includes("\u200b")).toBe(false);
    expect(out.includes("\u001b")).toBe(false);
    expect(JSON.parse(out)).toEqual({ a: ["xy", { b: "z" }] });
  });

  it("passes through numbers, booleans, and null unchanged", () => {
    const out = renderJson({ n: 3.5, t: true, f: false, z: null, arr: [1, 2] });
    expect(JSON.parse(out)).toEqual({ n: 3.5, t: true, f: false, z: null, arr: [1, 2] });
  });
});
