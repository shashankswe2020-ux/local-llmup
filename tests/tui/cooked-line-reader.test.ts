import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createBoundedCookedLineReader } from "../../src/tui/cooked-line-reader.js";

function inputStream(): NodeJS.ReadStream {
  const stream = new PassThrough() as PassThrough & Partial<NodeJS.ReadStream>;
  stream.isTTY = true;
  stream.setRawMode = vi.fn(() => {
    throw new Error("raw mode must not be enabled");
  });
  return stream as NodeJS.ReadStream;
}

describe("bounded cooked line reader", () => {
  it("reads submitted lines without enabling raw mode", async () => {
    const input = inputStream();
    const reader = createBoundedCookedLineReader(input, 256);
    const pending = reader.readLine();
    input.push("hello\n");
    await expect(pending).resolves.toBe("hello");
    expect(input.setRawMode).not.toHaveBeenCalled();
    reader.close();
  });

  it("bounds a newline-less paste incrementally before returning the line", async () => {
    const input = inputStream();
    const reader = createBoundedCookedLineReader(input, 256);
    const pending = reader.readLine();
    input.push("a".repeat(1_000_000));
    input.push("\n");
    const line = await pending;
    expect(Buffer.byteLength(line ?? "", "utf8")).toBeLessThanOrEqual(256);
    expect(line?.endsWith("…")).toBe(true);
    reader.close();
  });

  it("queues complete lines and resolves EOF as null", async () => {
    const input = inputStream();
    const reader = createBoundedCookedLineReader(input, 256);
    input.push("one\r\ntwo\n");
    expect(await reader.readLine()).toBe("one");
    expect(await reader.readLine()).toBe("two");
    const eof = reader.readLine();
    input.push(null);
    await expect(eof).resolves.toBeNull();
    reader.close();
  });

  it("bounds queued submitted lines and applies backpressure", async () => {
    const input = inputStream();
    const pause = vi.spyOn(input, "pause");
    const reader = createBoundedCookedLineReader(input, 256);
    input.push(`${Array.from({ length: 1_000 }, () => "line").join("\n")}\n`);
    const retained: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const line = await reader.readLine();
      if (line !== null) retained.push(line);
    }
    expect(retained).toHaveLength(200);
    expect(pause).toHaveBeenCalled();
    reader.close();
    await expect(reader.readLine()).resolves.toBeNull();
  });
});
