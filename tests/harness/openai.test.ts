import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { createOpenAIHarness } from "../../src/harness/openai.js";

describe("createOpenAIHarness", () => {
  it("reports unavailable without OPENAI_API_KEY", async () => {
    const harness = createOpenAIHarness({
      env: { OPENAI_API_KEY: "" },
      fetch: vi.fn(),
    });

    await expect(harness.isAvailable()).resolves.toBe(false);
    expect(harness.unavailableHint).toContain("OPENAI_API_KEY");
  });

  it("rejects non-safe OpenAI endpoints", async () => {
    const harness = createOpenAIHarness({
      env: { OPENAI_API_KEY: "key-123" },
      baseUrl: "http://127.0.0.1:11434",
      fetch: vi.fn(),
    });

    await expect(
      harness.chatSync({
        model: "gpt-4o-mini",
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

    const harness = createOpenAIHarness({
      env: { OPENAI_API_KEY: "key-123" },
      fetch,
    });

    const chunks: string[] = [];
    for await (const chunk of harness.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello", "A", " world"]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.openai\.com\/v1\/chat\/completions$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer key-123" }),
      }),
    );
  });

  it("rejects malformed OpenAI payloads", async () => {
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

    const harness = createOpenAIHarness({
      env: { OPENAI_API_KEY: "key-123" },
      fetch,
    });

    await expect(
      harness.chatSync({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("aborts responses above the 16 MiB cap", async () => {
    const content = "x".repeat(16 * 1024 * 1024 + 1);
    const fetch = vi.fn(async () =>
      new Response(
        [`data: {"choices":[{"delta":{"content":"${content}"}}]}`].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
      ),
    );

    const harness = createOpenAIHarness({
      env: { OPENAI_API_KEY: "key-123" },
      fetch,
    });

    await expect(
      harness.chatSync({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
