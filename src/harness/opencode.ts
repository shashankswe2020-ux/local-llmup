import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BackendError, ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { ChatHarness, HarnessChatRequest, HarnessMessage } from "./adapter.js";

const OPENCODE_BINARY = "opencode";
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 500;

function createOpenCodeConfig(model: string, unrestricted: boolean): string {
  const separator = model.indexOf("/");
  const providerName = model.slice(0, separator);
  const modelName = model.slice(separator + 1);
  const agent = unrestricted
    ? {
        "local-llmup-chat": {
          description: "Chat invoked by local-llmup (unrestricted)",
          mode: "primary" as const,
          permission: "allow" as const,
        },
      }
    : {
        "local-llmup-chat": {
          description: "Text-only chat invoked by local-llmup",
          mode: "primary" as const,
          permission: "deny" as const,
        },
      };
  return JSON.stringify({
    autoupdate: unrestricted,
    share: unrestricted ? "auto" : "disabled",
    snapshot: unrestricted,
    permission: unrestricted ? "allow" : "deny",
    ...(providerName === "ollama"
      ? {
          provider: {
            ollama: {
              npm: "@ai-sdk/openai-compatible",
              name: "Ollama (local)",
              options: { baseURL: "http://127.0.0.1:11434/v1" },
              models: { [modelName]: { name: modelName } },
            },
          },
        }
      : {}),
    agent,
  });
}

const EventBaseSchema = z.object({
  timestamp: z.number().finite(),
  sessionID: z.string().min(1).max(1024),
});
const TextEventSchema = EventBaseSchema.extend({
  type: z.literal("text"),
  part: z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
});
const ErrorEventSchema = EventBaseSchema.extend({
  type: z.literal("error"),
  error: z.record(z.unknown()),
});
const NonTextEventSchema = EventBaseSchema.extend({
  type: z.enum(["step_start", "step_finish", "reasoning", "tool_use"]),
  part: z.object({ type: z.string().min(1).max(100) }).passthrough(),
});
const OpenCodeEventSchema = z.union([TextEventSchema, ErrorEventSchema, NonTextEventSchema]);

/** Minimal readable child-process stream consumed by the OpenCode harness. */
export interface OpenCodeOutputStream {
  onData(listener: (chunk: string) => void): void;
}

/** Minimal child-process surface used by the OpenCode harness. */
export interface OpenCodeSpawnedProcess {
  readonly stdout: OpenCodeOutputStream | null;
  readonly stderr: OpenCodeOutputStream | null;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Injectable shell-free process launcher. */
export type OpenCodeSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly stdio: "pipe";
    readonly signal?: AbortSignal | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
) => OpenCodeSpawnedProcess;

/** Optional process dependencies and resource bounds. */
export interface OpenCodeHarnessOptions {
  readonly spawn?: OpenCodeSpawnFn | undefined;
  readonly binary?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly maxOutputBytes?: number | undefined;
  /** When true, OpenCode runs with permission:allow, share:auto, autoupdate, snapshot; disables local-llmup safety gates. */
  readonly unrestricted?: boolean | undefined;
}

function adaptStream(stream: Readable | null): OpenCodeOutputStream | null {
  if (stream === null) return null;
  stream.setEncoding("utf8");
  return { onData: (listener) => stream.on("data", (chunk: string) => listener(chunk)) };
}

const defaultSpawn: OpenCodeSpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    signal: options.signal,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  return {
    stdout: adaptStream(child.stdout),
    stderr: adaptStream(child.stderr),
    onClose: (listener) => child.on("close", listener),
    onError: (listener) => child.on("error", listener),
    kill: (signal) => child.kill(signal),
  };
};

