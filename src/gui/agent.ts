/**
 * Agentic MCP tool-execution loop for the browser GUI.
 *
 * When MCP connectors advertise tools, a chat turn becomes a short agent loop:
 * the model is offered the connected tools, and any tool calls it makes are
 * executed against the owning connector and fed back until the model produces a
 * final answer. The loop surfaces every tool invocation as an {@link AgentEvent}
 * so the UI can show live tool activity (Claude Code / Codex style) rather than
 * an opaque wait.
 *
 * The final answer is emitted as a `delta` event. Baseline local GUI chat is
 * already non-streaming (the server awaits the full reply before emitting a
 * single delta), so no new streaming transport is introduced here.
 */
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { resolveModel } from "../resolver.js";
import { loadCatalog } from "../catalog/load.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { select } from "../backend/select.js";
import { captureLiveProcessIdentity, type LiveProcessIdentity } from "../tui/snapshots.js";
import { readState, type RuntimeState } from "../state/state.js";
import type { ChatMessage, ChatResult, ChatTool } from "../backend/adapter.js";
import type { Catalog } from "../types.js";
import type { AgentTool } from "../mcp/manager.js";
import type { McpToolResult } from "../mcp/client.js";

/** An event streamed from a running agent turn. */
export type AgentEvent =
  | {
      readonly type: "tool";
      readonly name: string;
      readonly phase: "start" | "done";
      readonly isError?: boolean | undefined;
    }
  | { readonly type: "delta"; readonly content: string };

/** A single non-streaming chat call the agent can drive with tools. */
export interface AgentChat {
  (input: {
    readonly messages: readonly ChatMessage[];
    readonly tools: readonly ChatTool[];
    /** When provided, the backend streams content fragments here as they arrive. */
    readonly onToken?: ((chunk: string) => void) | undefined;
  }): Promise<ChatResult>;
}

/** Inputs for {@link runAgentTurn}. */
export interface AgentTurnOptions {
  readonly chat: AgentChat;
  readonly tools: readonly AgentTool[];
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  readonly messages: readonly ChatMessage[];
  readonly maxSteps?: number | undefined;
}

/** Cap on agent iterations before a final answer is forced without tools. */
const DEFAULT_MAX_STEPS = 6;

/** Cap on how much of a tool result is fed back to the model. */
const MAX_TOOL_RESULT_BYTES = 8 * 1024;

function truncateToolResult(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_TOOL_RESULT_BYTES) {
    return text;
  }
  return `${text.slice(0, MAX_TOOL_RESULT_BYTES)}\n… [truncated]`;
}

function toChatTools(tools: readonly AgentTool[]): ChatTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
  }));
}

/**
 * Drive one chat call, yielding `delta` events for each content fragment the
 * model streams (Claude Code / Codex style), and returning the fully-accumulated
 * {@link ChatResult} plus the exact text that was streamed. Tokens are bridged
 * from the backend's `onToken` callback into this async generator through a
 * small queue so they surface in real time. When the backend cannot stream, the
 * queue stays empty and `streamed` is `""`, so the caller can emit the final
 * content in one delta.
 */
