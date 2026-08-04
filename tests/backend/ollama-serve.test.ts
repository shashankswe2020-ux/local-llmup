import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/errors.js";
import { OllamaAdapter, type FetchFn, type FetchResponseLike, type SleepFn } from "../../src/backend/ollama.js";

const ENDPOINT = "http://127.0.0.1:11434";

const ok: FetchResponseLike = { ok: true, status: 200 };
const notFound: FetchResponseLike = { ok: false, status: 404 };

/** A sleep that resolves immediately and records the requested delays. */
function recordingSleep(): { sleep: SleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: SleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

describe("OllamaAdapter.waitUntilReady", () => {
  it("resolves when /v1/models is ready on the first attempt", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(ok));
    const { sleep, delays } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(adapter.waitUntilReady({ endpoint: ENDPOINT })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ENDPOINT}/v1/models`);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(delays).toHaveLength(0);
  });

  it("falls back to /api/tags when /v1/models is not available", async () => {
    const fetch = vi.fn<FetchFn>((url) =>
      Promise.resolve(url.endsWith("/v1/models") ? notFound : ok),
    );
    const { sleep } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(adapter.waitUntilReady({ endpoint: ENDPOINT })).resolves.toBeUndefined();

    const urls = fetch.mock.calls.map((call) => call[0]);
    expect(urls).toContain(`${ENDPOINT}/v1/models`);
    expect(urls).toContain(`${ENDPOINT}/api/tags`);
  });

  it("becomes ready on the Nth attempt, backing off between attempts", async () => {
    let call = 0;
    const fetch = vi.fn<FetchFn>(() => {
      call += 1;
      // Both probe paths fail for the first two attempts (4 calls), then ready.
      if (call <= 4) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve(ok);
    });
    const { sleep, delays } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(adapter.waitUntilReady({ endpoint: ENDPOINT })).resolves.toBeUndefined();

    // Two failed attempts → two backoff sleeps, growing exponentially.
    expect(delays).toEqual([100, 200]);
  });

  it("throws a typed error when retries are exhausted", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const { sleep } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(
      adapter.waitUntilReady({ endpoint: ENDPOINT, retries: 3, timeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(fetch).toHaveBeenCalledTimes(3 * 2); // 3 attempts × 2 probe paths
  });

  it("throws a typed error when the readiness deadline elapses", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.reject(new Error("ECONNREFUSED")));
    const { sleep } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(
      adapter.waitUntilReady({ endpoint: ENDPOINT, retries: 50, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(ok));
    const { sleep } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.waitUntilReady({ endpoint: ENDPOINT, signal: controller.signal }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caps the exponential backoff at 2000ms", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(notFound));
    const { sleep, delays } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(
      adapter.waitUntilReady({ endpoint: ENDPOINT, retries: 8, timeoutMs: 600_000 }),
    ).rejects.toBeInstanceOf(BackendError);

    expect(delays).toEqual([100, 200, 400, 800, 1600, 2000, 2000]);
  });

  it("bounds a hung request by the deadline via a per-request timeout", async () => {
    // fetch never resolves on its own; it only settles when its signal aborts.
    const fetch = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const { sleep } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await expect(
      adapter.waitUntilReady({ endpoint: ENDPOINT, retries: 50, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("normalizes a trailing slash on the endpoint", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(ok));
    const { sleep } = recordingSleep();
    const adapter = new OllamaAdapter({ fetch, sleep });

    await adapter.waitUntilReady({ endpoint: `${ENDPOINT}/` });

    expect(fetch.mock.calls[0]?.[0]).toBe(`${ENDPOINT}/v1/models`);
  });
});
