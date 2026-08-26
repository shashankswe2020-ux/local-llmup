import { describe, expect, it, vi } from "vitest";
import { runAgentTurn, type AgentChat, type AgentEvent } from "../../src/gui/agent.js";
import type { AgentTool } from "../../src/mcp/manager.js";
import type { ChatResult } from "../../src/backend/adapter.js";

const TOOLS: readonly AgentTool[] = [
  {
    name: "get_recovery",
    description: "Get recovery data",
    inputSchema: { type: "object", properties: {} },
    connectorId: "whoop",
  },
];

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("runAgentTurn", () => {
  it("yields a single delta when the model answers without tools", async () => {
    const chat: AgentChat = vi.fn(async () => ({ content: "hello" }));
    const callTool = vi.fn(async () => ({ content: "", isError: false }));

    const events = await collect(
      runAgentTurn({ chat, tools: TOOLS, callTool, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toEqual([{ type: "delta", content: "hello" }]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("executes a tool call then emits the final answer", async () => {
    const chat = vi
      .fn<AgentChat>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ name: "get_recovery", arguments: { days: 7 } }],
      } satisfies ChatResult)
      .mockResolvedValueOnce({ content: "Your recovery is 55%." } satisfies ChatResult);
    const callTool = vi.fn(async () => ({ content: "recovery=55", isError: false }));

    const events = await collect(
      runAgentTurn({
        chat,
        tools: TOOLS,
        callTool,
        messages: [{ role: "user", content: "recovery?" }],
      }),
    );

    expect(callTool).toHaveBeenCalledWith("get_recovery", { days: 7 });
    expect(events).toEqual([
      { type: "tool", name: "get_recovery", phase: "start" },
      { type: "tool", name: "get_recovery", phase: "done", isError: false },
      { type: "delta", content: "Your recovery is 55%." },
    ]);

    // The tool result must be fed back to the model on the second call.
    const secondCall = chat.mock.calls[1]?.[0];
    expect(secondCall?.messages.at(-1)).toEqual({
      role: "tool",
      content: "recovery=55",
      toolName: "get_recovery",
    });
  });

  it("marks a failed tool call as an error and feeds the error back", async () => {
    const chat = vi
      .fn<AgentChat>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ name: "get_recovery", arguments: {} }],
      } satisfies ChatResult)
      .mockResolvedValueOnce({ content: "sorry" } satisfies ChatResult);
    const callTool = vi.fn(async () => {
      throw new Error("connector down");
    });

    const events = await collect(
      runAgentTurn({ chat, tools: TOOLS, callTool, messages: [{ role: "user", content: "?" }] }),
    );

    expect(events).toContainEqual({
      type: "tool",
      name: "get_recovery",
      phase: "done",
      isError: true,
    });
    const secondCall = chat.mock.calls[1]?.[0];
    expect(secondCall?.messages.at(-1)?.content).toContain("connector down");
  });

  it("streams the final answer as incremental deltas when the backend streams tokens", async () => {
    const chat: AgentChat = vi.fn(async ({ onToken }) => {
      for (const fragment of ["Your ", "recovery ", "is 55%."]) {
        onToken?.(fragment);
      }
      return { content: "Your recovery is 55%." };
    });
    const callTool = vi.fn(async () => ({ content: "", isError: false }));

    const events = await collect(
      runAgentTurn({ chat, tools: TOOLS, callTool, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toEqual([
      { type: "delta", content: "Your " },
      { type: "delta", content: "recovery " },
      { type: "delta", content: "is 55%." },
    ]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("forces a final answer without tools once the step budget is exhausted", async () => {
    const chat = vi.fn<AgentChat>(async () => ({
      content: "",
      toolCalls: [{ name: "get_recovery", arguments: {} }],
    }));
    const finalChat = vi.fn(async () => ({ content: "done" }));
    // Always requests a tool until the budget runs out, then a tool-less call answers.
    chat.mockImplementation(async ({ tools }) => {
      if (tools.length === 0) {
        return finalChat();
      }
      return { content: "", toolCalls: [{ name: "get_recovery", arguments: {} }] };
    });
    const callTool = vi.fn(async () => ({ content: "x", isError: false }));

    const events = await collect(
      runAgentTurn({
        chat,
        tools: TOOLS,
        callTool,
        messages: [{ role: "user", content: "?" }],
        maxSteps: 2,
      }),
    );

    expect(finalChat).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "delta", content: "done" });
  });
});