async function* pumpChat(
  chat: AgentChat,
  messages: readonly ChatMessage[],
  tools: readonly ChatTool[],
): AsyncGenerator<AgentEvent, ChatResult & { readonly streamed: string }> {
  const queue: string[] = [];
  let streamed = "";
  let settled = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const pending = chat({
    messages,
    tools,
    onToken: (chunk) => {
      if (chunk.length === 0) {
        return;
      }
      queue.push(chunk);
      nudge();
    },
  }).finally(() => {
    settled = true;
    nudge();
  });

  for (;;) {
    const chunk = queue.shift();
    if (chunk !== undefined) {
      streamed += chunk;
      yield { type: "delta", content: chunk };
      continue;
    }
    if (settled) {
      break;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }

  const result = await pending;
  return { ...result, streamed };
}

/**
 * Emit any part of a final answer the backend did not already stream. Streaming
 * backends stream the whole answer (`streamed === content`), so nothing extra is
 * sent; non-streaming backends leave `streamed` empty, so the full content is
 * emitted as one delta.
 */
function* emitUnstreamedRemainder(
  result: ChatResult & { readonly streamed: string },
): Generator<AgentEvent> {
  if (result.streamed === result.content) {
    return;
  }
  const remainder = result.content.startsWith(result.streamed)
    ? result.content.slice(result.streamed.length)
    : result.content;
  if (remainder.length > 0) {
    yield { type: "delta", content: remainder };
  }
}

/**
 * Run one agent turn: offer the connected MCP tools to the model, execute any
 * tool calls it requests, and yield events until it produces a final answer.
 */
export async function* runAgentTurn(options: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const chatTools = toChatTools(options.tools);
  const working: ChatMessage[] = [...options.messages];

  for (let step = 0; step < maxSteps; step += 1) {
    const result = yield* pumpChat(options.chat, working, chatTools);
    const calls = result.toolCalls ?? [];
    if (calls.length === 0) {
      yield* emitUnstreamedRemainder(result);
      return;
    }

    working.push({ role: "assistant", content: result.content, toolCalls: calls });
    for (const call of calls) {
      yield { type: "tool", name: call.name, phase: "start" };
      let content: string;
      let isError: boolean;
      try {
        const toolResult = await options.callTool(call.name, call.arguments);
        content = truncateToolResult(toolResult.content);
        isError = toolResult.isError;
      } catch (error) {
        content = error instanceof Error ? error.message : String(error);
        isError = true;
      }
      yield { type: "tool", name: call.name, phase: "done", isError };
      working.push({ role: "tool", content, toolName: call.name });
    }
  }

  // Step budget exhausted: force a final answer with tools withheld.
  const final = yield* pumpChat(options.chat, working, []);
  yield* emitUnstreamedRemainder(final);
}

/** Injectable side effects for {@link createActiveBackendChat}, so it can be faked in tests. */
export interface ActiveBackendChatDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly readState: (config: Config) => RuntimeState;
  readonly registry: BackendRegistry;
  readonly captureLiveProcessIdentity: (
    active: NonNullable<RuntimeState["active"]>,
  ) => Promise<LiveProcessIdentity>;
}

function createDefaultActiveBackendChatDeps(): ActiveBackendChatDeps {
  return {
    config: loadConfig(),
    loadCatalog: () => loadCatalog(),
    readState,
    registry: createDefaultRegistry(),
    captureLiveProcessIdentity,
  };
}

/**
 * Build an {@link AgentChat} bound to the currently active backend, resolved from
 * `state.json` on every call (mirrors the `chat` command's attach path). Tools
 * are forwarded to the backend; backends without tool support ignore them.
 */
export function createActiveBackendChat(
  deps: ActiveBackendChatDeps = createDefaultActiveBackendChatDeps(),
): AgentChat {
  return async ({ messages, tools, onToken }) => {
    const active = deps.readState(deps.config).active;
    if (active === null) {
      throw new ValidationError("no active server. Serve a model first.");
    }
    const liveProcessIdentity = await deps.captureLiveProcessIdentity(active);
    const resolved = resolveModel(deps.loadCatalog(), active.modelId);
    const modelId = resolved.model.id;
    const adapter = (
      await select({ intent: "attach", registry: deps.registry, activeBackend: active.backend })
    ).adapter;
    const backendModelId = adapter.capabilities.formats.includes("ollama")
      ? resolved.model.source.ollama
      : modelId;
    if (backendModelId === undefined) {
      throw new ValidationError(
        `model ${modelId} has no source that backend ${adapter.name} can chat with`,
      );
    }

    const chatRequest = {
      endpoint: active.endpoint,
      model: backendModelId,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(active.ownedByUs && active.authToken !== undefined
        ? { authToken: active.authToken }
        : {}),
      ...(active.modelPath !== undefined ? { expectedModelPath: active.modelPath } : {}),
      expectedProcess: liveProcessIdentity.expectedProcess,
    };

    // Stream token-by-token when the caller wants it and the backend supports
    // streaming; otherwise fall back to a single non-streaming completion.
    if (onToken !== undefined && adapter.chatStream !== undefined) {
      return adapter.chatStream({ ...chatRequest, onDelta: onToken });
    }
    return adapter.chat(chatRequest);
  };
}
