import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { createOpenAICompatibleHarness } from "../../src/harness/openai-compatible.js";

describe("createOpenAICompatibleHarness", () => {
  it("reports unavailable without OPENAI_COMPAT_BASE_URL", async () => {
    const harness = createOpenAICompatibleHarness({
      env: { OPENAI_COMPAT_BASE_URL: "" },
      fetch: vi.fn(),
    });

    await expect(harness.isAvailable()).resolves.toBe(false);
    expect(harness.unavailableHint).toContain("OPENAI_COMPAT_BASE_URL");
  });

  it("rejects private IP OpenAI-compatible endpoints", async () => {
    const harness = createOpenAICompatibleHarness({
      env: { OPENAI_COMPAT_BASE_URL: "https://192.168.1.10/v1/chat/completions" },
      fetch: vi.fn(),
    });

    await expect(
      harness.chatSync({
        model: "local-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("parses streamed text deltas and stops on [DONE]", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        [
          "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
          "data: {\"choices\":[{\"delta\":{\"content\":\"\\u001b[31mA\\u001b[0m\"}}]}",
          "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}",
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      ),
    );

    const harness = createOpenAICompatibleHarness({
      env: { OPENAI_COMPAT_BASE_URL: "https://example.com/v1/chat/completions" },
      fetch,
    });

    const chunks: string[] = [];
    for await (const chunk of harness.chat({
      model: "local-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello", "A", " world"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("sends the bearer token only when provided", async () => {
    const fetch = vi.fn(async () =>
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
    );

    const harness = createOpenAICompatibleHarness({
      env: {
        OPENAI_COMPAT_BASE_URL: "https://example.com/v1/chat/completions",
        OPENAI_COMPAT_API_KEY: "provider-key",
      },
      fetch,
    });

    await harness.chatSync({
      model: "local-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer provider-key" }),
      }),
    );
  });

  it("rejects malformed OpenAI-compatible payloads", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        [
          "data: {not-json}",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      ),
    );

    const harness = createOpenAICompatibleHarness({
      env: { OPENAI_COMPAT_BASE_URL: "https://example.com/v1/chat/completions" },
      fetch,
    });

    await expect(
      harness.chatSync({
        model: "local-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