function processError(binary: string, error: unknown): BackendError {
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = (cause as { code?: unknown }).code;
  if (cause.name === "AbortError" || code === "ABORT_ERR") {
    return new BackendError(`${binary} request aborted`, { cause });
  }
  if (code === "ENOENT") {
    return new BackendError(`${binary} not found on PATH`, { cause });
  }
  return new BackendError(`failed to run ${binary}: ${stripControl(cause.message)}`, { cause });
}

function serializeMessages(messages: readonly HarnessMessage[]): string {
  const prompt = messages
    .map((message) => `[${message.role}]\n${stripControl(message.content)}`)
    .join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new ValidationError("OpenCode conversation exceeds the 1 MiB prompt limit");
  }
  return prompt;
}

function normalizeModel(model: string): string {
  const value = stripControl(model).trim();
  const separator = value.indexOf("/");
  if (separator === -1) {
    if (value.length === 0) {
      throw new ValidationError("OpenCode model must not be empty");
    }
    return `ollama/${value}`;
  }
  if (separator === 0 || separator === value.length - 1) {
    throw new ValidationError("OpenCode model must use provider/model format");
  }
  return value;
}

function formatEventError(error: Record<string, unknown>): string {
  const name = typeof error["name"] === "string" ? error["name"] : "OpenCode error";
  const message = typeof error["message"] === "string" ? error["message"] : "request failed";
  return stripControl(`${name}: ${message}`).slice(0, MAX_ERROR_CHARS);
}

const MAX_TRACE_TARGET_CHARS = 160;
const MAX_TRACE_OUTPUT_CHARS = 400;

// Emits OpenCode step/reasoning/tool_use activity as inline markdown so the
// chat panel shows what the model actually did instead of just the final text.
function renderToolTrace(
  type: "step_start" | "step_finish" | "reasoning" | "tool_use",
  part: Record<string, unknown>,
): string {
  if (type === "tool_use") {
    const tool = typeof part["tool"] === "string" ? part["tool"] : "tool";
    const state = (part["state"] ?? {}) as Record<string, unknown>;
    const input = (state["input"] ?? {}) as Record<string, unknown>;
    const title = typeof state["title"] === "string" ? state["title"] : "";
    const filePath = typeof input["filePath"] === "string" ? input["filePath"] : "";
    const command = typeof input["command"] === "string" ? input["command"] : "";
    const pattern = typeof input["pattern"] === "string" ? input["pattern"] : "";
    const target = stripControl(title || filePath || command || pattern).slice(0, MAX_TRACE_TARGET_CHARS);
    const output = typeof state["output"] === "string" ? stripControl(state["output"]).slice(0, MAX_TRACE_OUTPUT_CHARS) : "";
    const head = target ? `\`${tool}\` · ${target}` : `\`${tool}\``;
    const body = output ? `\n\n\`\`\`\n${output}\n\`\`\`` : "";
    return `\n\n> 🔧 ${head}${body}\n`;
  }
  if (type === "reasoning") {
    const text = typeof part["text"] === "string" ? stripControl(part["text"]).slice(0, MAX_TRACE_OUTPUT_CHARS) : "";
    return text ? `\n\n> 💭 ${text}\n` : "";
  }
  return "";
}

