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
    const toolEvents = events.filter((e) => e.type === "tool");
    expect(toolEvents.map((e) => e.phase)).toEqual(["proposed", "start", "done"]);
    expect(toolEvents[0]).toMatchObject({ name: "get_recovery", risk: "read-only" });
    expect(toolEvents[2]).toMatchObject({ name: "get_recovery", phase: "done", isError: false });
    expect(typeof toolEvents[0]?.callId).toBe("string");
    expect(events.at(-1)).toEqual({ type: "delta", content: "Your recovery is 55%." });

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

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        name: "get_recovery",
        phase: "done",
        isError: true,
      }),
    );
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

  it("stops before the first model step when the signal is already aborted", async () => {
    const chat = vi.fn<AgentChat>(async () => ({ content: "unreachable" }));
    const callTool = vi.fn(async () => ({ content: "", isError: false }));
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      runAgentTurn({
        chat,
        tools: TOOLS,
        callTool,
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("stops before executing tools once the signal aborts mid-turn", async () => {
    const controller = new AbortController();
    const chat = vi.fn<AgentChat>(async () => {
      // The model asks for a tool, but the run is cancelled before it executes.
      controller.abort();
      return { content: "", toolCalls: [{ name: "get_recovery", arguments: {} }] } satisfies ChatResult;
    });
    const callTool = vi.fn(async () => ({ content: "recovery=55", isError: false }));

    const events = await collect(
      runAgentTurn({
        chat,
        tools: TOOLS,
        callTool,
        messages: [{ role: "user", content: "recovery?" }],
        signal: controller.signal,
      }),
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tool" && e.phase === "start")).toBe(false);
  });

  it("forwards the cancellation signal to the chat call", async () => {
    const controller = new AbortController();
    const chat = vi.fn<AgentChat>(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      return { content: "ok" };
    });
    const callTool = vi.fn(async () => ({ content: "", isError: false }));

    await collect(
      runAgentTurn({
        chat,
        tools: TOOLS,
        callTool,
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );

    expect(chat).toHaveBeenCalledOnce();
  });

  it("gates a tool call behind approval and executes on approve", async () => {
    const chat = vi
      .fn<AgentChat>()
      .mockResolvedValueOnce({ content: "", toolCalls: [{ name: "get_recovery", arguments: {} }] })
      .mockResolvedValueOnce({ content: "done" });
    const callTool = vi.fn(async () => ({ content: "ok", isError: false }));
    const approver = {
      isPreApproved: () => false,
      requestDecision: vi.fn(async () => "approve-once" as const),
    };

    const events = await collect(
      runAgentTurn({
        chat,
        tools: TOOLS,
        callTool,
        messages: [{ role: "user", content: "?" }],
        approver,
        idFactory: () => "call-1",
      }),
    );

    expect(approver.requestDecision).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledOnce();
    const phases = events.filter((e) => e.type === "tool").map((e) => e.phase);
    expect(phases).toEqual(["proposed", "approval-required", "start", "done"]);
  });

  it("does not execute a denied tool and feeds the denial back to the model", async () => {
    const chat = vi
      .fn<AgentChat>()
      .mockResolvedValueOnce({ content: "", toolCalls: [{ name: "get_recovery", arguments: {} }] })
      .mockResolvedValueOnce({ content: "understood" });
    const callTool = vi.fn(async () => ({ content: "ok", isError: false }));
    const approver = {
      isPreApproved: () => false,
      requestDecision: async () => "deny" as const,
    };

    const events = await collect(
      runAgentTurn({ chat, tools: TOOLS, callTool, messages: [{ role: "user", content: "?" }], approver }),
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tool" && e.phase === "denied")).toBe(true);
    const secondCall = chat.mock.calls[1]?.[0];
    expect(secondCall?.messages.at(-1)?.content).toContain("denied");
  });

  it("skips the approval prompt when the tool is pre-approved for the session", async () => {
    const chat = vi
      .fn<AgentChat>()
      .mockResolvedValueOnce({ content: "", toolCalls: [{ name: "get_recovery", arguments: {} }] })
      .mockResolvedValueOnce({ content: "done" });
    const callTool = vi.fn(async () => ({ content: "ok", isError: false }));
    const requestDecision = vi.fn(async () => "approve-once" as const);
    const approver = { isPreApproved: () => true, requestDecision };

    const events = await collect(
      runAgentTurn({ chat, tools: TOOLS, callTool, messages: [{ role: "user", content: "?" }], approver }),
    );

    expect(requestDecision).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === "tool" && e.phase === "approval-required")).toBe(false);
  });
});
