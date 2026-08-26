import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { createClaudeHarness } from "../../src/harness/claude.js";

describe("createClaudeHarness", () => {
  it("reports unavailable without ANTHROPIC_API_KEY", async () => {
    const harness = createClaudeHarness({
      env: { ANTHROPIC_API_KEY: "" },
      fetch: vi.fn(),
    });

    await expect(harness.isAvailable()).resolves.toBe(false);
    expect(harness.unavailableHint).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects non-safe Anthropic endpoints", async () => {
    const harness = createClaudeHarness({
      env: { ANTHROPIC_API_KEY: "key-123" },
      baseUrl: "http://127.0.0.1:11434",
      fetch: vi.fn(),
    });

    await expect(
      harness.chatSync({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("parses streamed text deltas and sanitizes output", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        [
          "event: message_start",
          "data: {\"type\":\"message_start\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}",
          "",
          "event: content_block_delta",
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"\\u001b[31mA\\u001b[0m\"}}",
          "",
          "event: content_block_delta",
          "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}",
          "",
          "event: message_stop",
          "data: {\"type\":\"message_stop\"}",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      ),
    );

    const harness = createClaudeHarness({
      env: { ANTHROPIC_API_KEY: "key-123" },
      fetch,
    });

    const chunks: string[] = [];
    for await (const chunk of harness.chat({
      model: "claude-3-5-haiku-20241022",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello", "A", " world"]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.anthropic\.com\/v1\/messages$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("aborts responses above the 16 MiB cap", async () => {
    const content = "x".repeat(16 * 1024 * 1024 + 1);
    const fetch = vi.fn(async () =>
      new Response(
        [
          "event: content_block_delta",
          `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${content}"}}`,
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
      ),
    );

    const harness = createClaudeHarness({
      env: { ANTHROPIC_API_KEY: "key-123" },
      fetch,
    });

    await expect(
      harness.chatSync({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
