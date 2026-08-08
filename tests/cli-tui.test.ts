import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  selection: {
    mode: "plain" as "plain" | "json" | "tui" | "accessible",
    explicit: false,
    reason: "stdin_not_tty" as string | null,
    color: false,
    unicode: false,
  },
  resolveMode: vi.fn(),
  plainRecommend: vi.fn(async () => ({ entries: [] })),
  plainCanRun: vi.fn(async () => ({ runnable: "yes" as const })),
  plainDoctor: vi.fn(async () => ({ ok: true })),
  plainCatalog: vi.fn(async () => ({ rows: [] })),
  plainLs: vi.fn(() => ({ type: "empty" as const })),
  interactiveRecommend: vi.fn(async () => ({ entries: [] })),
  interactiveCanRun: vi.fn(async () => ({ runnable: "yes" as const })),
  interactiveDoctor: vi.fn(async () => ({ ok: true })),
  interactiveCatalog: vi.fn(async () => ({ rows: [] })),
  interactiveLs: vi.fn(async () => ({ type: "empty" as const })),
}));

vi.mock("../src/tui/capabilities.js", () => ({
  resolveUiModeFromSources: hoisted.resolveMode,
}));
vi.mock("../src/tui/read-only-entry.js", () => ({
  runInteractiveRecommend: hoisted.interactiveRecommend,
  runInteractiveCanRun: hoisted.interactiveCanRun,
  runInteractiveDoctor: hoisted.interactiveDoctor,
  runInteractiveCatalog: hoisted.interactiveCatalog,
  runInteractiveLs: hoisted.interactiveLs,
}));
vi.mock("../src/commands/recommend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/recommend.js")>();
  return { ...actual, runRecommend: hoisted.plainRecommend };
});
vi.mock("../src/commands/can-run.js", () => ({ runCanRun: hoisted.plainCanRun }));
vi.mock("../src/commands/doctor.js", () => ({ runDoctor: hoisted.plainDoctor }));
vi.mock("../src/commands/catalog.js", () => ({ runCatalog: hoisted.plainCatalog }));
vi.mock("../src/commands/ls.js", () => ({ runLs: hoisted.plainLs }));

import { buildCli } from "../src/cli.js";

function select(mode: "plain" | "json" | "tui" | "accessible", explicit = false): void {
  hoisted.selection.mode = mode;
  hoisted.selection.explicit = explicit;
  hoisted.selection.reason = mode === "plain" ? "stdin_not_tty" : null;
  hoisted.resolveMode.mockImplementation(() => ({ ...hoisted.selection }));
}

async function parseInteractive(argv: readonly string[]): Promise<void> {
  buildCli().parse(["node", "local-llmup", ...argv]);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  for (const mock of Object.values(hoisted).filter(
    (value): value is ReturnType<typeof vi.fn> => typeof value === "function" && "mockReset" in value,
  )) {
    mock.mockReset();
  }
  select("plain");
  hoisted.plainRecommend.mockResolvedValue({ entries: [] });
  hoisted.plainCanRun.mockResolvedValue({ runnable: "yes" });
  hoisted.plainDoctor.mockResolvedValue({ ok: true });
  hoisted.plainCatalog.mockResolvedValue({ rows: [] });
  hoisted.plainLs.mockReturnValue({ type: "empty" });
  hoisted.interactiveRecommend.mockResolvedValue({ entries: [] });
  hoisted.interactiveCanRun.mockResolvedValue({ runnable: "yes" });
  hoisted.interactiveDoctor.mockResolvedValue({ ok: true });
  hoisted.interactiveCatalog.mockResolvedValue({ rows: [] });
  hoisted.interactiveLs.mockResolvedValue({ type: "empty" });
  process.exitCode = undefined;
});

