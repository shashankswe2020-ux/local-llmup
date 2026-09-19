import { describe, expect, it } from "vitest";
import { createOpenAIHarness } from "../../src/harness/openai.js";
import { createClaudeHarness } from "../../src/harness/claude.js";
import {
  parseInferenceUsage,
  captureInferenceUsage,
  recordInferenceUsage,
  beginInferenceUsage,
} from "../../src/harness/usage.js";

describe("reported inference usage", () => {
  it("captures usage-only frames through the real remote harness parsers", async () => {
    const openai = createOpenAIHarness({
      env: { OPENAI_API_KEY: "fixture" },
      fetch: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60}}}\n\ndata: [DONE]\n\n',
        ),
    });
    const claude = createClaudeHarness({
      env: { ANTHROPIC_API_KEY: "fixture" },
      fetch: async () =>
        new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":60,"cache_creation_input_tokens":30}}}\n\ndata: {"delta":{"type":"text_delta","text":"reply"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\n',
        ),
    });
    for (const harness of [openai, claude]) {
      const captured = await captureInferenceUsage(() =>
        harness.chatSync({ model: "fixture", messages: [{ role: "user", content: "question" }] }),
      );
      expect(captured.result).toBe("reply");
      expect(captured.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cacheHitTokens: 60,
        cacheMissTokens: 40,
      });
    }
  });
  it("normalizes OpenAI prompt cache tokens without inventing unsupported counts", () => {
    expect(
      parseInferenceUsage(
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
        "openai",
      ),
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 60, cacheMissTokens: 40 });
    expect(parseInferenceUsage({ prompt_eval_count: 100, eval_count: 20 }, "ollama")).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: null,
      cacheMissTokens: null,
    });
  });
  it("includes Claude cache reads and writes in total input", () => {
    expect(
      parseInferenceUsage(
        {
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 60,
              cache_creation_input_tokens: 30,
            },
          },
        },
        "claude",
      ),
    ).toEqual({ inputTokens: 100, outputTokens: 0, cacheHitTokens: 60, cacheMissTokens: 40 });
  });
  it("rejects negative, fractional and inconsistent cache counters", () => {
    expect(
      parseInferenceUsage({ usage: { prompt_tokens: -1, completion_tokens: 1.5 } }, "openai")
        .inputTokens,
    ).toBeNull();
    expect(
      parseInferenceUsage(
        { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } } },
        "openai",
      ).cacheHitTokens,
    ).toBeNull();
  });
  it("merges streaming snapshots without double counting and isolates requests", async () => {
    const capture = await captureInferenceUsage(async () => {
      beginInferenceUsage();
      recordInferenceUsage(
        {
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 0,
            },
          },
        },
        "claude",
      );
      recordInferenceUsage({ usage: { output_tokens: 12 } }, "claude");
      return "reply";
    });
    expect(capture.usage).toEqual({
      inputTokens: 15,
      outputTokens: 12,
      cacheHitTokens: 5,
      cacheMissTokens: 10,
    });
    expect((await captureInferenceUsage(async () => "other")).usage.inputTokens).toBeNull();
  });
});
