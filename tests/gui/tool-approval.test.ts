import { afterEach, describe, expect, it, vi } from "vitest";
import { GuiServer } from "../../src/gui/server.js";
import type { AgentTool, ConnectorsFile, ConnectorView, McpManager } from "../../src/mcp/manager.js";
import type { AgentChat } from "../../src/gui/agent.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

const TOOL: AgentTool = {
  name: "do_write",
  description: "write a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  connectorId: "fs",
};

function fakeManager(callTool: McpManager["callTool"]): McpManager {
  const view: ConnectorView = {
    id: "fs",
    name: "fs",
    transport: "stdio",
    target: "npx server",
    status: "connected",
    tools: [{ name: TOOL.name, description: TOOL.description }],
  };
  const file: ConnectorsFile = { schemaVersion: 1, connectors: [] };
  return {
    list: vi.fn(() => [view]),
    add: vi.fn(async () => view),
    snapshot: vi.fn(() => file),
    replaceAll: vi.fn(async () => [view]),
    remove: vi.fn(async () => undefined),
    connect: vi.fn(async () => view),
    disconnect: vi.fn(async () => view),
    agentTools: vi.fn(() => [TOOL]),
    callTool,
    shutdown: vi.fn(async () => undefined),
  };
}

// A model that asks for the tool on the first step and answers once it sees a
// tool result, so each turn is exactly one gated tool call then a final answer.
const agentChat: AgentChat = async ({ messages }) => {
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    return { content: "all done" };
  }
  return { content: "", toolCalls: [{ name: "do_write", arguments: { path: "a.txt" } }] };
};

interface SseEvent {
  readonly type: string;
  readonly phase?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly isError?: boolean;
  readonly content?: string;
}

/**
 * POST a chat turn and drain the SSE stream, invoking `onApproval` the first
 * time a tool needs a decision (so the caller can POST one and unblock the run).
 */
async function runChat(
  port: number,
  onApproval: ((event: SseEvent) => Promise<void>) | null,
): Promise<SseEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "demo", messages: [{ role: "user", content: "write it" }] }),
  });
  const reader = res.body?.getReader();
  if (reader === undefined) {
    return [];
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split).replace(/^data: /u, "");
      buffer = buffer.slice(split + 2);
      let event: SseEvent;
      try {
        event = JSON.parse(frame) as SseEvent;
      } catch {
        continue;
      }
      events.push(event);
      if (onApproval !== null && event.type === "tool" && event.phase === "approval-required") {
        await onApproval(event);
      }
    }
  }
  return events;
}

async function decide(port: number, callId: string, decision: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/chat/tool-decision`, {
    method: "POST",
    headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
    body: JSON.stringify({ callId, decision }),
  });
}

describe("GuiServer tool approval (task 32.8)", () => {
  const servers: GuiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  });

  async function start(callTool: McpManager["callTool"]): Promise<number> {
    const server = new GuiServer({
      rootDir: STATIC,
      agentChat,
      mcpManager: fakeManager(callTool),
    });
    servers.push(server);
    return server.start(0);
  }

  it("executes a tool only after the client approves it", async () => {
    const callTool = vi.fn(async () => ({ content: "wrote a.txt", isError: false }));
    const port = await start(callTool);

    const events = await runChat(port, async (event) => {
      await decide(port, event.callId ?? "", "approve-once");
    });

    expect(callTool).toHaveBeenCalledOnce();
    const phases = events.filter((e) => e.type === "tool").map((e) => e.phase);
    expect(phases).toEqual(["proposed", "approval-required", "start", "done"]);
    expect(events.some((e) => e.type === "delta" && e.content === "all done")).toBe(true);
  });

  it("does not execute a denied tool", async () => {
    const callTool = vi.fn(async () => ({ content: "wrote", isError: false }));
    const port = await start(callTool);

    const events = await runChat(port, async (event) => {
      await decide(port, event.callId ?? "", "deny");
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tool" && e.phase === "denied")).toBe(true);
  });

  it("remembers an allow-for-session grant so the next call is not re-prompted", async () => {
    const callTool = vi.fn(async () => ({ content: "wrote", isError: false }));
    const port = await start(callTool);

    const first = await runChat(port, async (event) => {
      await decide(port, event.callId ?? "", "allow-session");
    });
    expect(first.some((e) => e.type === "tool" && e.phase === "approval-required")).toBe(true);

    // Second turn: the grant covers the exact tool, so no approval is requested.
    const second = await runChat(port, null);
    expect(second.some((e) => e.type === "tool" && e.phase === "approval-required")).toBe(false);
    expect(second.some((e) => e.type === "tool" && e.phase === "done")).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("returns 404 for a decision on an unknown call id", async () => {
    const port = await start(vi.fn(async () => ({ content: "", isError: false })));
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/tool-decision`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ callId: "nope", decision: "approve-once" }),
    });
    expect(res.status).toBe(404);
  });
});
