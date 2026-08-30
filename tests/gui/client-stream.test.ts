import { beforeAll, describe, expect, it } from "vitest";

interface SseFrameResult {
  readonly event?: unknown;
  readonly error?: string;
  readonly raw?: string;
}

interface SseFrameBufferInstance {
  push(bytes: Uint8Array): SseFrameResult[];
  flush(): SseFrameResult[];
}

interface SseFrameBufferCtor {
  new (): SseFrameBufferInstance;
}

let SseFrameBuffer: SseFrameBufferCtor;

beforeAll(async () => {
  await import("../../src/gui/static/sse.js");
  SseFrameBuffer = (globalThis as unknown as { GuiSse: { SseFrameBuffer: SseFrameBufferCtor } })
    .GuiSse.SseFrameBuffer;
});

function encodeStream(events: readonly object[]): Uint8Array {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new TextEncoder().encode(text);
}

function collectEvents(results: readonly SseFrameResult[]): unknown[] {
  return results.filter((result) => result.error === undefined).map((result) => result.event);
}

describe("SseFrameBuffer", () => {
  it("parses whole frames from a single chunk", () => {
    const buffer = new SseFrameBuffer();
    const bytes = encodeStream([
      { type: "delta", content: "a" },
      { type: "done", turnsAppended: 1 },
    ]);
    const events = collectEvents(buffer.push(bytes)).concat(collectEvents(buffer.flush()));
    expect(events).toEqual([
      { type: "delta", content: "a" },
      { type: "done", turnsAppended: 1 },
    ]);
  });

  it("reassembles frames split at every byte boundary", () => {
    const source = [
      { type: "delta", content: "hello" },
      { type: "tool", name: "search", phase: "start" },
      { type: "delta", content: "world" },
      { type: "done", turnsAppended: 1 },
    ];
    const bytes = encodeStream(source);

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const buffer = new SseFrameBuffer();
      const events = [
        ...collectEvents(buffer.push(bytes.slice(0, cut))),
        ...collectEvents(buffer.push(bytes.slice(cut))),
        ...collectEvents(buffer.flush()),
      ];
      expect(events).toEqual(source);
    }
  });

  it("preserves multibyte UTF-8 content split across chunks", () => {
    const source = [{ type: "delta", content: "café → 🚀 汉字" }];
    const bytes = encodeStream(source);

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const buffer = new SseFrameBuffer();
      const events = [
        ...collectEvents(buffer.push(bytes.slice(0, cut))),
        ...collectEvents(buffer.push(bytes.slice(cut))),
        ...collectEvents(buffer.flush()),
      ];
      expect(events).toEqual(source);
    }
  });

  it("feeds one byte at a time without losing frames", () => {
    const source = [
      { type: "delta", content: "🚀" },
      { type: "delta", content: "汉字" },
      { type: "done", turnsAppended: 2 },
    ];
    const bytes = encodeStream(source);
    const buffer = new SseFrameBuffer();
    const events: unknown[] = [];
    for (const byte of bytes) {
      events.push(...collectEvents(buffer.push(Uint8Array.of(byte))));
    }
    events.push(...collectEvents(buffer.flush()));
    expect(events).toEqual(source);
  });

  it("reports malformed payloads instead of throwing", () => {
    const buffer = new SseFrameBuffer();
    const bytes = new TextEncoder().encode("data: {not json}\n\ndata: {\"type\":\"done\"}\n\n");
    const results = buffer.push(bytes);
    expect(results[0]?.error).toBe("malformed SSE payload");
    expect(results[1]?.event).toEqual({ type: "done" });
  });

  it("ignores comment and blank lines with no data field", () => {
    const buffer = new SseFrameBuffer();
    const bytes = new TextEncoder().encode(": heartbeat\n\ndata: {\"type\":\"delta\",\"content\":\"x\"}\n\n");
    const events = collectEvents(buffer.push(bytes));
    expect(events).toEqual([{ type: "delta", content: "x" }]);
  });
});
