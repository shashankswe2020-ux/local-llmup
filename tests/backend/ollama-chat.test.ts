import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import { OllamaAdapter, type FetchFn, type FetchResponseLike } from "../../src/backend/ollama.js";

describe("OllamaAdapter.chat", () => {
  it("returns assistant content from a successful non-streaming chat response", async () => {
    const response: FetchResponseLike = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: { content: "hello from ollama" } }),
    };
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(response));
    const adapter = new OllamaAdapter({ fetch });

    const result = await adapter.chat({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toEqual({ content: "hello from ollama" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");

    const rawBody = fetch.mock.calls[0]?.[1]?.body;
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

  it("throws BackendError on non-2xx response", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve({ ok: false, status: 500 }));
    const adapter = new OllamaAdapter({ fetch });

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
    const fetch = vi.fn<FetchFn>(() => Promise.resolve(malformed));
    const adapter = new OllamaAdapter({ fetch });

    await expect(
      adapter.chat({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("rejects an unsafe model id before making a request", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve({ ok: true, status: 200 }));
    const adapter = new OllamaAdapter({ fetch });

    await expect(
      adapter.chat({
        model: "-rf; rm",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
