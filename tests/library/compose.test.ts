import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../../src/library/compose.js";
import type { LibraryItem } from "../../src/library/schema.js";

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "x",
  name: "X",
  description: "",
  enabled: true,
  body: "",
  skills: [],
  ...over,
});

describe("composeSystemPrompt", () => {
  it("returns undefined with no usable content", () => {
    expect(composeSystemPrompt(undefined, [])).toBeUndefined();
    expect(composeSystemPrompt(item({ body: "   " }), [item({ body: "" })])).toBeUndefined();
  });

  it("uses the agent body alone", () => {
    expect(composeSystemPrompt(item({ body: "You are terse." }), [])).toBe("You are terse.");
  });

  it("renders skills under a heading", () => {
    const out = composeSystemPrompt(undefined, [
      item({ id: "cite", name: "Cite", body: "Always cite." }),
    ]);
    expect(out).toContain("# Skills");
    expect(out).toContain("## Cite");
    expect(out).toContain("Always cite.");
  });

  it("combines agent then skills", () => {
    const out = composeSystemPrompt(item({ body: "Persona." }), [
      item({ id: "s", name: "S", body: "Skill body." }),
    ]);
    expect(out?.indexOf("Persona.")).toBeLessThan(out?.indexOf("# Skills") ?? -1);
  });
});
