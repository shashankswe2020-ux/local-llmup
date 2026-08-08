import { describe, expect, it, vi } from "vitest";
import {
  formatAccessibleReadOnlyScreen,
  runAccessibleReadOnlyScreen,
} from "../../src/tui/read-only-accessible.js";
import {
  canRunViewModel,
  catalogViewModel,
  doctorViewModel,
  lsViewModel,
  recommendViewModel,
} from "../fixtures/tui-view-models.js";

describe("accessible read-only screens", () => {
  it("renders numbered linear sections with complete recommendation evidence", () => {
    const output = formatAccessibleReadOnlyScreen("recommend", recommendViewModel());
    expect(output).toContain("1. Machine");
    expect(output).toContain("2. Ranked models");
    expect(output).toContain("qwen3:14b");
    expect(output).toContain("deepseek-r1:14b");
    expect(output).toContain("no-sourced-performance-profile");
    expect(output).toContain("3. Won't fit");
    expect(output).toContain("4. Controls");
    expect(output).not.toContain("\u001b");
  });

  it("renders equivalent can-run, doctor, catalog, and ls evidence", () => {
    expect(formatAccessibleReadOnlyScreen("canRun", canRunViewModel("no"))).toContain(
      "not-evaluated-model-does-not-fit",
    );
    const doctor = formatAccessibleReadOnlyScreen("doctor", doctorViewModel());
    expect(doctor).toContain("FAIL");
    expect(doctor).toContain("VRAM 60");
    const catalog = formatAccessibleReadOnlyScreen("catalog", catalogViewModel());
    expect(catalog).toContain("Qwen/Qwen3-14B");
    expect(catalog).toContain("Digest: verified");
    expect(catalog).toContain("Dry-run diff");
    expect(formatAccessibleReadOnlyScreen("ls", lsViewModel(true))).toContain(
      "Ownership: attached",
    );
  });

  it("supports line-oriented search, numbered details, help, and print-next-command", async () => {
    const lines = ["/deepseek", "1", "?", "p"];
    const writes: string[] = [];
    const readLine = vi.fn(async () => lines.shift() ?? null);

    const outcome = await runAccessibleReadOnlyScreen({
      screen: "recommend",
      viewModel: recommendViewModel(),
      explicit: true,
      readLine,
      write: (text) => writes.push(text),
    });

    const output = writes.join("");
    expect(output).toContain("Filter: deepseek");
    expect(output).toContain("1. deepseek-r1:14b");
    expect(output).toContain("Details: deepseek-r1:14b");
    expect(output).toContain("Commands: /text search");
    expect(outcome).toEqual({
      type: "print-command",
      command: "local-llmup up qwen3:14b",
    });
  });

  it("exits on q or EOF without printing an action command", async () => {
    for (const line of ["q", null] as const) {
      const outcome = await runAccessibleReadOnlyScreen({
        screen: "doctor",
        viewModel: doctorViewModel(),
        explicit: true,
        readLine: async () => line,
        write: () => undefined,
      });
      expect(outcome).toEqual({ type: "exited" });
    }
  });

  it("shows only controls implemented by the current accessible screen", async () => {
    const writes: string[] = [];
    const lines = ["?", "q"];
    await runAccessibleReadOnlyScreen({
      screen: "doctor",
      viewModel: doctorViewModel(),
      explicit: true,
      readLine: async () => lines.shift() ?? null,
      write: (text) => writes.push(text),
    });
    const help = writes.at(-1) ?? "";
    expect(help).toContain("? help; q quit");
    expect(help).not.toContain("search");
    expect(help).not.toContain("number details");
    expect(help).not.toContain("print next command");
  });

  it("auto-exits implicit ls without reading stdin", async () => {
    const readLine = vi.fn(async () => "q");
    const writes: string[] = [];
    const outcome = await runAccessibleReadOnlyScreen({
      screen: "ls",
      viewModel: lsViewModel(false),
      explicit: false,
      readLine,
      write: (text) => writes.push(text),
    });
    expect(outcome).toEqual({ type: "exited" });
    expect(readLine).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("local-llmup up <model>");
  });

  it("bounds large accessible list batches and directs users to refine search", () => {
    const base = recommendViewModel();
    const output = formatAccessibleReadOnlyScreen("recommend", {
      ...base,
      rows: Array.from({ length: 1_000 }, () => base.rows[0]!),
    });
    expect(output).toContain("Showing first 20 of 1000; use /text to refine.");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(100_000);
  });

  it("does not advertise p when no actionable recommendation command exists", async () => {
    const writes: string[] = [];
    const lines = ["?", "q"];
    const viewModel = { ...recommendViewModel(), command: null };
    await runAccessibleReadOnlyScreen({
      screen: "recommend",
      viewModel,
      explicit: true,
      readLine: async () => lines.shift() ?? null,
      write: (text) => writes.push(text),
    });
    expect(writes.join("")).not.toContain("p finish");
  });
});
