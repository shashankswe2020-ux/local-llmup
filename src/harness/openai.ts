/** OpenAI chat harness. */
import { z } from "zod";
import { assertSafeFetchUrl } from "../backend/net.js";
import { ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { ChatHarness, HarnessChatRequest } from "./adapter.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const API_KEY_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), {
    message: "OpenAI API key must be a single non-empty value",
  });

export interface OpenAIHarnessDeps {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
}

function removeTrailingNewlines(value: string): string {
  return value.replace(/\r?\n+$/u, "");
}

function parseOpenAIContent(payload: unknown): string {
  if (typeof payload !== "string") {
    if (Array.isArray(payload)) {
      let result = "";
      for (const item of payload) {
        if (typeof item === "object" && item !== null) {
          const piece = item as Record<string, unknown>;
          const text = piece["text"];
          if (typeof text === "string") {
            result += stripControl(text);
          }
        }
      }
      return result;
    }
    return "";
  }

  return stripControl(payload);
}

function parseOpenAIResponse(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "[DONE]") {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new ValidationError("OpenAI response payload was malformed");
    }

    const record = parsed as Record<string, unknown>;
    const choices = record["choices"];
    if (!Array.isArray(choices)) {
      throw new ValidationError("OpenAI response payload was malformed");
    }

    let result = "";
    for (const entry of choices) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      const choice = entry as Record<string, unknown>;
      const delta = choice["delta"];
      if (typeof delta !== "object" || delta === null) {
        continue;
      }

      const deltaRecord = delta as Record<string, unknown>;
      const content = deltaRecord["content"];
      result += parseOpenAIContent(content);
    }

    return result;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError("OpenAI response payload was malformed", { cause: error });
  }
}

function parseSseFrame(frame: string): string {
  const lines = frame.split(/\r?\n/u);
  let payload = "";

  for (const line of lines) {
    if (line.startsWith("data:")) {
      payload += `${removeTrailingNewlines(line.slice("data:".length))}\n`;
    }
  }

  if (payload.length === 0) {
    return "";
  }

  return parseOpenAIResponse(payload);
}

async function* streamOpenAIText(response: Response, maxBytes: number): AsyncIterable<string> {
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
        `OpenAI response exceeded the ${maxBytes.toLocaleString()} byte limit`,
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

export function createOpenAIHarness(deps: OpenAIHarnessDeps = {}): ChatHarness {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const modelName = deps.model ?? DEFAULT_OPENAI_MODEL;
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const getApiKey = (): string => {
    const raw = env.OPENAI_API_KEY ?? "";
    const parsed = API_KEY_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("OPENAI_API_KEY is not set");
    }
    return parsed.data;
  };

  const assertSafeEndpoint = (): URL => {
    try {
      return assertSafeFetchUrl(baseUrl, { allowedHosts: ["api.openai.com"] });
    } catch (error) {
      throw new ValidationError(`invalid OpenAI API endpoint: ${baseUrl}`, { cause: error });
    }
  };

  return {
    name: "openai",
    unavailableHint: "Set OPENAI_API_KEY to use the OpenAI harness.",
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
      const messages = request.messages.map((message) => ({
        role: message.role,
        content: stripControl(message.content),
      }));

      const response = await fetchFn(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: request.model || modelName,
          messages,
          stream: true,
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new ValidationError(
          `OpenAI request failed: ${stripControl(bodyText.slice(0, 200)) || response.statusText}`,
        );
      }

      for await (const chunk of streamOpenAIText(response, maxResponseBytes)) {
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
