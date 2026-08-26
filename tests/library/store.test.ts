import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import {
  deleteItem,
  itemExists,
  listItems,
  readItem,
  writeItem,
} from "../../src/library/store.js";
import type { LibraryItem } from "../../src/library/schema.js";

let home: string;
let config: Config;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-lib-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const agent: LibraryItem = {
  id: "code-reviewer",
  name: "Code Reviewer",
  description: "Reviews code carefully",
  enabled: true,
  body: "You are a meticulous code reviewer.",
  skills: [],
};

describe("library store", () => {
  it("writes and reads an agent at agents/<id>.md", () => {
    writeItem(config, "agent", agent);
    expect(existsSync(join(home, "agents", "code-reviewer.md"))).toBe(true);
    expect(readItem(config, "agent", "code-reviewer")).toEqual(agent);
  });

  it("writes a skill at skills/<id>/SKILL.md", () => {
    const skill: LibraryItem = { ...agent, id: "cite-sources", name: "Cite Sources" };
    writeItem(config, "skill", skill);
    expect(existsSync(join(home, "skills", "cite-sources", "SKILL.md"))).toBe(true);
    expect(readItem(config, "skill", "cite-sources")).toEqual(skill);
  });

  it("round-trips a disabled flag", () => {
    writeItem(config, "agent", { ...agent, enabled: false });
    expect(readItem(config, "agent", "code-reviewer")?.enabled).toBe(false);
  });

  it("lists items sorted, skipping non-matching files", () => {
    writeItem(config, "agent", agent);
    writeItem(config, "agent", { ...agent, id: "aaa", name: "A" });
    writeFileSync(join(home, "agents", "notes.txt"), "ignore me");
    const ids = listItems(config, "agent").map((i) => i.id);
    expect(ids).toEqual(["aaa", "code-reviewer"]);
  });

  it("returns undefined for a missing item and empty list for a missing dir", () => {
    expect(readItem(config, "agent", "nope")).toBeUndefined();
    expect(listItems(config, "skill")).toEqual([]);
  });

  it("reports existence", () => {
    expect(itemExists(config, "agent", "code-reviewer")).toBe(false);
    writeItem(config, "agent", agent);
    expect(itemExists(config, "agent", "code-reviewer")).toBe(true);
  });

  it("rejects an invalid id", () => {
    expect(() => readItem(config, "agent", "../escape")).toThrow();
  });

  it("skips a group/other-writable document when listing", () => {
    writeItem(config, "agent", agent);
    chmodSync(join(home, "agents", "code-reviewer.md"), 0o666);
    expect(listItems(config, "agent")).toEqual([]);
    expect(() => readItem(config, "agent", "code-reviewer")).toThrow(/writable/);
  });

  it("deletes an agent file and a skill directory", () => {
    writeItem(config, "agent", agent);
    deleteItem(config, "agent", "code-reviewer");
    expect(existsSync(join(home, "agents", "code-reviewer.md"))).toBe(false);

    const skill: LibraryItem = { ...agent, id: "s1", name: "S" };
    writeItem(config, "skill", skill);
    deleteItem(config, "skill", "s1");
    expect(existsSync(join(home, "skills", "s1"))).toBe(false);
  });

  it("persists a frontmatter header the reader recognizes", () => {
    writeItem(config, "agent", agent);
    const raw = readFileSync(join(home, "agents", "code-reviewer.md"), "utf8");
    expect(raw.startsWith("---\nname: Code Reviewer\n")).toBe(true);
    expect(raw).toContain("enabled: true");
  });

  it("tolerates an externally created file without frontmatter", () => {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "raw.md"), "plain body only");
    const item = readItem(config, "agent", "raw");
    expect(item?.name).toBe("raw");
    expect(item?.enabled).toBe(true);
    expect(item?.body).toBe("plain body only");
  });

  it("round-trips an agent's declared skill ids", () => {
    writeItem(config, "agent", { ...agent, skills: ["solve", "plot"] });
    const raw = readFileSync(join(home, "agents", "code-reviewer.md"), "utf8");
    expect(raw).toMatch(/skills:.*solve.*plot/);
    expect(readItem(config, "agent", "code-reviewer")?.skills).toEqual(["solve", "plot"]);
  });
});
