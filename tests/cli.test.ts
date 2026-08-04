import { describe, it, expect, vi } from "vitest";
import { COMMANDS, buildCli, type CommandName } from "../src/cli.js";

const EXPECTED_COMMANDS: CommandName[] = [
  "recommend",
  "up",
  "chat",
  "down",
  "switch",
  "migrate",
  "ls",
  "catalog",
  "doctor",
];

describe("command registry", () => {
  it("registers exactly the nine spec commands", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(EXPECTED_COMMANDS);
  });

  it("gives every command a non-empty description", () => {
    for (const command of COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("has unique command names", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("buildCli", () => {
  it("exposes all nine commands to cac", () => {
    const cli = buildCli();
    const registered = cli.commands.map((c) => c.name);
    for (const expected of EXPECTED_COMMANDS) {
      expect(registered).toContain(expected);
    }
  });

  it("renders help text listing every command", () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      chunks.push(args.map((a) => String(a)).join(" "));
    });
    try {
      buildCli().outputHelp();
    } finally {
      spy.mockRestore();
    }
    const help = chunks.join("\n");
    for (const expected of EXPECTED_COMMANDS) {
      expect(help).toContain(expected);
    }
  });
});