function createProcessStream(
  spawn: OpenCodeSpawnFn,
  binary: string,
  env: NodeJS.ProcessEnv,
  maxOutputBytes: number,
  unrestricted: boolean,
  request: HarnessChatRequest,
): AsyncIterable<string> {
  const prompt = serializeMessages(request.messages);
  const model = normalizeModel(request.model);

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<string> {
      const chunks: string[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      let failure: Error | undefined;
      let stdoutBuffer = "";
      let stderr = "";
      let outputBytes = 0;
      let child: OpenCodeSpawnedProcess;

      const notify = (): void => {
        wake?.();
        wake = undefined;
      };
      const fail = (error: Error): void => {
        if (done) return;
        failure = error;
        done = true;
        notify();
      };
      const stop = (error: Error): void => {
        fail(error);
        child.kill("SIGTERM");
      };
      const count = (chunk: string): boolean => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes <= maxOutputBytes) return true;
        stop(new ValidationError("OpenCode process output limit exceeded"));
        return false;
      };
      const parseLine = (line: string): void => {
        if (line.trim().length === 0 || done) return;
        let raw: unknown;
        try {
          raw = JSON.parse(line) as unknown;
        } catch (error) {
          stop(new ValidationError("OpenCode emitted malformed JSON", { cause: error }));
          return;
        }
        const parsed = OpenCodeEventSchema.safeParse(raw);
        if (!parsed.success) {
          stop(new ValidationError("OpenCode emitted an invalid JSON event", { cause: parsed.error }));
          return;
        }
        if (parsed.data.type === "text") {
          chunks.push(stripControl(parsed.data.part.text));
          notify();
        } else if (parsed.data.type === "error") {
          stop(new BackendError(formatEventError(parsed.data.error)));
        } else {
          const trace = renderToolTrace(parsed.data.type, parsed.data.part);
          if (trace.length > 0) {
            chunks.push(trace);
            notify();
          }
        }
      };

      try {
        child = spawn(
          binary,
          ["run", prompt, "--model", model, "--agent", "local-llmup-chat", "--format", "json"],
          {
            shell: false,
            stdio: "pipe",
            signal: request.signal,
            env: { ...env, OPENCODE_CONFIG_CONTENT: createOpenCodeConfig(model, unrestricted) },
          },
        );
      } catch (error) {
        throw processError(binary, error);
      }

      const onAbort = (): void => stop(new BackendError(`${binary} request aborted`));
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();

      child.stdout?.onData((chunk) => {
        if (!count(chunk)) return;
        stdoutBuffer += chunk;
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          parseLine(line);
        }
      });
      child.stderr?.onData((chunk) => {
        if (!count(chunk)) return;
        if (stderr.length < MAX_ERROR_CHARS) stderr += chunk;
      });
      child.onError((error) => fail(processError(binary, error)));
      child.onClose((code) => {
        if (done) return;
        if (stdoutBuffer.length > 0) parseLine(stdoutBuffer);
        if (done) return;
        if (code !== 0) {
          fail(new BackendError(`OpenCode exited with code ${code ?? "unknown"}: ${stripControl(stderr).slice(0, MAX_ERROR_CHARS) || "request failed"}`));
          return;
        }
        done = true;
        notify();
      });

      try {
        for (;;) {
          while (chunks.length > 0) yield chunks.shift() ?? "";
          if (failure !== undefined) throw failure;
          if (done) return;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
        if (!done) child.kill("SIGTERM");
      }
    },
  };
}

/** Build a text-only OpenCode harness using its noninteractive JSON protocol. */
export function createOpenCodeHarness(options: OpenCodeHarnessOptions = {}): ChatHarness {
  const spawn = options.spawn ?? defaultSpawn;
  const binary = options.binary ?? OPENCODE_BINARY;
  const env = options.env ?? process.env;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const unrestricted = options.unrestricted === true;

  return {
    name: "opencode",
    unavailableHint: "OpenCode is unavailable. Install `opencode` and ensure it is on PATH.",
    async isAvailable(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (available: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(available);
        };
        let child: OpenCodeSpawnedProcess;
        try {
          child = spawn(binary, ["--version"], { shell: false, stdio: "pipe", env });
        } catch {
          finish(false);
          return;
        }
        child.onError(() => finish(false));
        child.onClose((code) => finish(code === 0));
      });
    },
    chat(request: HarnessChatRequest): AsyncIterable<string> {
      return createProcessStream(spawn, binary, env, maxOutputBytes, unrestricted, request);
    },
    async chatSync(request: HarnessChatRequest): Promise<string> {
      let result = "";
      for await (const chunk of createProcessStream(spawn, binary, env, maxOutputBytes, unrestricted, request)) {
        result += chunk;
      }
      return result;
    },
  };
}