/** Request validation helpers for the GUI server. */
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";

export const MAX_REQUEST_BYTES = 64 * 1024;

export const GUI_MESSAGE_SCHEMA = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4096),
});

export const GUI_CHAT_REQUEST_SCHEMA = z.object({
  model: z.string().trim().min(1).max(256).optional(),
  harness: z.string().trim().min(1).max(128).optional(),
  messages: z.array(GUI_MESSAGE_SCHEMA).min(1).max(20),
});

export const GUI_HARNESS_SWITCH_SCHEMA = z.object({
  harness: z.string().trim().min(1).max(128),
});

export function validateHost(hostHeader: string | undefined, expectedPort: number): void {
  const requiredHost = `127.0.0.1:${expectedPort}`;
  if (hostHeader !== requiredHost) {
    throw new ValidationError(`host header mismatch: expected ${requiredHost}`);
  }
}

export async function readJsonBody(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  limit: number,
): Promise<unknown> {
  if (body === null) {
    return {};
  }

  const webStream = body as ReadableStream<Uint8Array> & {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    };
  };

  if (typeof webStream.getReader === "function") {
    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new ValidationError("request body exceeds 64 KiB limit");
      }
      chunks.push(value);
    }

    const bytesOut = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytesOut.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytesOut));
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body as NodeJS.ReadableStream) {
    bytes += chunk.length;
    if (bytes > limit) {
      throw new ValidationError("request body exceeds 64 KiB limit");
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sanitizeMessageContent(value: string): string {
  return stripControl(value);
}

export function parseGuiChatRequest(input: unknown): {
  readonly model: string;
  readonly harness?: string | undefined;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
} {
  const parsed = GUI_CHAT_REQUEST_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`invalid chat payload: ${parsed.error.issues[0]?.message ?? "bad request"}`);
  }
  return {
    model: parsed.data.model ?? "demo-model",
    harness: parsed.data.harness,
    messages: parsed.data.messages.map((message) => ({
      role: message.role,
      content: sanitizeMessageContent(message.content),
    })),
  };
}

export function parseHarnessSwitch(input: unknown): z.infer<typeof GUI_HARNESS_SWITCH_SCHEMA> {
  const parsed = GUI_HARNESS_SWITCH_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`invalid harness payload: ${parsed.error.issues[0]?.message ?? "bad request"}`);
  }
  return parsed.data;
}
