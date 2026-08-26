import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  mountLifecycleProgress,
  mountLifecycleReview,
} from "../../src/tui/lifecycle-renderer.js";
import { runAccessibleLifecycleReview } from "../../src/tui/lifecycle-accessible.js";
import type { LifecycleReviewViewModel } from "../../src/tui/lifecycle-types.js";

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
  activeChunks = chunks;
  const stream = new PassThrough() as PassThrough & Partial<NodeJS.WriteStream>;
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 24;
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream: stream as NodeJS.WriteStream, chunks };
}

// Tracks the most recently created output stream so `settle()` can wait on the
// stream Ink is actively rendering to. Tests run sequentially within the file.
let activeChunks: readonly string[] = [];

// True once a real (non cursor-only) frame has been rendered.
function hasRenderedFrame(chunks: readonly string[]): boolean {
  return chunks.some(
    (chunk) => chunk !== "\u001b[?25l" && chunk !== "\u001b[?25h" && chunk.trim().length > 0,
  );
}

const review: LifecycleReviewViewModel = {
  screen: "down",
  title: "Stop active server?",
  canonicalTargetIds: ["qwen3:14b"],
  lines: [
    "Model: qwen3:14b",
    "Endpoint: http://127.0.0.1:11434",
    "Consequence: stop verified local-llmup process and clear state.",
  ],
  confirmLabel: "Stop server",
  destructive: true,
};

async function settle(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 1500 && !hasRenderedFrame(activeChunks)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

describe("lifecycle screens", () => {
  it("keeps Cancel selected by default and restores raw mode", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountLifecycleReview({
      viewModel: review,
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
    });
    await settle();

    expect(stderr.chunks.join("")).toContain("Stop active server?");
    expect(stderr.chunks.join("")).toContain("qwen3:14b");
    expect(stderr.chunks.join("")).toContain("Cancel [default]");
    stdin.write("\r");

    await expect(session.waitForDecision()).resolves.toEqual({ type: "cancelled" });
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("requires moving away from Cancel before confirmation", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountLifecycleReview({
      viewModel: review,
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
    });
    await settle();
    stdin.write("\t");
    await settle();
    stdin.write("\r");

    await expect(session.waitForDecision()).resolves.toEqual({ type: "accepted" });
  });

  it("renders bounded lifecycle progress in declared stage order", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const progress = mountLifecycleProgress({
      screen: "up",
      target: "qwen3:14b",
      stdin,
      stderr: stderr.stream,
      color: false,
      unicode: false,
    });
    await settle();
    progress.emit({ type: "started", phase: "acquire", label: "Acquire weights" });
    await settle();
    progress.emit({ type: "completed", phase: "acquire", label: "Digest verified" });
    await settle();
    progress.emit({ type: "started", phase: "serve", label: "Serve on loopback" });
    await settle();

    const output = stderr.chunks.join("");
    expect(output.indexOf("Acquire weights")).toBeLessThan(output.indexOf("Serve on loopback"));
    expect(output).toContain("Digest verified");
    progress.unmount();
  });

  it("provides an equivalent cooked accessible confirmation with Cancel default", async () => {
    const writes: string[] = [];
    const first = await runAccessibleLifecycleReview({
      viewModel: review,
      readLine: () => Promise.resolve(""),
      write: (text) => writes.push(text),
    });
    expect(first).toEqual({ type: "cancelled" });
    expect(writes.join("")).toContain("1. Cancel (default)");
    expect(writes.join("")).toContain("2. Stop server");

    const second = await runAccessibleLifecycleReview({
      viewModel: review,
      readLine: () => Promise.resolve("2"),
      write: () => undefined,
    });
    expect(second).toEqual({ type: "accepted" });
  });
});
