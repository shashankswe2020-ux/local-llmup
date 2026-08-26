/** Anthropic Claude chat harness. */
import { z } from "zod";
import { assertSafeFetchUrl } from "../backend/net.js";
import { ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { ChatHarness, HarnessChatRequest } from "./adapter.js";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const API_KEY_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), {
    message: "Anthropic API key must be a single non-empty value",
  });

export interface ClaudeHarnessDeps {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
}

function removeTrailingNewlines(value: string): string {
  return value.replace(/\r?\n+$/u, "");
}

function parseAnthropicPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return "";
    }

    const record = parsed as Record<string, unknown>;
    const delta = record["delta"];
    if (typeof delta === "object" && delta !== null) {
      const deltaRecord = delta as Record<string, unknown>;
      if (deltaRecord["type"] === "text_delta") {
        const text = deltaRecord["text"];
        return typeof text === "string" ? stripControl(text) : "";
      }
    }

    const message = record["message"];
    if (typeof message === "object" && message !== null) {
      const messageRecord = message as Record<string, unknown>;
      const content = messageRecord["content"];
      if (Array.isArray(content)) {
        let result = "";
        for (const item of content) {
          if (typeof item !== "object" || item === null) {
            continue;
          }
          const part = item as Record<string, unknown>;
          if (part["type"] === "text") {
            const text = part["text"];
            if (typeof text === "string") {
              result += stripControl(text);
            }
          }
        }
        return result;
      }
    }
  } catch {
    return "";
  }

  return "";
}

function parseSseFrame(frame: string): string {
  const lines = frame.split(/\r?\n/u);
  let payload = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      payload += removeTrailingNewlines(line.slice("data:".length));
    }
  }

  if (payload.length === 0) {
    return "";
  }

  return parseAnthropicPayload(payload);
}

async function* streamClaudeText(response: Response, maxBytes: number): AsyncIterable<string> {
  if (response.body === null) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new ValidationError(
        `Claude response exceeded the ${maxBytes.toLocaleString()} byte limit`,
      );
    }

    buffer += chunk;
    const frames = buffer.split(/\n\n/u);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const parsed = parseSseFrame(frame);
      if (parsed.length > 0) {
        yield stripControl(parsed);
      }
    }
  }

  if (buffer.trim().length > 0) {
    const tail = parseSseFrame(buffer);
    if (tail.length > 0) {
      yield stripControl(tail);
    }
  }
}

export function createClaudeHarness(deps: ClaudeHarnessDeps = {}): ChatHarness {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;
  const modelName = deps.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const getApiKey = (): string => {
    const raw = env.ANTHROPIC_API_KEY ?? "";
    const parsed = API_KEY_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("ANTHROPIC_API_KEY is not set");
    }
    return parsed.data;
  };

  const assertSafeEndpoint = (): URL => {
    try {
      return assertSafeFetchUrl(baseUrl, { allowedHosts: ["api.anthropic.com"] });
    } catch (error) {
      throw new ValidationError(`invalid Anthropic API endpoint: ${baseUrl}`, { cause: error });
    }
  };

  return {
    name: "claude",
    unavailableHint: "Set ANTHROPIC_API_KEY to use the Claude harness.",
    async isAvailable(): Promise<boolean> {
      try {
        getApiKey();
        return true;
      } catch {
        return false;
      }
    },
    async *chat(request: HarnessChatRequest): AsyncIterable<string> {
      const apiKey = getApiKey();
      const url = assertSafeEndpoint();
      const messages = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          content: stripControl(message.content),
        }));

      const response = await fetchFn(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: request.model || modelName,
          max_tokens: 1024,
          messages,
          stream: true,
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new ValidationError(
          `Claude request failed: ${stripControl(bodyText.slice(0, 200)) || response.statusText}`,
        );
      }

      for await (const chunk of streamClaudeText(response, maxResponseBytes)) {
        if (chunk.length > 0) {
          yield chunk;
        }
      }
    },
    async chatSync(request: HarnessChatRequest): Promise<string> {
      let text = "";
      for await (const chunk of this.chat(request)) {
        text += chunk;
      }
      return text;
    },
  };
}
