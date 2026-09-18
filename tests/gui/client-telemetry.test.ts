import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../../src/gui/static/telemetry.js", import.meta.url), "utf8");
function fixture() {
  vi.useFakeTimers();
  const drawing = {
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  const elements = new Map<
    string,
    {
      textContent: string;
      dataset: Record<string, string>;
      setAttribute: ReturnType<typeof vi.fn>;
      getBoundingClientRect: () => { width: number; height: number };
      getContext: () => typeof drawing;
    }
  >();
  const panel = {
    querySelector: (selector: string) => {
      if (!elements.has(selector))
        elements.set(selector, {
          textContent: "",
          dataset: {},
          setAttribute: vi.fn(),
          getBoundingClientRect: () => ({ width: 200, height: 42 }),
          getContext: () => drawing,
        });
      return elements.get(selector);
    },
  };
  const events = new Map<string, () => void>();
  const document = {
    hidden: false,
    querySelector: () => panel,
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
  };
  const payload = {
    sampledAt: Date.now(),
    cpuPercent: 25,
    memoryUsedBytes: 8 * 1024 ** 3,
    memoryTotalBytes: 16 * 1024 ** 3,
    diskUsedBytes: 100 * 1024 ** 3,
    diskTotalBytes: 200 * 1024 ** 3,
  };
  const fetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ ...payload, sampledAt: Date.now() }),
  }));
  let ticks = 0;
  const disconnect = vi.fn();
  runInNewContext(script, {
    document,
    fetch,
    Date,
    AbortController,
    performance: { now: () => (ticks += 10) },
    setTimeout,
    clearTimeout,
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
    getComputedStyle: () => ({ getPropertyValue: () => "#77b8ed" }),
    ResizeObserver: class {
      observe(): void {}
      disconnect = disconnect;
    },
  });
  return { fetch, payload, elements, drawing, document, events, disconnect };
}
afterEach(() => vi.useRealTimers());
describe("live metric graphs", () => {
  it("shows reported tokens, distinguishes zero cache hits from unknown, and clears stale counts", async () => {
    const setup = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.elements.get("#metric-tokens-value")?.textContent).toBe("—");
    setup.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...setup.payload,
        sampledAt: Date.now(),
        inferenceUsage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheHitTokens: 0,
          cacheMissTokens: 1000,
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.elements.get("#metric-tokens-value")?.textContent).toBe("1,200");
    expect(setup.elements.get("#metric-tokens-detail")?.textContent).toBe("1,000 in / 200 out");
    expect(setup.elements.get("#metric-cacheHits-value")?.textContent).toBe("0");
    expect(setup.elements.get("#metric-cacheMisses-value")?.textContent).toBe("1,000");
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.elements.get("#metric-cacheHits-value")?.textContent).toBe("—");
    expect(setup.elements.get("#metric-cacheHits-detail")?.textContent).toBe(
      "Prompt tokens · not reported",
    );
  });
  it("renders readings and measured latency, then updates on a bounded interval", async () => {
    const setup = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.elements.get("#metric-memory-value")?.textContent).toBe("50.0%");
    expect(setup.elements.get("#metric-memory-detail")?.textContent).toBe("8.0 GiB / 16.0 GiB");
    expect(setup.elements.get("#metric-cpu-value")?.textContent).toBe("25.0%");
    expect(setup.elements.get("#metric-latency-value")?.textContent).toBe("10 ms");
    expect(setup.drawing.arc).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.fetch).toHaveBeenCalledTimes(2);
  });
  it("clears stale readings on failure and recovers on the next sample", async () => {
    const setup = fixture();
    await vi.advanceTimersByTimeAsync(0);
    setup.fetch.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.elements.get("#metrics-state")?.dataset.state).toBe("offline");
    expect(setup.elements.get("#metric-cpu-value")?.textContent).toBe("—");
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.elements.get("#metrics-state")?.dataset.state).toBe("live");
  });
  it("pauses hidden pages and releases observers and timers on exit", async () => {
    const setup = fixture();
    await vi.advanceTimersByTimeAsync(0);
    setup.document.hidden = true;
    setup.events.get("visibilitychange")?.();
    await vi.advanceTimersByTimeAsync(10000);
    expect(setup.fetch).toHaveBeenCalledTimes(1);
    setup.document.hidden = false;
    setup.events.get("visibilitychange")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.fetch).toHaveBeenCalledTimes(2);
    setup.events.get("pagehide")?.();
    await vi.advanceTimersByTimeAsync(10000);
    expect(setup.fetch).toHaveBeenCalledTimes(2);
    expect(setup.disconnect).toHaveBeenCalledOnce();
  });
});
