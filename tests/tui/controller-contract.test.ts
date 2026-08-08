import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type ControllerCompletion,
  runInteractiveController,
  type InteractiveControllerOutcome,
} from "../../src/tui/presenter.js";
import type {
  CommandViewModelMap,
  ExecutionContext,
  InteractiveCommandController,
  UiDecision,
  UiDriver,
  UiProgressEvent,
  UiProgressInputEvent,
  UiReviewDecision,
  SafeActionId,
} from "../../src/tui/types.js";
import { sanitizeTerminalText } from "../../src/tui/sanitize.js";

interface Options {
  readonly requestedId?: string | undefined;
}
interface Intent {
  readonly id: string;
}
interface Prepared {
  readonly id: string;
  readonly generation: number;
}
interface Result {
  readonly value: string;
}

const completion: ControllerCompletion<Result, "ls"> = {
  screen: "ls",
  buildViewModel: () => ({
    type: "empty",
    nextCommand: sanitizeTerminalText("local-llmup up <model>", "single_line"),
  }),
};

function driver(overrides: Partial<UiDriver> = {}): UiDriver {
  return {
    mode: "tui",
    choose: async () => ({ type: "cancelled" }),
    review: async () => ({ type: "accepted" }),
    emit: vi.fn(),
    complete: async () => undefined,
    fail: async () => undefined,
    ...overrides,
  };
}

