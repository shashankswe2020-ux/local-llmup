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
      expectedProcess: {
        pid: 42,
        executable: "/nonexistent/ollama",
        started: "2026-08-08 00:00:00",
      },
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

  it("forwards temperature as an ollama option when provided", async () => {
    const response = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: { content: "ok" } }),
    };
    const { fetch, adapter } = trustedAdapter(() => Promise.resolve(response));

    await adapter.chat({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      expectedProcess: { pid: 42, executable: "/nonexistent/ollama", started: "2026-08-08 00:00:00" },
    });

    const chatCall = fetch.mock.calls.find(([url]) => url.endsWith("/api/chat"));
    const body = JSON.parse(chatCall?.[1]?.body as string) as { options?: { temperature?: number } };
    expect(body.options).toEqual({ temperature: 0.2 });
  });

  it("rejects a substituted listener before sending chat content", async () => {
    const { fetch, adapter } = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: { content: "unsafe" } }),
      }),
    );
    await expect(
      adapter.chat({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "secret history" }],
        expectedProcess: {
          pid: 99,
          executable: "/replacement/process",
          started: "later",
        },
      }),
    ).rejects.toThrow("does not match expected process identity");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/api/chat"))).toBe(false);
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

  it("advertises tools and serializes tool_calls and tool-role messages", async () => {
    const { fetch, adapter } = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: { content: "final" } }),
      }),
    );

    await adapter.chat({
      model: "llama3.1:8b",
      messages: [
        { role: "user", content: "recovery?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "get_recovery", arguments: { days: 7 } }],
        },
        { role: "tool", content: "recovery=55", toolName: "get_recovery" },
      ],
      tools: [
        {
          name: "get_recovery",
          description: "Get recovery data",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const chatCall = fetch.mock.calls.find(([url]) => url.endsWith("/api/chat"));
    const body = JSON.parse(chatCall?.[1]?.body as string) as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_recovery",
          description: "Get recovery data",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: "recovery?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "get_recovery", arguments: { days: 7 } } }],
      },
      { role: "tool", content: "recovery=55", tool_name: "get_recovery" },
    ]);
  });

  it("returns tool calls when the model requests them", async () => {
    const { adapter } = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            message: {
              content: "",
              tool_calls: [{ function: { name: "get_recovery", arguments: { days: 7 } } }],
            },
          }),
      }),
    );

    const result = await adapter.chat({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "recovery?" }],
      tools: [
        {
          name: "get_recovery",
          description: "Get recovery data",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    expect(result).toEqual({
      content: "",
      toolCalls: [{ name: "get_recovery", arguments: { days: 7 } }],
    });
  });

  it("omits the tools field when no tools are provided", async () => {
    const { fetch, adapter } = trustedAdapter(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: { content: "ok" } }),
      }),
    );

    await adapter.chat({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    const chatCall = fetch.mock.calls.find(([url]) => url.endsWith("/api/chat"));
    const body = JSON.parse(chatCall?.[1]?.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
  });
});

/** Build a response whose body streams the given NDJSON lines. */
function streamingResponse(lines: readonly string[]): FetchResponseLike {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

describe("OllamaAdapter.chatStream", () => {
  it("streams content fragments in order and returns the full result", async () => {
    const { fetch, adapter } = trustedAdapter(() =>
      Promise.resolve(
        streamingResponse([
          JSON.stringify({ message: { content: "Hello" }, done: false }),
          JSON.stringify({ message: { content: ", " }, done: false }),
          JSON.stringify({ message: { content: "world" }, done: false }),
          JSON.stringify({ message: { content: "" }, done: true }),
        ]),
      ),
    );

    const chunks: string[] = [];
    const result = await adapter.chatStream({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual(["Hello", ", ", "world"]);
    expect(result).toEqual({ content: "Hello, world" });

    const chatCall = fetch.mock.calls.find(([url]) => url.endsWith("/api/chat"));
    const body = JSON.parse(chatCall?.[1]?.body as string) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it("collects tool calls emitted mid-stream", async () => {
    const { adapter } = trustedAdapter(() =>
      Promise.resolve(
        streamingResponse([
          JSON.stringify({
            message: {
              content: "",
              tool_calls: [{ function: { name: "get_recovery", arguments: { days: 7 } } }],
            },
            done: false,
          }),
          JSON.stringify({ message: { content: "" }, done: true }),
        ]),
      ),
    );

    const chunks: string[] = [];
    const result = await adapter.chatStream({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "recovery?" }],
      tools: [
        { name: "get_recovery", description: "Get recovery data", parameters: { type: "object" } },
      ],
      onDelta: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual([]);
    expect(result).toEqual({
      content: "",
      toolCalls: [{ name: "get_recovery", arguments: { days: 7 } }],
    });
  });

  it("throws BackendError when the stream response has no body", async () => {
    const { adapter } = trustedAdapter(() => Promise.resolve({ ok: true, status: 200 }));

    await expect(
      adapter.chatStream({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});
