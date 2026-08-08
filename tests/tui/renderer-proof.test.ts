import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mountRendererProof } from "../../src/tui/renderer-proof.js";

interface ProofInput extends NodeJS.ReadStream {
  readonly rawModes: boolean[];
}

function createInput(): ProofInput {
  const stream = new PassThrough() as PassThrough & Partial<ProofInput>;
  const rawModes: boolean[] = [];
  stream.isTTY = true;
  stream.isRaw = false;
  stream.ref = (): ProofInput => stream as ProofInput;
  stream.unref = (): ProofInput => stream as ProofInput;
  stream.setRawMode = (enabled: boolean): ProofInput => {
    rawModes.push(enabled);
    stream.isRaw = enabled;
    return stream as ProofInput;
  };
  stream.rawModes = rawModes;
  return stream as ProofInput;
}

function createOutput(): { readonly stream: NodeJS.WriteStream; readonly chunks: string[] } {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & Partial<NodeJS.WriteStream>;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream: stream as NodeJS.WriteStream, chunks };
}

describe("Ink renderer dependency proof", () => {
  it("renders through injected streams, handles input, and restores raw mode", async () => {
    const stdin = createInput();
    const stdout = createOutput();
    const stderr = createOutput();
    const onExit = vi.fn();

    const session = mountRendererProof({
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      onExit,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write("q");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.waitUntilExit();

    expect(stdout.chunks.join("")).toContain("renderer proof");
    expect(stderr.chunks).toEqual([]);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });

  it("owns Ctrl+C and exits through the controlled callback", async () => {
    const stdin = createInput();
    const stdout = createOutput();
    const stderr = createOutput();
    const onExit = vi.fn();
    const session = mountRendererProof({
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      onExit,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write("\u0003");
    await session.waitUntilExit();

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });

  it("unmounts idempotently and resolves waitUntilExit", async () => {
    const stdin = createInput();
    const stdout = createOutput();
    const stderr = createOutput();
    const session = mountRendererProof({ stdin, stdout: stdout.stream, stderr: stderr.stream });

    session.unmount();
    session.unmount();
    await session.waitUntilExit();

    expect(stdin.isRaw).toBe(false);
  });
});
