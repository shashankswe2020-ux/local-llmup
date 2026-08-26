import { describe, expect, it } from "vitest";
import { parseDocument, serializeDocument } from "../../src/library/frontmatter.js";

describe("frontmatter", () => {
  it("parses a fenced frontmatter block and body", () => {
    const doc = parseDocument(
      ['---', 'name: Code Reviewer', 'description: Reviews code', 'enabled: true', '---', '', 'You are a reviewer.', ''].join("\n"),
    );
    expect(doc.frontmatter).toEqual({
      name: "Code Reviewer",
      description: "Reviews code",
      enabled: "true",
    });
    expect(doc.body).toBe("You are a reviewer.");
  });

  it("treats a document without a fence as pure body", () => {
    const doc = parseDocument("just a body\nsecond line");
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("just a body\nsecond line");
  });

  it("unwraps quoted values including colons", () => {
    const doc = parseDocument(['---', 'description: "Cite: always"', '---', 'body'].join("\n"));
    expect(doc.frontmatter.description).toBe("Cite: always");
  });

  it("treats an unterminated fence as body (fail-soft)", () => {
    const doc = parseDocument("---\nname: broken\nstill going");
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toContain("name: broken");
  });

  it("round-trips through serialize and parse", () => {
    const serialized = serializeDocument(
      { name: "My Skill", description: "Uses a: colon", enabled: "false" },
      "Do the thing.",
    );
    const doc = parseDocument(serialized);
    expect(doc.frontmatter).toEqual({ name: "My Skill", description: "Uses a: colon", enabled: "false" });
    expect(doc.body).toBe("Do the thing.");
  });

  it("serializes an empty frontmatter map as the body alone", () => {
    expect(serializeDocument({}, "only body")).toBe("only body\n");
  });

  it("quotes values needing escaping", () => {
    const out = serializeDocument({ description: 'has "quotes"' }, "b");
    expect(out).toContain('description: "has \\"quotes\\""');
    expect(parseDocument(out).frontmatter.description).toBe('has "quotes"');
  });
});
