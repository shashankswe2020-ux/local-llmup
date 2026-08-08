import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { mountModelPicker } from "../../src/tui/model-picker.js";
import { runAccessibleModelPicker } from "../../src/tui/model-picker-accessible.js";

interface PickerInput extends NodeJS.ReadStream {
  readonly rawModes: boolean[];
}

function inputStream(): PickerInput {
  const stream = new PassThrough() as PassThrough & Partial<PickerInput>;
  const rawModes: boolean[] = [];
  stream.isTTY = true;
  stream.isRaw = false;
  stream.ref = (): PickerInput => stream as PickerInput;
  stream.unref = (): PickerInput => stream as PickerInput;
  stream.setRawMode = (enabled: boolean): PickerInput => {
    rawModes.push(enabled);
    stream.isRaw = enabled;
    return stream as PickerInput;
  };
  stream.rawModes = rawModes;
  return stream as PickerInput;
}

function outputStream(): { readonly stream: NodeJS.WriteStream; readonly chunks: string[] } {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & Partial<NodeJS.WriteStream>;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 20;
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream: stream as NodeJS.WriteStream, chunks };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

describe("read-only model picker", () => {
  it("renders bounded choices and accepts the stable selected id", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountModelPicker({
      title: "Choose a model for can-run",
      choices: ["qwen3:14b", "deepseek-r1:14b"],
      stdin,
      stderr: stderr.stream,
      unicode: false,
    });
    await settle();
    expect(stderr.chunks.join("")).toContain("Choose a model for can-run");
    stdin.write("\u001b[B");
    await settle();
    stdin.write("\r");
    await expect(session.waitForDecision()).resolves.toBe("deepseek-r1:14b");
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("cancels on q without selecting a model", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountModelPicker({
      title: "Choose",
      choices: ["qwen3:14b"],
      stdin,
      stderr: stderr.stream,
      unicode: false,
    });
    await settle();
    stdin.write("q");
    await expect(session.waitForDecision()).resolves.toBeNull();
  });

  it("handles a fragmented End sequence without treating Escape as cancellation", async () => {
    const stdin = inputStream();
    const stderr = outputStream();
    const session = mountModelPicker({
      title: "Choose",
      choices: ["qwen3:14b", "deepseek-r1:14b"],
      stdin,
      stderr: stderr.stream,
      unicode: false,
    });
    await settle();
    stdin.write("\u001b");
    await settle();
    stdin.write("[F");
    await settle();
    stdin.write("\r");
    await expect(session.waitForDecision()).resolves.toBe("deepseek-r1:14b");
  });

  it("uses numbered cooked input in accessible mode", async () => {
    const lines = ["9", "2"];
    const writes: string[] = [];
    const selected = await runAccessibleModelPicker({
      title: "Choose",
      choices: ["qwen3:14b", "deepseek-r1:14b"],
      readLine: async () => lines.shift() ?? null,
      write: (text) => writes.push(text),
    });
    expect(selected).toBe("deepseek-r1:14b");
    expect(writes.join("")).toContain("No such model");
  });

  it("rejects empty or oversized choice sets", () => {
    const stdin = inputStream();
    const stderr = outputStream();
    expect(() =>
      mountModelPicker({ title: "Choose", choices: [], stdin, stderr: stderr.stream, unicode: false }),
    ).toThrow("model picker requires 1..1000 choices");
    expect(() =>
      mountModelPicker({
        title: "Choose",
        choices: Array.from({ length: 1_001 }, (_, index) => `model:${String(index)}`),
        stdin,
        stderr: stderr.stream,
        unicode: false,
      }),
    ).toThrow("model picker requires 1..1000 choices");
    expect(() =>
      mountModelPicker({
        title: "Choose",
        choices: ["a".repeat(8_193)],
        stdin,
        stderr: stderr.stream,
        unicode: false,
      }),
    ).toThrow("model picker model id exceeds 8192 bytes");
  });
});
