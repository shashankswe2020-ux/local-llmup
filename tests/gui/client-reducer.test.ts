import { beforeAll, describe, expect, it } from "vitest";

interface RunState {
  readonly phase: string;
  readonly prompt: string;
  readonly reply: string;
  readonly error: string | null;
}

type RunAction =
  | { type: "submit"; prompt: string }
  | { type: "stream-event"; event: unknown }
  | { type: "request-stop" }
  | { type: "cancelled" }
  | { type: "stream-error"; message: string };

interface RunReducerModule {
  readonly PHASES: Record<string, string>;
  initialRunState(): RunState;
  reduceRun(state: RunState, action: RunAction): RunState;
  isActive(state: RunState): boolean;
}

let reducer: RunReducerModule;

beforeAll(async () => {
  await import("../../src/gui/static/run-reducer.js");
  reducer = (globalThis as unknown as { GuiRunReducer: RunReducerModule }).GuiRunReducer;
});

describe("run reducer", () => {
  it("starts idle and does not mutate input state", () => {
    const initial = reducer.initialRunState();
    expect(initial.phase).toBe("idle");
    const next = reducer.reduceRun(initial, { type: "submit", prompt: "hi" });
    expect(initial.phase).toBe("idle");
    expect(next).not.toBe(initial);
  });

  it("moves submit -> sending -> running -> completed", () => {
    let state = reducer.reduceRun(reducer.initialRunState(), { type: "submit", prompt: "hi" });
    expect(state.phase).toBe("sending");
    expect(state.prompt).toBe("hi");

    state = reducer.reduceRun(state, { type: "stream-event", event: { type: "delta", content: "A" } });
    expect(state.phase).toBe("running");
    expect(state.reply).toBe("A");

    state = reducer.reduceRun(state, { type: "stream-event", event: { type: "delta", content: "B" } });
    expect(state.reply).toBe("AB");

    state = reducer.reduceRun(state, { type: "stream-event", event: { type: "done" } });
    expect(state.phase).toBe("completed");
    expect(state.reply).toBe("AB");
  });

  it("preserves the partial reply on failure", () => {
    let state = reducer.reduceRun(reducer.initialRunState(), { type: "submit", prompt: "hi" });
    state = reducer.reduceRun(state, { type: "stream-event", event: { type: "delta", content: "half" } });
    state = reducer.reduceRun(state, {
      type: "stream-event",
      event: { type: "error", message: "backend down" },
    });
    expect(state.phase).toBe("failed");
    expect(state.reply).toBe("half");
    expect(state.error).toBe("backend down");
  });

  it("keeps the partial reply when cancelled and ignores late deltas", () => {
    let state = reducer.reduceRun(reducer.initialRunState(), { type: "submit", prompt: "hi" });
    state = reducer.reduceRun(state, { type: "stream-event", event: { type: "delta", content: "partial" } });
    state = reducer.reduceRun(state, { type: "request-stop" });
    expect(state.phase).toBe("stopping");

    state = reducer.reduceRun(state, { type: "cancelled" });
    expect(state.phase).toBe("cancelled");

    const late = reducer.reduceRun(state, {
      type: "stream-event",
      event: { type: "delta", content: " late" },
    });
    expect(late.phase).toBe("cancelled");
    expect(late.reply).toBe("partial late");
  });

  it("treats tool events as phase-neutral", () => {
    let state = reducer.reduceRun(reducer.initialRunState(), { type: "submit", prompt: "hi" });
    state = reducer.reduceRun(state, {
      type: "stream-event",
      event: { type: "tool", name: "search", phase: "start" },
    });
    expect(state.phase).toBe("sending");
  });

  it("marks transport failures as failed", () => {
    let state = reducer.reduceRun(reducer.initialRunState(), { type: "submit", prompt: "hi" });
    state = reducer.reduceRun(state, { type: "stream-error", message: "connection lost" });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("connection lost");
  });

  it("ignores stop requests once a run is idle or terminal", () => {
    const idle = reducer.initialRunState();
    expect(reducer.reduceRun(idle, { type: "request-stop" })).toBe(idle);
    expect(reducer.isActive(idle)).toBe(false);

    const done = reducer.reduceRun(
      reducer.reduceRun(idle, { type: "submit", prompt: "x" }),
      { type: "stream-event", event: { type: "done" } },
    );
    expect(reducer.reduceRun(done, { type: "request-stop" }).phase).toBe("completed");
  });
});
