import { afterEach, describe, it, expect, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  runUpMock: vi.fn<(options: { model: string; port?: number | undefined }) => Promise<void>>(),
}));

vi.mock("../src/commands/up.js", () => ({
  runUp: hoisted.runUpMock,
}));

import { COMMANDS, buildCli, type CommandName } from "../src/cli.js";

afterEach(() => {
  hoisted.runUpMock.mockReset();
  process.exitCode = undefined;
});

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

  it("documents down detach+forget semantics in the command description", () => {
    const down = COMMANDS.find((c) => c.name === "down");
    expect(down).toBeDefined();
    expect(down?.description).toContain("detach+forget");
    expect(down?.description).toContain("without stopping");
  });

  it("documents ls active-only semantics in the command description", () => {
    const ls = COMMANDS.find((c) => c.name === "ls");
    expect(ls).toBeDefined();
    expect(ls?.description).toContain("active server state");
    expect(ls?.description).toContain("not installed-model inventory");
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

  it("rejects out-of-range up --port values at the CLI boundary", async () => {
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    try {
      const cli = buildCli();
      await cli.parse(["node", "local-llmup", "up", "llama3.1:8b", "--port", "0"]);
      await cli.parse(["node", "local-llmup", "up", "llama3.1:8b", "--port", "65536"]);
    } finally {
      stderr.mockRestore();
    }

    expect(hoisted.runUpMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const out = writes.join("");
    expect(out).toContain("up: invalid --port 0 (expected an integer in 1..65535)");
    expect(out).toContain("up: invalid --port 65536 (expected an integer in 1..65535)");
  });

  it("accepts boundary up --port values and forwards numeric ports", async () => {
    hoisted.runUpMock.mockResolvedValue(undefined);
    const cli = buildCli();

    await cli.parse(["node", "local-llmup", "up", "llama3.1:8b", "--port", "1"]);
    await cli.parse(["node", "local-llmup", "up", "llama3.1:8b", "--port", "65535"]);

    expect(hoisted.runUpMock).toHaveBeenCalledTimes(2);
    expect(hoisted.runUpMock).toHaveBeenNthCalledWith(1, { model: "llama3.1:8b", port: 1 });
    expect(hoisted.runUpMock).toHaveBeenNthCalledWith(2, { model: "llama3.1:8b", port: 65535 });
  });
});
