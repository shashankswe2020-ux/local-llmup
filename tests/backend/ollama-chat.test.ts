import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import { OllamaAdapter, type FetchFn, type FetchResponseLike } from "../../src/backend/ollama.js";

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

describe("OllamaAdapter.chat", () => {
  it("returns assistant content from a successful non-streaming chat response", async () => {
    const response: FetchResponseLike = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: { content: "hello from ollama" } }),
    };
    const { fetch, adapter } = trustedAdapter(() => Promise.resolve(response));

    const result = await adapter.chat({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toEqual({ content: "hello from ollama" });
    const chatCall = fetch.mock.calls.find(([url]) => url.endsWith("/api/chat"));
    expect(chatCall?.[0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(chatCall?.[1]?.method).toBe("POST");

    const rawBody = chatCall?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      model: string;
      messages: readonly { role: string; content: string }[];
      stream: boolean;
    };
    expect(body).toEqual({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
  });

  it("posts to the active custom loopback endpoint", async () => {
    const { fetch, adapter } = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: { content: "ok" } }),
      }),
    );

    await adapter.chat({
      endpoint: "http://127.0.0.1:12000",
      model: "llama3.1:8b",
      messages: [],
    });

    expect(fetch.mock.calls.find(([url]) => url.endsWith("/api/chat"))?.[0]).toBe(
      "http://127.0.0.1:12000/api/chat",
    );
  });

  it("refuses a non-loopback chat endpoint", async () => {
    const { fetch, adapter } = trustedAdapter(vi.fn<FetchFn>());
    await expect(
      adapter.chat({ endpoint: "http://example.com", model: "llama3.1:8b", messages: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws BackendError on non-2xx response", async () => {
    const { adapter } = trustedAdapter(() => Promise.resolve({ ok: false, status: 500 }));

    await expect(
      adapter.chat({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("throws BackendError when response body shape is malformed", async () => {
    const malformed: FetchResponseLike = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: { content: 42 } }),
    };
    const { adapter } = trustedAdapter(() => Promise.resolve(malformed));

    await expect(
      adapter.chat({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("rejects an unsafe model id before making a request", async () => {
    const { fetch, adapter } = trustedAdapter(() => Promise.resolve({ ok: true, status: 200 }));

    await expect(
      adapter.chat({
        model: "-rf; rm",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
