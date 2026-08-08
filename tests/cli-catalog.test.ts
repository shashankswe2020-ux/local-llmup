import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  runCatalogMock:
    vi.fn<
      (options: { all?: boolean | undefined; refresh?: boolean | undefined }) => Promise<void>
    >(),
}));

vi.mock("../src/commands/catalog.js", () => ({
  runCatalog: hoisted.runCatalogMock,
}));

import { buildCli } from "../src/cli.js";

afterEach(() => {
  hoisted.runCatalogMock.mockReset();
  process.exitCode = undefined;
});

describe("catalog CLI wiring", () => {
  it("registers --all and --refresh options", () => {
    const cli = buildCli();
    const command = cli.commands.find((c) => c.name === "catalog");
    expect(command).toBeDefined();
    const names = command?.options.map((option) => option.name) ?? [];
    expect(names).toContain("all");
    expect(names).toContain("refresh");
  });

  it("forwards --all and --refresh flags to runCatalog", async () => {
    hoisted.runCatalogMock.mockResolvedValueOnce();
    const cli = buildCli();

    await cli.parse(["node", "local-llmup", "catalog", "--all", "--refresh"]);

    expect(hoisted.runCatalogMock).toHaveBeenCalledOnce();
    expect(hoisted.runCatalogMock).toHaveBeenCalledWith({ all: true, refresh: true });
  });

  it("writes a prefixed catalog error and sets exitCode=1 on failure", async () => {
    hoisted.runCatalogMock.mockRejectedValueOnce(new Error("boom"));
    const writes: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });

    try {
      const cli = buildCli();
      await cli.parse(["node", "local-llmup", "catalog"]);
    } finally {
      stderr.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("catalog: boom");
  });
});
