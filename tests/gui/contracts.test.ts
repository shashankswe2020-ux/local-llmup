import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  DoneEventSchema,
  GUI_SCHEMA_VERSION,
  GuiSseEventSchema,
  isTerminalRunState,
  parseGuiSseEvent,
  RUN_STATES,
  serializeSseEvent,
  StructuredErrorSchema,
  TERMINAL_RUN_STATES,
  type RunState,
} from "../../src/gui/contracts.js";

describe("gui contracts", () => {
  it("stamps a stable schema version", () => {
    expect(GUI_SCHEMA_VERSION).toBe(1);
  });

  describe("SSE event union", () => {
    it("accepts each current wire event", () => {
      expect(parseGuiSseEvent({ type: "delta", content: "hi" })).toEqual({
        type: "delta",
        content: "hi",
      });
      expect(parseGuiSseEvent({ type: "tool", callId: "c1", name: "search", phase: "start" })).toBeDefined();
      expect(
        parseGuiSseEvent({
          type: "tool",
          callId: "c1",
          name: "search",
          phase: "done",
          isError: true,
          durationMs: 12,
        }),
      ).toBeDefined();
      expect(
        parseGuiSseEvent({
          type: "tool",
          callId: "c1",
          name: "search",
          phase: "approval-required",
          risk: "process-network",
          arguments: { q: "x" },
        }),
      ).toBeDefined();
      expect(
        parseGuiSseEvent({
          type: "done",
          turnsAppended: 1,
          factsExtracted: 0,
          vectorsEmbedded: 0,
        }),
      ).toBeDefined();
      expect(parseGuiSseEvent({ type: "error", message: "boom" })).toBeDefined();
    });

    it("accepts a context event with an attachment manifest", () => {
      expect(
        parseGuiSseEvent({
          type: "context",
          attachments: [
            {
              path: "src/index.ts",
              hash: "abc",
              size: 12,
              truncated: false,
              included: true,
              range: { startLine: 1, endLine: 5 },
            },
          ],
        }),
      ).toBeDefined();
      expect(parseGuiSseEvent({ type: "context", attachments: [] })).toBeDefined();
      expect(
        parseGuiSseEvent({ type: "context", attachments: [{ path: "x", hash: "h", size: 1 }] }),
      ).toBeUndefined();
    });

    it("accepts a disclosure-required event", () => {
      expect(
        parseGuiSseEvent({
          type: "disclosure-required",
          provider: "claude",
          model: "claude-3-5-haiku",
          items: [{ kind: "file", label: "a.ts", path: "a.ts", hash: "h", size: 3, truncated: false, included: true }],
          totalBytes: 3,
          excludedCount: 0,
        }),
      ).toBeDefined();
      expect(
        parseGuiSseEvent({ type: "disclosure-required", provider: "", model: "m", items: [], totalBytes: 0, excludedCount: 0 }),
      ).toBeUndefined();
    });

    it("accepts an edit review event", () => {
      expect(
        parseGuiSseEvent({
          type: "edit",
          review: {
            proposalId: "p1",
            warnings: [],
            files: [
              {
                path: "src/app.ts",
                op: "update",
                baseHash: "h",
                resultHash: "r",
                added: 1,
                removed: 1,
                hunks: [{ header: "@@", lines: [{ type: "add", text: "x" }] }],
                warnings: [],
              },
            ],
          },
        }),
      ).toBeDefined();
      expect(parseGuiSseEvent({ type: "edit", review: { proposalId: "p" } })).toBeUndefined();
    });

    it("rejects unknown, malformed, or partial events", () => {
      expect(parseGuiSseEvent({ type: "mystery" })).toBeUndefined();
      expect(parseGuiSseEvent({ type: "delta" })).toBeUndefined();
      expect(parseGuiSseEvent({ type: "tool", name: "", phase: "start" })).toBeUndefined();
      expect(parseGuiSseEvent({ type: "tool", name: "x", phase: "middle" })).toBeUndefined();
      expect(parseGuiSseEvent({ type: "done", turnsAppended: -1 })).toBeUndefined();
      expect(parseGuiSseEvent("not an object")).toBeUndefined();
    });

    it("round-trips through serialize and parse", () => {
      const frame = serializeSseEvent({ type: "delta", content: "chunk" });
      expect(frame).toBe(`data: ${JSON.stringify({ type: "delta", content: "chunk" })}\n\n`);
      const payload = frame.slice("data: ".length).trim();
      expect(parseGuiSseEvent(JSON.parse(payload))).toEqual({ type: "delta", content: "chunk" });
    });

    it("is a discriminated union keyed on type", () => {
      const options = GuiSseEventSchema.options.map((option) => option.shape.type.value);
      expect(new Set(options)).toEqual(
        new Set(["delta", "tool", "context", "disclosure-required", "edit", "done", "error"]),
      );
      expect(DoneEventSchema.safeParse({ type: "delta", content: "x" }).success).toBe(false);
    });
  });

  describe("run state machine", () => {
    it("marks exactly the terminal states terminal", () => {
      for (const state of RUN_STATES) {
        const terminal = (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
        expect(isTerminalRunState(state)).toBe(terminal);
      }
    });

    it("allows documented forward transitions", () => {
      expect(canTransitionRun("queued", "assembling-context")).toBe(true);
      expect(canTransitionRun("assembling-context", "running")).toBe(true);
      expect(canTransitionRun("assembling-context", "awaiting-tool-approval")).toBe(true);
      expect(canTransitionRun("running", "stopping")).toBe(true);
      expect(canTransitionRun("running", "completed")).toBe(true);
      expect(canTransitionRun("stopping", "cancelled")).toBe(true);
    });

    it("fails closed on invalid and terminal transitions", () => {
      expect(canTransitionRun("queued", "completed")).toBe(false);
      expect(canTransitionRun("running", "queued")).toBe(false);
      for (const terminal of TERMINAL_RUN_STATES) {
        for (const state of RUN_STATES) {
          expect(canTransitionRun(terminal, state)).toBe(false);
        }
      }
    });
  });

  it("validates the structured error envelope", () => {
    expect(StructuredErrorSchema.safeParse({ error: "bad" }).success).toBe(true);
    expect(StructuredErrorSchema.safeParse({ error: "bad", code: "E_CONFLICT" }).success).toBe(true);
    expect(StructuredErrorSchema.safeParse({ error: "" }).success).toBe(false);
    expect(StructuredErrorSchema.safeParse({}).success).toBe(false);
  });
});
