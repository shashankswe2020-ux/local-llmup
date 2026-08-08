import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import { OllamaAdapter, type FetchFn } from "../../src/backend/ollama.js";

function trustedAdapter(request: FetchFn) {
  const fetch = vi.fn<FetchFn>((url, init) =>
    url.endsWith("/api/version")
      ? Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ version: "0.32.5" }),
        })
      : request(url, init),
  );
  return {
    fetch,
    adapter: new OllamaAdapter({
      fetch,
      binary: "/nonexistent/ollama",
      listenerProbe: async () => ({
        pid: 42,
        process: "ollama",
        executable: "/nonexistent/ollama",
        started: "2026-08-08 00:00:00",
        localAddress: "127.0.0.1",
      }),
    }),
  };
}

describe("OllamaAdapter.embed", () => {
  it("posts inputs to the active custom endpoint and validates vectors", async () => {
    const { fetch, adapter } = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            embeddings: [
              [0.1, 0.2],
              [0.3, 0.4],
            ],
          }),
      }),
    );

    const result = await adapter.embed({
      endpoint: "http://127.0.0.1:18134/ignored?x=1",
      model: "nomic-embed-text",
      input: ["alpha", "beta"],
    });

    expect(result).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      dimension: 2,
    });
    const embedCall = fetch.mock.calls.find(([url]) => url.endsWith("/api/embed"));
    expect(embedCall?.[0]).toBe("http://127.0.0.1:18134/api/embed");
    expect(embedCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(embedCall?.[1]?.body ?? "{}")).toEqual({
      model: "nomic-embed-text",
      input: ["alpha", "beta"],
    });
  });

  it("rejects malformed, mismatched, non-finite, or empty embedding responses", async () => {
    const payloads: unknown[] = [
      {},
      { embeddings: [] },
      { embeddings: [[1, 2]] },
      { embeddings: [[1], [1, 2]] },
      { embeddings: [[Number.NaN], [1]] },
    ];
    for (const payload of payloads) {
      const { adapter } = trustedAdapter(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(payload),
        }),
      );
      await expect(
        adapter.embed({ model: "nomic-embed-text", input: ["alpha", "beta"] }),
      ).rejects.toBeInstanceOf(BackendError);
    }
  });

  it("rejects non-loopback endpoints before fetch", async () => {
    const { fetch, adapter } = trustedAdapter(vi.fn<FetchFn>());
    await expect(
      adapter.embed({ endpoint: "http://example.com", model: "nomic-embed-text", input: ["x"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wraps transport, status, missing body, and invalid JSON failures", async () => {
    const handlers: FetchFn[] = [
      () => Promise.reject(new Error("ECONNRESET")),
      () => Promise.resolve({ ok: false, status: 500 }),
      () => Promise.resolve({ ok: true, status: 200 }),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("not json"),
        }),
    ];
    for (const handler of handlers) {
      const { adapter } = trustedAdapter(handler);
      await expect(
        adapter.embed({ model: "nomic-embed-text", input: ["x"] }),
      ).rejects.toBeInstanceOf(BackendError);
    }
  });

  it("rejects excessive response bytes and vector dimensions", async () => {
    let cancelled = false;
    const oversized = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => String(17 * 1024 * 1024) },
        body: new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
        json: () => Promise.resolve({ embeddings: [[1]] }),
      }),
    );
    await expect(
      oversized.adapter.embed({ model: "nomic-embed-text", input: ["x"] }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(cancelled).toBe(true);

    const excessiveDimension = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ embeddings: [Array.from({ length: 8_193 }, () => 1)] }),
      }),
    );
    await expect(
      excessiveDimension.adapter.embed({ model: "nomic-embed-text", input: ["x"] }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("cancels a chunked response as soon as it exceeds the byte cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { adapter } = trustedAdapter(() => Promise.resolve({ ok: true, status: 200, body }));

    await expect(adapter.embed({ model: "nomic-embed-text", input: ["x"] })).rejects.toBeInstanceOf(
      BackendError,
    );
    expect(cancelled).toBe(true);
  });

  it("rejects empty inputs and unsafe model ids before network access", async () => {
    const empty = trustedAdapter(vi.fn<FetchFn>());
    await expect(
      empty.adapter.embed({ model: "nomic-embed-text", input: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(empty.fetch).not.toHaveBeenCalled();

    const unsafe = trustedAdapter(vi.fn<FetchFn>());
    await expect(unsafe.adapter.embed({ model: "-bad", input: ["x"] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(unsafe.fetch).not.toHaveBeenCalled();
  });

  it("rejects non-string and oversized input payloads before network access", async () => {
    const nonString = trustedAdapter(vi.fn<FetchFn>());
    await expect(
      nonString.adapter.embed({
        model: "nomic-embed-text",
        input: [42] as unknown as readonly string[],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(nonString.fetch).not.toHaveBeenCalled();

    const individual = trustedAdapter(vi.fn<FetchFn>());
    await expect(
      individual.adapter.embed({
        model: "nomic-embed-text",
        input: ["x".repeat(1024 * 1024 + 1)],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(individual.fetch).not.toHaveBeenCalled();

    const aggregate = trustedAdapter(vi.fn<FetchFn>());
    await expect(
      aggregate.adapter.embed({
        model: "nomic-embed-text",
        input: Array.from({ length: 5 }, () => "x".repeat(900 * 1024)),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(aggregate.fetch).not.toHaveBeenCalled();
  });
});