describe("interactive controller contract", () => {
  it("runs resolve -> prepare -> review -> execute once and rebuilds after back", async () => {
    const calls: string[] = [];
    let generation = 0;
    const reviews: UiReviewDecision[] = [{ type: "back" }, { type: "accepted" }];
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => {
        calls.push("resolve");
        return { type: "accepted", value: { id: "qwen3:14b" } };
      },
      prepare: async (intent, context) => {
        calls.push("prepare");
        expect(context.signal.aborted).toBe(false);
        return { id: intent.id, generation: ++generation };
      },
      review: async (prepared) => {
        calls.push(`review:${String(prepared.generation)}`);
        return reviews.shift() ?? { type: "cancelled" };
      },
      execute: async (prepared, context) => {
        calls.push(`execute:${String(prepared.generation)}`);
        context.emit({ type: "phase_started", phase: "read-only", label: "Build" });
        context.emit({ type: "phase_completed", phase: "read-only" });
        return { value: prepared.id };
      },
    };
    const emit = vi.fn<(event: UiProgressEvent) => void>();

    const outcome = await runInteractiveController(
      {},
      driver({ emit }),
      controller,
      new AbortController().signal,
      completion,
    );

    expect(outcome).toEqual({ type: "completed", result: { value: "qwen3:14b" } });
    expect(calls).toEqual([
      "resolve",
      "prepare",
      "review:1",
      "resolve",
      "prepare",
      "review:2",
      "execute:2",
    ]);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["intent", { type: "cancelled" } as const],
    ["review", { type: "cancelled" } as const],
  ])("returns cancellation at %s without executing", async (point, cancellation) => {
    const execute = vi.fn<InteractiveCommandController<Options, Intent, Prepared, Result>["execute"]>();
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async (): Promise<UiDecision<Intent>> =>
        point === "intent" ? cancellation : { type: "accepted", value: { id: "x" } },
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => (point === "review" ? cancellation : { type: "accepted" }),
      execute,
    };

    const outcome = await runInteractiveController(
      {},
      driver(),
      controller,
      new AbortController().signal,
      completion,
    );

    expect(outcome).toEqual({ type: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards one signal and one validated emitter to prepare and execute", async () => {
    const abort = new AbortController();
    const emit = vi.fn<(event: UiProgressEvent) => void>();
    const contexts: ExecutionContext[] = [];
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent, context) => {
        contexts.push(context);
        return { id: intent.id, generation: 1 };
      },
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        contexts.push(context);
        return { value: "done" };
      },
    };

    await runInteractiveController({}, driver({ emit }), controller, abort.signal, completion);

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.signal).toBe(abort.signal);
    expect(contexts[1]?.signal).toBe(abort.signal);
    expect(contexts[0]?.emit).toBe(contexts[1]?.emit);
    expect(contexts[0]?.emit).not.toBe(emit);
  });

  it("builds and completes one command-specific view model exactly once", async () => {
    const order: string[] = [];
    const complete = vi.fn(async () => {
      order.push("complete");
    });
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => {
        order.push("execute");
        return { value: "done" };
      },
    };
    const buildViewModel = vi.fn(() => {
      order.push("build");
      return completion.buildViewModel({ value: "done" });
    });

    await runInteractiveController({}, driver({ complete }), controller, new AbortController().signal, {
      screen: "ls",
      buildViewModel,
    });

    expect(order).toEqual(["execute", "build", "complete"]);
    expect(buildViewModel).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("keeps completion failures inside sanitized fail handling", async () => {
    const fail = vi.fn(async () => undefined);
    const failure = new Error("render\n\u001b[31mfailed");
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "done" }),
    };

    await expect(
      runInteractiveController(
        {},
        driver({ complete: async () => Promise.reject(failure), fail }),
        controller,
        new AbortController().signal,
        completion,
      ),
    ).rejects.toBe(failure);
    expect(fail).toHaveBeenCalledWith({
      code: "unknown",
      message: "render\\n\\u{1B}[31mfailed",
    });
  });

  it("classifies an abort-triggered asynchronous rejection as cancellation", async () => {
    const abort = new AbortController();
    const fail = vi.fn(async () => undefined);
    const execute = vi.fn<InteractiveCommandController<Options, Intent, Prepared, Result>["execute"]>();
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async () => {
        abort.abort();
        throw new DOMException("aborted", "AbortError");
      },
      review: async () => ({ type: "accepted" }),
      execute,
    };

    await expect(
      runInteractiveController({}, driver({ fail }), controller, abort.signal, completion),
    ).resolves.toEqual({ type: "cancelled" });
    expect(fail).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("sanitizes and validates progress, then drops late events", async () => {
    const emitted: UiProgressEvent[] = [];
    let lateEmit: ExecutionContext["emit"] | undefined;
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        lateEmit = context.emit;
        context.emit(
          {
            type: "phase_started",
            phase: "read-only",
            label: "build\n\u001b[31m",
          } as UiProgressInputEvent,
        );
        context.emit(
          {
            type: "progress",
            phase: "read-only",
            completed: 1,
            total: 2,
            unit: "items",
          } as UiProgressInputEvent,
        );
        context.emit({
          type: "progress",
          phase: "read-only",
          completed: 2,
          total: 2,
          unit: "items",
        });
        context.emit({ type: "phase_completed", phase: "read-only" });
        return { value: "done" };
      },
    };

    await runInteractiveController(
      {},
      driver({ emit: (event) => emitted.push(event) }),
      controller,
      new AbortController().signal,
      completion,
    );
    lateEmit?.({ type: "message", phase: "read-only", level: "info", text: "late" });

    expect(emitted).toHaveLength(4);
    expect(emitted[0]).toEqual({
      type: "phase_started",
      phase: "read-only",
      label: "build\\n\\u{1B}[31m",
    });
    expect(emitted[1]).toEqual({
      type: "progress",
      phase: "read-only",
      completed: 1,
      total: 2,
      unit: "items",
    });
    expect(emitted.every((event) => Object.isFrozen(event))).toBe(true);
  });

  it("rejects accepted controller decisions with unknown fields", async () => {
    const execute = vi.fn<InteractiveCommandController<Options, Intent, Prepared, Result>["execute"]>();
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () =>
        ({
          type: "accepted",
          value: { id: "x" },
          secret: "must-not-cross",
        }) as UiDecision<Intent>,
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute,
    };

    await expect(
      runInteractiveController({}, driver(), controller, new AbortController().signal, completion),
    ).rejects.toThrow("invalid controller decision");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects controller decisions with hidden own properties", async () => {
    const execute = vi.fn<InteractiveCommandController<Options, Intent, Prepared, Result>["execute"]>();
    const decision = { type: "accepted", value: { id: "x" } } as UiDecision<Intent>;
    Object.defineProperty(decision, "secret", { value: "must-not-cross", enumerable: false });
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => decision,
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute,
    };

    await expect(
      runInteractiveController({}, driver(), controller, new AbortController().signal, completion),
    ).rejects.toThrow("invalid controller decision");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unknown field",
      events: [
        { type: "phase_started", phase: "read-only", label: "bad", secret: "no" },
      ],
    },
    {
      name: "type",
      events: [{ type: "unknown", phase: "read-only" }],
    },
    {
      name: "phase",
      events: [{ type: "phase_started", phase: "not-a-phase", label: "bad" }],
    },
    {
      name: "level",
      events: [
        { type: "phase_started", phase: "read-only", label: "start" },
        { type: "message", phase: "read-only", level: "fatal", text: "bad" },
      ],
    },
    {
      name: "unit",
      events: [
        { type: "phase_started", phase: "read-only", label: "start" },
        { type: "progress", phase: "read-only", completed: 1, total: 1, unit: "records" },
      ],
    },
    {
      name: "code",
      events: [
        { type: "phase_started", phase: "read-only", label: "start" },
        { type: "phase_failed", phase: "read-only", code: "fatal", detail: "bad" },
      ],
    },
  ])("rejects malformed progress $name metadata", async ({ events }) => {
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        for (const event of events) context.emit(event as UiProgressInputEvent);
        return { value: "unreachable" };
      },
    };

    await expect(
      runInteractiveController({}, driver(), controller, new AbortController().signal, completion),
    ).rejects.toThrow("invalid UI progress event");
  });

  it("rejects duplicate or invalid progress before the driver", async () => {
    const emit = vi.fn<(event: UiProgressEvent) => void>();
    const fail = vi.fn(async () => undefined);
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        context.emit({ type: "phase_started", phase: "read-only", label: "build" });
        context.emit({ type: "phase_started", phase: "read-only", label: "again" });
        return { value: "unreachable" };
      },
    };

    await expect(
      runInteractiveController({}, driver({ emit, fail }), controller, new AbortController().signal, completion),
    ).rejects.toThrow("duplicate phase start");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("rejects progress unit drift", async () => {
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        context.emit({ type: "phase_started", phase: "read-only", label: "build" });
        context.emit({ type: "progress", phase: "read-only", completed: 1, total: 2, unit: "bytes" });
        context.emit({ type: "progress", phase: "read-only", completed: 2, total: 2, unit: "items" });
        return { value: "unreachable" };
      },
    };
    await expect(
      runInteractiveController({}, driver(), controller, new AbortController().signal, completion),
    ).rejects.toThrow("progress unit cannot change");
  });

  it("rejects completion before a known progress total is reached", async () => {
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        context.emit({ type: "phase_started", phase: "read-only", label: "build" });
        context.emit({ type: "progress", phase: "read-only", completed: 1, total: 2, unit: "items" });
        context.emit({ type: "phase_completed", phase: "read-only" });
        return { value: "unreachable" };
      },
    };
    await expect(
      runInteractiveController({}, driver(), controller, new AbortController().signal, completion),
    ).rejects.toThrow("phase cannot complete before its progress total");
  });

  it("rejects Back while the current generation has an unterminated phase", async () => {
    const execute = vi.fn<InteractiveCommandController<Options, Intent, Prepared, Result>["execute"]>();
    let reviews = 0;
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent, context) => {
        context.emit({ type: "phase_started", phase: "prepare", label: "prepare" });
        return { id: intent.id, generation: 1 };
      },
      review: async () => (++reviews === 1 ? { type: "back" } : { type: "cancelled" }),
      execute,
    };
    await expect(
      runInteractiveController({}, driver(), controller, new AbortController().signal, completion),
    ).rejects.toThrow("phase did not terminate: prepare");
    expect(execute).not.toHaveBeenCalled();
  });

  it("drops progress emitted by a stale generation after Back", async () => {
    const emitted: UiProgressEvent[] = [];
    let staleEmit: ExecutionContext["emit"] | undefined;
    let generation = 0;
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent, context) => {
        generation += 1;
        if (generation === 1) staleEmit = context.emit;
        if (generation === 2) {
          staleEmit?.({ type: "phase_started", phase: "prepare", label: "stale" });
        }
        return { id: intent.id, generation };
      },
      review: async (prepared) =>
        prepared.generation === 1 ? { type: "back" } : { type: "accepted" },
      execute: async () => ({ value: "done" }),
    };
    await runInteractiveController(
      {},
      driver({ emit: (event) => emitted.push(event) }),
      controller,
      new AbortController().signal,
      completion,
    );
    expect(emitted).toEqual([]);
  });

  it("rejects a driver choice that is not an actionable request member", async () => {
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async (_options, ui, context) => {
        const decision = await ui.choose({
          title: sanitizeTerminalText("Choose", "single_line"),
          items: [
            {
              actionable: true,
              id: "safe" as SafeActionId,
              display: sanitizeTerminalText("safe", "action_identifier"),
            },
            {
              actionable: false,
              display: sanitizeTerminalText("unsafe", "action_identifier"),
            },
          ],
          initialId: "safe",
          signal: context.signal,
        });
        return decision.type === "cancelled"
          ? decision
          : { type: "accepted", value: { id: decision.value.id } };
      },
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "unreachable" }),
    };
    await expect(
      runInteractiveController(
        {},
        driver({
          choose: async () => ({
            type: "accepted",
            value: { id: "not-requested" as SafeActionId },
          }),
        }),
        controller,
        new AbortController().signal,
        completion,
      ),
    ).rejects.toThrow("non-actionable or unknown choice");
  });

  it("snapshots and freezes choices before calling an untrusted driver", async () => {
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async (_options, ui, context) => {
        const decision = await ui.choose({
          title: sanitizeTerminalText("Choose", "single_line"),
          items: [
            {
              actionable: true,
              id: "safe" as SafeActionId,
              display: sanitizeTerminalText("safe", "action_identifier"),
            },
          ],
          initialId: "safe",
          signal: context.signal,
        });
        return decision.type === "cancelled"
          ? decision
          : { type: "accepted", value: { id: decision.value.id } };
      },
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "unreachable" }),
    };
    await expect(
      runInteractiveController(
        {},
        driver({
          choose: async (request) => {
            expect(Object.isFrozen(request)).toBe(true);
            expect(Object.isFrozen(request.items)).toBe(true);
            expect(Object.isFrozen(request.items[0])).toBe(true);
            try {
              const mutable = request.items as unknown as Array<(typeof request.items)[number]>;
              mutable.splice(0, 1, {
                actionable: true,
                id: "../../unsafe;target" as SafeActionId,
                display: sanitizeTerminalText("unsafe", "action_identifier"),
              });
            } catch {
              // Frozen snapshots must reject mutation; validation still uses the pre-call membership set.
            }
            return {
              type: "accepted",
              value: { id: "../../unsafe;target" as SafeActionId },
            };
          },
        }),
        controller,
        new AbortController().signal,
        completion,
      ),
    ).rejects.toThrow("non-actionable or unknown choice");
  });

  it("rejects malformed review decisions instead of executing", async () => {
    const execute = vi.fn<InteractiveCommandController<Options, Intent, Prepared, Result>["execute"]>();
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async (_prepared, ui, context) =>
        ui.review({
          screen: "up",
          viewModel: {
            title: sanitizeTerminalText("Review", "single_line"),
            canonicalTargetIds: ["model"],
            lines: [sanitizeTerminalText("line", "single_line")],
          },
          signal: context.signal,
        }),
      execute,
    };
    await expect(
      runInteractiveController(
        {},
        driver({
          review: async () => ({ type: "corrupt" }) as unknown as UiReviewDecision,
        }),
        controller,
        new AbortController().signal,
        completion,
      ),
    ).rejects.toThrow("invalid UI review decision");
    expect(execute).not.toHaveBeenCalled();
  });

  it("projects and sanitizes a frozen review request at runtime", async () => {
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async (_prepared, ui, context) =>
        ui.review({
          screen: "up",
          viewModel: {
            title: "Review\n\u001b[31m" as ReturnType<typeof sanitizeTerminalText>,
            canonicalTargetIds: ["model"],
            lines: ["line\u001b[31m" as ReturnType<typeof sanitizeTerminalText>],
          },
          signal: context.signal,
        }),
      execute: async () => ({ value: "done" }),
    };
    await runInteractiveController(
      {},
      driver({
        review: async (request) => {
          expect(Object.isFrozen(request)).toBe(true);
          expect(Object.isFrozen(request.viewModel)).toBe(true);
          expect(Object.isFrozen(request.viewModel.lines)).toBe(true);
          expect(request.viewModel.title).toBe("Review\\n\\u{1B}[31m");
          expect(request.viewModel.lines).toEqual(["line\\u{1B}[31m"]);
          return { type: "accepted" };
        },
      }),
      controller,
      new AbortController().signal,
      completion,
    );
  });

  it("returns cancellation when execute resolves after abort and skips completion", async () => {
    const abort = new AbortController();
    const complete = vi.fn(async () => undefined);
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => {
        abort.abort();
        return { value: "done" };
      },
    };
    await expect(
      runInteractiveController({}, driver({ complete }), controller, abort.signal, completion),
    ).resolves.toEqual({ type: "cancelled" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns cancellation when the signal aborts during completion rendering", async () => {
    const abort = new AbortController();
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "done" }),
    };
    await expect(
      runInteractiveController(
        {},
        driver({ complete: async () => abort.abort() }),
        controller,
        abort.signal,
        completion,
      ),
    ).resolves.toEqual({ type: "cancelled" });
  });

  it("does not mask a non-abort domain failure merely because the signal is aborted", async () => {
    const abort = new AbortController();
    const fail = vi.fn(async () => undefined);
    const failure = new Error("cleanup failed");
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async () => {
        abort.abort();
        throw failure;
      },
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "unreachable" }),
    };
    await expect(
      runInteractiveController({}, driver({ fail }), controller, abort.signal, completion),
    ).rejects.toBe(failure);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("rejects progress floods before forwarding an unbounded event stream", async () => {
    const emit = vi.fn<(event: UiProgressEvent) => void>();
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        context.emit({ type: "phase_started", phase: "read-only", label: "build" });
        for (let completed = 1; completed <= 1_001; completed += 1) {
          context.emit({
            type: "progress",
            phase: "read-only",
            completed,
            total: 1_001,
            unit: "items",
          });
        }
        return { value: "unreachable" };
      },
    };
    await expect(
      runInteractiveController({}, driver({ emit }), controller, new AbortController().signal, completion),
    ).rejects.toThrow("progress event limit exceeded");
    expect(emit).toHaveBeenCalledTimes(1_000);
  });

  it("drops retained events emitted while completion rendering is pending", async () => {
    const emitted: UiProgressEvent[] = [];
    let retained: ExecutionContext["emit"] | undefined;
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async (_prepared, context) => {
        retained = context.emit;
        return { value: "done" };
      },
    };
    await runInteractiveController(
      {},
      driver({
        emit: (event) => emitted.push(event),
        complete: async () => {
          retained?.({ type: "phase_started", phase: "read-only", label: "late" });
        },
      }),
      controller,
      new AbortController().signal,
      completion,
    );
    expect(emitted).toEqual([]);
  });

  it("rejects forged canonical identifiers before command-specific completion", async () => {
    const complete = vi.fn(async () => undefined);
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "done" }),
    };
    const forgedCompletion: ControllerCompletion<Result, "ls"> = {
      screen: "ls",
      buildViewModel: () => ({
        type: "active",
        model: {
          actionable: true,
          canonical: "../../unsafe;target",
          display: sanitizeTerminalText("unsafe", "action_identifier"),
        },
        backend: sanitizeTerminalText("ollama", "single_line"),
        endpoint: sanitizeTerminalText("http://127.0.0.1:11434", "single_line"),
        port: 11434,
        ownership: "owned",
      }),
    };

    await expect(
      runInteractiveController(
        {},
        driver({ complete }),
        controller,
        new AbortController().signal,
        forgedCompletion,
      ),
    ).rejects.toThrow("canonical action id must be a bounded printable ASCII identifier");
    expect(complete).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown completion fields", async () => {
    const complete = vi.fn(async () => undefined);
    const controller: InteractiveCommandController<Options, Intent, Prepared, Result> = {
      resolveIntent: async () => ({ type: "accepted", value: { id: "x" } }),
      prepare: async (intent) => ({ id: intent.id, generation: 1 }),
      review: async () => ({ type: "accepted" }),
      execute: async () => ({ value: "done" }),
    };
    const completionWithSecret: ControllerCompletion<Result, "ls"> = {
      screen: "ls",
      buildViewModel: () =>
        ({
          type: "empty",
          nextCommand: sanitizeTerminalText("local-llmup up <model>", "single_line"),
          authToken: "must-not-cross-ui-boundary",
        }) as CommandViewModelMap["ls"],
    };

    await expect(
      runInteractiveController(
        {},
        driver({ complete }),
        controller,
        new AbortController().signal,
        completionWithSecret,
      ),
    ).rejects.toThrow("invalid ls completion view model");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps complete() command-specific at the type boundary", () => {
    expectTypeOf<UiDriver["complete"]>().toBeCallableWith(
      "ls",
      {} as CommandViewModelMap["ls"],
    );
    expectTypeOf<UiDriver["complete"]>().not.toBeCallableWith(
      "ls",
      {} as CommandViewModelMap["recommend"],
    );
    expectTypeOf<InteractiveControllerOutcome<Result>>().toEqualTypeOf<
      { readonly type: "completed"; readonly result: Result } | { readonly type: "cancelled" }
    >();
  });
});
