import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountReadOnlyScreen } from "../../src/tui/read-only-renderer.js";
import { sanitizeTerminalText } from "../../src/tui/sanitize.js";
import {
  canRunViewModel,
  catalogViewModel,
  doctorViewModel,
  lsViewModel,
  recommendViewModel,
} from "../fixtures/tui-view-models.js";

interface TestInput extends NodeJS.ReadStream {
  readonly rawModes: boolean[];
}

function inputStream(): TestInput {
  const stream = new PassThrough() as PassThrough & Partial<TestInput>;
  const rawModes: boolean[] = [];
  stream.isTTY = true;
  stream.isRaw = false;
  stream.ref = (): TestInput => stream as TestInput;
  stream.unref = (): TestInput => stream as TestInput;
  stream.setRawMode = (enabled: boolean): TestInput => {
    rawModes.push(enabled);
    stream.isRaw = enabled;
    return stream as TestInput;
  };
  stream.rawModes = rawModes;
  return stream as TestInput;
}

function outputStream(): { readonly stream: NodeJS.WriteStream; readonly chunks: string[] } {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & Partial<NodeJS.WriteStream>;
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 24;
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream: stream as NodeJS.WriteStream, chunks };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

function latest(chunks: readonly string[]): string {
  return [...chunks]
    .reverse()
    .find(
      (chunk) =>
        chunk !== "\u001b[?25l" && chunk !== "\u001b[?25h" && chunk.trim().length > 0,
    ) ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("read-only Ink screens", () => {
  it("renders recommendation hierarchy, unknown evidence, and visible controls to stderr", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountReadOnlyScreen({
      screen: "recommend",
      viewModel: recommendViewModel(),
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    await settle();

    const frame = latest(stderr.chunks);
    expect(frame).toContain("local-llmup / Recommend");
    expect(frame).toContain("qwen3:14b");
    expect(frame).toContain("deepseek-r1:14b");
    expect(frame).toContain("unknown");
    expect(frame).toContain("no-sourced-performance-profile");
    expect(frame).toContain("Navigate");
    expect(frame).toContain("Search");
    expect(frame).toContain("Compare");
    expect(frame).not.toContain("\u001b[31m");

    stdin.write("q");
    await session.waitUntilExit();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });

  it("supports search, stable selection, details, marking, and comparison without side effects", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const onPrintCommand = vi.fn();
    const session = mountReadOnlyScreen({
      screen: "recommend",
      viewModel: recommendViewModel(),
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
      onPrintCommand,
    });
    await settle();

    stdin.write("/");
  await settle();
    stdin.write("deepseek");
    await settle();
  expect(stderr.chunks.join("")).toContain("Search: deepseek");
  expect(stderr.chunks.join("")).toContain("deepseek-r1:14b");

    stdin.write("\r");
    await settle();
    expect(stderr.chunks.join("")).toContain("Evidence / deepseek-r1:14b");
    expect(stderr.chunks.join("")).toContain("License: mit");

    stdin.write("\r");
  await settle();
    stdin.write("/");
  await settle();
    stdin.write("\u0015");
  await settle();
    stdin.write(" ");
  await settle();
    stdin.write("\u001b[A");
  await settle();
    stdin.write(" ");
  await settle();
    stdin.write("c");
    await settle();
    expect(stderr.chunks.join("")).toContain("Compare 2 models");
    expect(stderr.chunks.join("")).toContain("quality");

    stdin.write("c");
  await settle();
    stdin.write("p");
    await session.waitUntilExit();
    expect(onPrintCommand).toHaveBeenCalledWith("local-llmup up qwen3:14b");
  });

  it("renders can-run verdict text, evidence, and a next command only when runnable", async () => {
    for (const verdict of ["yes", "no"] as const) {
      const stdin = inputStream();
      const stderr = outputStream();
      const session = mountReadOnlyScreen({
        screen: "canRun",
        viewModel: canRunViewModel(verdict),
        stdin,
        stderr: stderr.stream,
        color: false,
        unicode: false,
        explicit: true,
      });
      await settle();
      const frame = latest(stderr.chunks);
      expect(frame).toContain(`Verdict: ${verdict}`);
      expect(frame).toContain("Throughput source");
      expect(frame.includes("Next: local-llmup up qwen3:14b")).toBe(verdict === "yes");
      expect(frame).toContain("q/Esc Quit · ? Help");
      stdin.write("?");
      await settle();
      expect(stderr.chunks.join("")).toContain("Keyboard help");
      stdin.write("q");
      await session.waitUntilExit();
    }
  });

  it("handles terminal Home and End sequences and uses ASCII navigation labels", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountReadOnlyScreen({
      screen: "recommend",
      viewModel: recommendViewModel(),
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    await settle();
    expect(stderr.chunks.join("")).toContain("Up/Down Navigate · Home/End Jump");
    stdin.write("\u001b");
    await settle();
    stdin.write("[F");
    await settle();
    stdin.write("\r");
    await settle();
    expect(stderr.chunks.join("")).toContain("Evidence / deepseek-r1:14b");
    stdin.write("q");
    await session.waitUntilExit();
  });

  it("renders doctor checks, backend table, score axes, and remediation as text", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountReadOnlyScreen({
      screen: "doctor",
      viewModel: doctorViewModel(),
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    await settle();
    const frame = latest(stderr.chunks);
    expect(frame).toContain("Diagnostics");
    expect(frame).toContain("FAIL");
    expect(frame).toContain("brew install ollama");
    expect(frame).toContain("Score: 73/100");
    expect(frame).toContain("VRAM 60");
    stdin.write("q");
    await session.waitUntilExit();
  });

  it("renders searchable catalog rows, refresh diff, and complete selected details", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountReadOnlyScreen({
      screen: "catalog",
      viewModel: catalogViewModel(),
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    await settle();
    expect(latest(stderr.chunks)).toContain("Catalog · all · 1/1");
    expect(latest(stderr.chunks)).toContain("Dry-run diff");
    stdin.write("\r");
    await settle();
    const detail = stderr.chunks.join("");
    expect(detail).toContain("Sources");
    expect(detail).toContain("Qwen/Qwen3-14B");
    expect(detail).toContain("Digest: verified");
    expect(detail).toContain("KV bytes/token: 65536");
    stdin.write("q");
    await session.waitUntilExit();
  });

  it("compares marked catalog models using sourced evidence", async () => {
    const base = catalogViewModel();
    const first = base.rows[0]!;
    const viewModel = {
      ...base,
      total: 2,
      rows: [
        first,
        {
          ...first,
          model: {
            actionable: true as const,
            canonical: "deepseek-r1:14b",
            display: sanitizeTerminalText("deepseek-r1:14b", "action_identifier"),
          },
          family: sanitizeTerminalText("deepseek", "single_line"),
          fit: "ram-bound" as const,
        },
      ],
    };
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountReadOnlyScreen({
      screen: "catalog",
      viewModel,
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    await settle();
    stdin.write(" ");
    await settle();
    stdin.write("\u001b[B");
    await settle();
    stdin.write(" ");
    await settle();
    stdin.write("c");
    await settle();
    const output = stderr.chunks.join("");
    expect(output).toContain("Compare 2 catalog models");
    expect(output).toContain("qwen3:14b");
    expect(output).toContain("deepseek-r1:14b");
    expect(output).toContain("KV bytes/token");
    stdin.write("q");
    await session.waitUntilExit();
  });

  it("renders active and empty ls cards and auto-exits only for implicit TUI", async () => {
    const implicitInput = inputStream();
    const implicitError = outputStream();
    const implicit = mountReadOnlyScreen({
      screen: "ls",
      viewModel: lsViewModel(true),
      stdin: implicitInput,
      stderr: implicitError.stream,
      color: false,
      unicode: false,
      explicit: false,
    });
    await implicit.waitUntilExit();
    expect(implicitError.chunks.join("")).toContain("Ownership: attached");

    const explicitInput = inputStream();
    const explicitError = outputStream();
    const explicit = mountReadOnlyScreen({
      screen: "ls",
      viewModel: lsViewModel(false),
      stdin: explicitInput,
      stderr: explicitError.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    await settle();
    expect(latest(explicitError.chunks)).toContain("local-llmup up <model>");
    explicitInput.write("q");
    await explicit.waitUntilExit();
  });

  it("unmounts idempotently and restores raw mode", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountReadOnlyScreen({
      screen: "doctor",
      viewModel: doctorViewModel(),
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
      explicit: true,
    });
    session.unmount();
    session.unmount();
    await session.waitUntilExit();
    expect(stdin.isRaw).toBe(false);
  });
});
