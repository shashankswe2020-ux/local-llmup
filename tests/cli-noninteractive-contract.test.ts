import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  recommend: vi.fn(() => Promise.resolve()),
  canRun: vi.fn(() => Promise.resolve({ runnable: "yes" as const })),
  up: vi.fn(() => Promise.resolve()),
  chat: vi.fn(() => Promise.resolve()),
  down: vi.fn(() => Promise.resolve()),
  switchModel: vi.fn(() => Promise.resolve()),
  migrate: vi.fn(() => Promise.resolve()),
  ls: vi.fn(),
  catalog: vi.fn(() => Promise.resolve()),
  doctor: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock("../src/commands/recommend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/recommend.js")>();
  return { ...actual, runRecommend: hoisted.recommend };
});
vi.mock("../src/commands/can-run.js", () => ({ runCanRun: hoisted.canRun }));
vi.mock("../src/commands/up.js", () => ({ runUp: hoisted.up }));
vi.mock("../src/commands/chat.js", () => ({ runChat: hoisted.chat }));
vi.mock("../src/commands/down.js", () => ({ runDown: hoisted.down }));
vi.mock("../src/commands/switch.js", () => ({ runSwitch: hoisted.switchModel }));
vi.mock("../src/commands/migrate.js", () => ({ runMigrate: hoisted.migrate }));
vi.mock("../src/commands/ls.js", () => ({ runLs: hoisted.ls }));
vi.mock("../src/commands/catalog.js", () => ({ runCatalog: hoisted.catalog }));
vi.mock("../src/commands/doctor.js", () => ({ runDoctor: hoisted.doctor }));

import { buildCli, type CommandName } from "../src/cli.js";

interface CliCase {
  readonly name: CommandName | "recommend-default";
  readonly errorPrefix: CommandName;
  readonly argv: readonly string[];
  readonly mock: ReturnType<typeof vi.fn>;
}

const CASES: readonly CliCase[] = [
  { name: "recommend-default", errorPrefix: "recommend", argv: [], mock: hoisted.recommend },
  { name: "recommend", errorPrefix: "recommend", argv: ["recommend"], mock: hoisted.recommend },
  {
    name: "can-run",
    errorPrefix: "can-run",
    argv: ["can-run", "llama3.1:8b"],
    mock: hoisted.canRun,
  },
  { name: "up", errorPrefix: "up", argv: ["up", "llama3.1:8b"], mock: hoisted.up },
  { name: "chat", errorPrefix: "chat", argv: ["chat"], mock: hoisted.chat },
  { name: "down", errorPrefix: "down", argv: ["down"], mock: hoisted.down },
  {
    name: "switch",
    errorPrefix: "switch",
    argv: ["switch", "qwen2.5:7b"],
    mock: hoisted.switchModel,
  },
  {
    name: "migrate",
    errorPrefix: "migrate",
    argv: ["migrate", "--from", "llama3.1:8b", "--to", "qwen2.5:7b"],
    mock: hoisted.migrate,
  },
  { name: "ls", errorPrefix: "ls", argv: ["ls"], mock: hoisted.ls },
  { name: "catalog", errorPrefix: "catalog", argv: ["catalog"], mock: hoisted.catalog },
  { name: "doctor", errorPrefix: "doctor", argv: ["doctor"], mock: hoisted.doctor },
];

function captureWrites(): { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return { stdout, stderr };
}

afterEach(() => {
  for (const testCase of CASES) testCase.mock.mockReset();
  hoisted.recommend.mockResolvedValue(undefined);
  hoisted.canRun.mockResolvedValue({ runnable: "yes" });
  hoisted.up.mockResolvedValue(undefined);
  hoisted.chat.mockResolvedValue(undefined);
  hoisted.down.mockResolvedValue(undefined);
  hoisted.switchModel.mockResolvedValue(undefined);
  hoisted.migrate.mockResolvedValue(undefined);
  hoisted.ls.mockReturnValue(undefined);
  hoisted.catalog.mockResolvedValue(undefined);
  hoisted.doctor.mockResolvedValue({ ok: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("U0a CLI noninteractive contract", () => {
  it.each(CASES)("dispatches $name once without changing exit code", async (testCase) => {
    const output = captureWrites();

    await buildCli().parse(["node", "local-llmup", ...testCase.argv]);

    expect(testCase.mock).toHaveBeenCalledTimes(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it.each(CASES)("routes $name failures only to stderr and exits 1", async (testCase) => {
    const output = captureWrites();
    if (testCase.errorPrefix === "ls") testCase.mock.mockImplementationOnce(() => {
      throw new Error("contract failure");
    });
    else testCase.mock.mockRejectedValueOnce(new Error("contract failure"));

    await buildCli().parse(["node", "local-llmup", ...testCase.argv]);

    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("")).toBe(`${testCase.errorPrefix}: contract failure\n`);
    expect(process.exitCode).toBe(1);
  });

  it("preserves can-run no and doctor failure exit contracts", async () => {
    captureWrites();
    hoisted.canRun.mockResolvedValueOnce({ runnable: "no" });
    await buildCli().parse(["node", "local-llmup", "can-run", "llama3.1:8b"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    hoisted.doctor.mockResolvedValueOnce({ ok: false });
    await buildCli().parse(["node", "local-llmup", "doctor"]);
    expect(process.exitCode).toBe(1);
  });
});