describe("U1d CLI routing", () => {
  it("routes eligible explicit recommend through the lazy interactive entry", async () => {
    select("tui", true);
    await parseInteractive(["recommend", "--tui"]);
    expect(hoisted.resolveMode).toHaveBeenCalledWith(
      expect.objectContaining({ tui: true }),
    );
    expect(hoisted.interactiveRecommend).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ mode: "tui", explicit: true }),
    );
    expect(hoisted.plainRecommend).not.toHaveBeenCalled();
  });

  it("normalizes CAC --no-color into the mode selector contract", async () => {
    select("tui", true);
    await parseInteractive(["recommend", "--tui", "--no-color"]);
    expect(hoisted.resolveMode).toHaveBeenCalledWith(
      expect.objectContaining({ tui: true, noColor: true }),
    );
  });

  it("preserves plain routing for ineligible and --no-tui invocations", async () => {
    select("plain");
    await buildCli().parse(["node", "local-llmup", "recommend", "--no-tui"]);
    expect(hoisted.resolveMode).not.toHaveBeenCalled();
    expect(hoisted.plainRecommend).toHaveBeenCalledWith({});
    expect(hoisted.interactiveRecommend).not.toHaveBeenCalled();
  });

  it("routes all five read-only commands through accessible mode", async () => {
    select("accessible", true);
    await parseInteractive(["recommend", "--accessible"]);
    await parseInteractive(["can-run", "qwen3:14b", "--accessible"]);
    await parseInteractive(["doctor", "--accessible"]);
    await parseInteractive(["catalog", "--accessible"]);
    await parseInteractive(["ls", "--accessible"]);
    expect(hoisted.interactiveRecommend).toHaveBeenCalledOnce();
    expect(hoisted.interactiveCanRun).toHaveBeenCalledOnce();
    expect(hoisted.interactiveDoctor).toHaveBeenCalledOnce();
    expect(hoisted.interactiveCatalog).toHaveBeenCalledOnce();
    expect(hoisted.interactiveLs).toHaveBeenCalledOnce();
  });

  it("preserves can-run and doctor exit contracts after interactive rendering", async () => {
    select("tui", true);
    hoisted.interactiveCanRun.mockResolvedValueOnce({ runnable: "no" });
    await parseInteractive(["can-run", "qwen3:14b", "--tui"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    hoisted.interactiveDoctor.mockResolvedValueOnce({ ok: false });
    await parseInteractive(["doctor", "--tui"]);
    expect(process.exitCode).toBe(1);
  });

  it("allows omitted can-run model only in interactive mode", async () => {
    select("accessible", true);
    await parseInteractive(["can-run", "--accessible"]);
    expect(hoisted.interactiveCanRun).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ mode: "accessible" }),
    );

    hoisted.interactiveCanRun.mockReset();
    select("plain");
    const writes: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
    try {
      await buildCli().parse(["node", "local-llmup", "can-run"]);
    } finally {
      stderr.mockRestore();
    }
    expect(hoisted.plainCanRun).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("model is required outside interactive mode");
    expect(process.exitCode).toBe(1);
  });

  it("maps interactive picker cancellation to exit 130", async () => {
    select("tui", true);
    hoisted.interactiveCanRun.mockResolvedValueOnce(null as never);
    await parseInteractive(["can-run", "--tui"]);
    expect(process.exitCode).toBe(130);
  });

  it("forces JSON through the existing noninteractive command", async () => {
    select("json", true);
    await buildCli().parse(["node", "local-llmup", "recommend", "--json"]);
    expect(hoisted.plainRecommend).toHaveBeenCalledWith({ json: true });
    expect(hoisted.interactiveRecommend).not.toHaveBeenCalled();
  });

  it("keeps actual parsed help free of hidden TUI compatibility flags", () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      output.push(String(value));
    });
    try {
      buildCli().parse(["node", "local-llmup", "--help"]);
      buildCli().parse(["node", "local-llmup", "can-run", "--help"]);
    } finally {
      log.mockRestore();
    }
    const help = output.join("\n");
    expect(help).not.toContain("--tui");
    expect(help).not.toContain("--no-tui");
    expect(help).not.toContain("--accessible");
    expect(help).not.toContain("--no-color");
  });
});
