import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { createLibraryService, type LibraryService } from "../../src/library/service.js";

let home: string;
let config: Config;
let svc: LibraryService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-svc-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  svc = createLibraryService(config);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("library service", () => {
  it("creates an agent with a slug id derived from the name", () => {
    const agent = svc.create("agent", { name: "Code Reviewer", body: "Review." });
    expect(agent.id).toBe("code-reviewer");
    expect(agent.enabled).toBe(true);
    expect(svc.get("agent", "code-reviewer")).toEqual(agent);
  });

  it("disambiguates duplicate names", () => {
    svc.create("agent", { name: "Helper", body: "a" });
    const second = svc.create("agent", { name: "Helper", body: "b" });
    expect(second.id).toBe("helper-2");
  });

  it("applies a partial update without clobbering other fields", () => {
    svc.create("skill", { name: "Cite", body: "cite", description: "d" });
    const updated = svc.update("skill", "cite", { enabled: false });
    expect(updated.enabled).toBe(false);
    expect(updated.body).toBe("cite");
    expect(updated.description).toBe("d");
  });

  it("throws when updating or removing a missing item", () => {
    expect(() => svc.update("agent", "ghost", { enabled: false })).toThrow(/not found/);
    expect(() => svc.remove("agent", "ghost")).toThrow(/not found/);
  });

  it("removes an item", () => {
    svc.create("agent", { name: "Temp", body: "t" });
    svc.remove("agent", "temp");
    expect(svc.get("agent", "temp")).toBeUndefined();
  });

  it("composes a chat system prompt from enabled selections only", () => {
    svc.create("agent", { name: "Persona", body: "You are helpful." });
    svc.create("skill", { name: "Cite", body: "Always cite." });
    svc.create("skill", { name: "Off", body: "ignored", enabled: false });

    const prompt = svc.composeForChat("persona", ["cite", "off"]);
    expect(prompt).toContain("You are helpful.");
    expect(prompt).toContain("Always cite.");
    expect(prompt).not.toContain("ignored");
  });

  it("excludes a disabled agent from composition", () => {
    svc.create("agent", { name: "Persona", body: "You are helpful.", enabled: false });
    expect(svc.composeForChat("persona", [])).toBeUndefined();
  });

  it("auto-composes an agent's declared skills without explicit selection", () => {
    svc.create("skill", { name: "Solve", body: "Use sympy." });
    svc.create("skill", { name: "Plot", body: "Use matplotlib." });
    const agent = svc.create("agent", {
      name: "Equation Solver",
      body: "You solve equations.",
      skills: ["solve", "plot"],
    });
    expect(agent.skills).toEqual(["solve", "plot"]);

    const prompt = svc.composeForChat("equation-solver", []);
    expect(prompt).toContain("You solve equations.");
    expect(prompt).toContain("Use sympy.");
    expect(prompt).toContain("Use matplotlib.");
  });

  it("does not duplicate a skill supplied both by the agent and explicitly", () => {
    svc.create("skill", { name: "Solve", body: "SYMPY_BODY" });
    svc.create("agent", { name: "Solver", body: "persona", skills: ["solve"] });
    const prompt = svc.composeForChat("solver", ["solve"]) ?? "";
    expect(prompt.match(/SYMPY_BODY/g)?.length).toBe(1);
  });
});
