import { ValidationError, type LocalLlmupError } from "../errors.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { parseCommandViewModel } from "./view-model-schema.js";
import { z } from "zod";
import type {
  CommandViewModelMap,
  ExecutionContext,
  InteractiveCommandController,
  UiDriver,
  UiErrorCode,
  UiErrorViewModel,
  UiPhase,
  UiProgressEvent,
  UiProgressInputEvent,
  UiControllerDriver,
  UiChoiceItem,
  UiChoiceRequest,
  UiDecision,
  UiReviewDecision,
  UiReviewRequest,
  SafeActionId,
} from "./types.js";

const MAX_PROGRESS_EVENTS_PER_GENERATION = 1_000;
const MAX_UI_COLLECTION_ITEMS = 1_000;
const MAX_UI_DATA_NODES = 100_000;
const SAFE_CANONICAL_PATTERN = /^[A-Za-z0-9._:/=-]+$/;

const reviewDecisionSchema = z
  .union([
    z.object({ type: z.literal("accepted") }).strict(),
    z.object({ type: z.literal("back") }).strict(),
    z.object({ type: z.literal("cancelled") }).strict(),
  ]);

const choiceDecisionSchema = z.union([
  z.object({ type: z.literal("cancelled") }).strict(),
  z
    .object({
      type: z.literal("accepted"),
      value: z.object({ id: z.string() }).strict(),
    })
    .strict(),
]);

const progressPhaseSchema = z.enum([
  "read-only",
  "resolve",
  "preflight",
  "select-backend",
  "acquire",
  "verify",
  "prior-cleanup",
  "serve",
  "readiness",
  "state-commit",
  "prepare",
  "review",
  "locked-revalidate",
  "state-clear",
  "stop-detach",
  "rollback",
  "load",
  "plan",
  "summarize-embed",
  "stage",
  "commit",
  "optional-source-delete",
  "read-draft",
  "request",
  "display",
  "memory-capture",
]);
const progressErrorCodeSchema = z.enum([
  "validation",
  "backend",
  "integrity",
  "timeout",
  "cancelled",
  "state-race",
  "filesystem",
  "render",
  "unknown",
]);
const progressInputSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("phase_started"), phase: progressPhaseSchema, label: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      phase: progressPhaseSchema,
      completed: z.number(),
      total: z.number().nullable(),
      unit: z.enum(["bytes", "items"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("message"),
      phase: progressPhaseSchema,
      level: z.enum(["info", "warn"]),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("phase_completed"),
      phase: progressPhaseSchema,
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("phase_failed"),
      phase: progressPhaseSchema,
      code: progressErrorCodeSchema,
      detail: z.string(),
    })
    .strict(),
]);

function parseProgressInput(value: unknown): UiProgressInputEvent {
  const parsed = progressInputSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("invalid UI progress event");
  return parsed.data as UiProgressInputEvent;
}

function parseReviewDecision(value: unknown): UiReviewDecision {
  const parsed = reviewDecisionSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("invalid UI review decision");
  return parsed.data;
}

function parseChoiceDecision(
  value: unknown,
): UiDecision<{ readonly id: SafeActionId }> {
  const parsed = choiceDecisionSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("invalid UI choice decision");
  return parsed.data as UiDecision<{ readonly id: SafeActionId }>;
}

function parseControllerDecision<T>(value: UiDecision<T>): UiDecision<T> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ValidationError("invalid controller decision");
  }
  const keys = Reflect.ownKeys(value);
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (
    typeDescriptor === undefined ||
    !("value" in typeDescriptor) ||
    !typeDescriptor.enumerable
  ) {
    throw new ValidationError("invalid controller decision");
  }
  if (typeDescriptor.value === "cancelled" && keys.length === 1 && keys[0] === "type") {
    return Object.freeze({ type: "cancelled" });
  }
  const valueDescriptor = Object.getOwnPropertyDescriptor(value, "value");
  if (
    typeDescriptor.value === "accepted" &&
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("value") &&
    valueDescriptor !== undefined &&
    "value" in valueDescriptor &&
    valueDescriptor.enumerable
  ) {
    return Object.freeze({ type: "accepted", value: valueDescriptor.value as T });
  }
  throw new ValidationError("invalid controller decision");
}

function assertSafeCanonical(value: string, label: string): void {
  if (
    Buffer.byteLength(value, "utf8") > 8 * 1024 ||
    !SAFE_CANONICAL_PATTERN.test(value) ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.split("/").includes("..")
  ) {
    throw new ValidationError(`${label} must be a bounded printable ASCII identifier`);
  }
}

function projectChoiceRequest<T extends UiChoiceItem>(
  request: UiChoiceRequest<T>,
  signal: AbortSignal,
): { readonly request: UiChoiceRequest<UiChoiceItem>; readonly actionableIds: ReadonlySet<string> } {
  if (request.items.length > MAX_UI_COLLECTION_ITEMS) {
    throw new ValidationError("choice item limit exceeded");
  }
  const items: UiChoiceItem[] = request.items.map((item) => {
    if (!item.actionable) {
      return Object.freeze({
        actionable: false,
        display: sanitizeTerminalText(item.display, "action_identifier"),
      });
    }
    assertSafeCanonical(item.id, "choice id");
    return Object.freeze({
      actionable: true,
      id: item.id,
      display: sanitizeTerminalText(item.display, "action_identifier"),
    });
  });
  const actionableIds = new Set<string>(
    items.filter((item) => item.actionable).map((item) => item.id),
  );
  if (request.initialId !== null && !actionableIds.has(request.initialId)) {
    throw new ValidationError("initial choice must identify an actionable item");
  }
  const projected = Object.freeze({
    title: sanitizeTerminalText(request.title, "single_line"),
    items: Object.freeze(items),
    initialId: request.initialId,
    signal,
  });
  return { request: projected, actionableIds };
}

function projectReviewRequest(request: UiReviewRequest, signal: AbortSignal): UiReviewRequest {
  if (!["up", "switch", "down", "migrate", "telemetry"].includes(request.screen)) {
    throw new ValidationError("invalid UI review screen");
  }
  if (
    request.viewModel.lines.length > MAX_UI_COLLECTION_ITEMS ||
    request.viewModel.canonicalTargetIds.length > MAX_UI_COLLECTION_ITEMS
  ) {
    throw new ValidationError("review item limit exceeded");
  }
  for (const id of request.viewModel.canonicalTargetIds) {
    assertSafeCanonical(id, "review target id");
  }
  return Object.freeze({
    screen: request.screen,
    viewModel: Object.freeze({
      title: sanitizeTerminalText(request.viewModel.title, "single_line"),
      canonicalTargetIds: Object.freeze([...request.viewModel.canonicalTargetIds]),
      lines: Object.freeze(
        request.viewModel.lines.map((line) => sanitizeTerminalText(line, "single_line")),
      ),
    }),
    signal,
  });
}

function projectUiData<T>(value: T): T {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, key: string | null = null): unknown => {
    nodes += 1;
    if (nodes > MAX_UI_DATA_NODES) throw new ValidationError("UI data node limit exceeded");
    if (typeof current === "string") {
      if (key === "canonical") {
        assertSafeCanonical(current, "canonical action id");
        return current;
      }
      return sanitizeTerminalText(current, "single_line");
    }
    if (typeof current === "number" || typeof current === "boolean" || current === null) {
      return current;
    }
    if (typeof current !== "object") {
      throw new ValidationError("UI data must contain plain serializable values only");
    }
    if (seen.has(current)) throw new ValidationError("UI data must not contain cycles");
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_UI_COLLECTION_ITEMS) {
        throw new ValidationError("UI collection item limit exceeded");
      }
      if (key === "argv") {
        return Object.freeze(
          current.map((argument) => {
            if (typeof argument !== "string") {
              throw new ValidationError("command argv must contain strings only");
            }
            assertSafeCanonical(argument, "command argument");
            return argument;
          }),
        );
      }
      return Object.freeze(current.map((child) => visit(child)));
    }
    if (Object.getPrototypeOf(current) !== Object.prototype) {
      throw new ValidationError("UI data must contain plain objects only");
    }
    const projected: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(current)) {
      projected[childKey] = visit(child, childKey);
    }
    return Object.freeze(projected);
  };
  return visit(value) as T;
}

function isAbortRejection(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && error.name === "AbortError";
}

export type InteractiveControllerOutcome<Result> =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "cancelled" };

export interface ControllerCompletion<Result, K extends keyof CommandViewModelMap> {
  readonly screen: K;
  readonly buildViewModel: (result: Result) => CommandViewModelMap[K];
}

interface PhaseState {
  readonly total: number | null;
  readonly completed: number;
  readonly unit: "bytes" | "items" | null;
  readonly terminal: boolean;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorCode(error: Error): UiErrorCode {
  const code = (error as Partial<LocalLlmupError>).code;
  switch (code) {
    case "VALIDATION":
      return "validation";
    case "BACKEND":
      return "backend";
    case "STATE":
      return "state-race";
    case "MEMORY":
    case "CATALOG":
      return "filesystem";
    default:
      return "unknown";
  }
}

function errorView(error: Error): UiErrorViewModel {
  return {
    code: errorCode(error),
    message: sanitizeTerminalText(error.message, "single_line"),
  };
}

function validateCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a nonnegative safe integer`);
  }
}

function sanitizeProgressEvent(event: UiProgressInputEvent): UiProgressEvent {
  switch (event.type) {
    case "phase_started":
      return Object.freeze({
        type: "phase_started",
        phase: event.phase,
        label: sanitizeTerminalText(event.label, "single_line"),
      });
    case "message":
      return Object.freeze({
        type: "message",
        phase: event.phase,
        level: event.level,
        text: sanitizeTerminalText(event.text, "single_line"),
      });
    case "phase_completed":
      return event.detail === undefined
        ? Object.freeze({ type: "phase_completed", phase: event.phase })
        : Object.freeze({
            type: "phase_completed",
            phase: event.phase,
            detail: sanitizeTerminalText(event.detail, "single_line"),
          });
    case "phase_failed":
      return Object.freeze({
        type: "phase_failed",
        phase: event.phase,
        code: event.code,
        detail: sanitizeTerminalText(event.detail, "single_line"),
      });
    case "progress":
      return Object.freeze({
        type: "progress",
        phase: event.phase,
        completed: event.completed,
        total: event.total,
        unit: event.unit,
      });
  }
}

function createProgressBoundary(
  output: (event: UiProgressEvent) => void,
  signal: AbortSignal,
): {
  beginGeneration(): (event: UiProgressInputEvent) => void;
  assertGenerationFinished(): void;
  deactivate(): void;
  finishExecution(): void;
} {
  const phases = new Map<UiPhase, PhaseState>();
  let active = true;
  let eventCount = 0;
  let generation = 0;
  const assertFinished = (): void => {
    const unfinished = [...phases.entries()].find(([, state]) => !state.terminal);
    if (unfinished !== undefined) {
      throw new ValidationError(`phase did not terminate: ${unfinished[0]}`);
    }
  };
  const emitForGeneration = (
    eventGeneration: number,
    input: UiProgressInputEvent,
  ): void => {
    if (!active || signal.aborted || eventGeneration !== generation) return;
    const event = parseProgressInput(input);
    eventCount += 1;
    if (eventCount > MAX_PROGRESS_EVENTS_PER_GENERATION) {
      throw new ValidationError("progress event limit exceeded");
    }
    const prior = phases.get(event.phase);
    if (event.type === "phase_started") {
      if (prior !== undefined) throw new ValidationError(`duplicate phase start: ${event.phase}`);
      phases.set(event.phase, { total: null, completed: 0, unit: null, terminal: false });
      output(sanitizeProgressEvent(event));
      return;
    }
    if (prior === undefined || prior.terminal) {
      throw new ValidationError(`out-of-order progress event for phase ${event.phase}`);
    }
    if (event.type === "progress") {
      validateCount(event.completed, "completed progress");
      if (event.completed < prior.completed) {
        throw new ValidationError("completed progress cannot decrease within a phase");
      }
      if (prior.unit !== null && prior.unit !== event.unit) {
        throw new ValidationError("progress unit cannot change within a phase");
      }
      if (event.total === null && prior.total !== null) {
        throw new ValidationError("known progress total cannot become unknown");
      }
      if (event.total !== null) {
        validateCount(event.total, "total progress");
        if (event.total === 0 || event.completed > event.total) {
          throw new ValidationError("progress total must be positive and >= completed");
        }
        if (prior.total !== null && prior.total !== event.total) {
          throw new ValidationError("progress total cannot change within a phase");
        }
        phases.set(event.phase, {
          total: event.total,
          completed: event.completed,
          unit: event.unit,
          terminal: false,
        });
      } else {
        phases.set(event.phase, {
          total: null,
          completed: event.completed,
          unit: event.unit,
          terminal: false,
        });
      }
      output(sanitizeProgressEvent(event));
      return;
    }
    if (event.type === "phase_completed" && prior.total !== null && prior.completed < prior.total) {
      throw new ValidationError("phase cannot complete before its progress total");
    }
    if (event.type === "phase_completed" || event.type === "phase_failed") {
      phases.set(event.phase, {
        total: prior.total,
        completed: prior.completed,
        unit: prior.unit,
        terminal: true,
      });
    }
    output(sanitizeProgressEvent(event));
  };
  return {
    beginGeneration: () => {
      generation += 1;
      phases.clear();
      eventCount = 0;
      const eventGeneration = generation;
      return (event): void => emitForGeneration(eventGeneration, event);
    },
    assertGenerationFinished: (): void => {
      assertFinished();
    },
    deactivate: (): void => {
      active = false;
    },
    finishExecution: (): void => {
      assertFinished();
      active = false;
    },
  };
}

/** Run one controller generation at a time; completion and execute each occur at most once. */
export async function runInteractiveController<
  Options,
  Intent,
  Prepared,
  Result,
  K extends keyof CommandViewModelMap,
>(
  options: Options,
  ui: UiDriver,
  controller: InteractiveCommandController<Options, Intent, Prepared, Result>,
  signal: AbortSignal,
  completion: ControllerCompletion<Result, K>,
): Promise<InteractiveControllerOutcome<Result>> {
  const boundary = createProgressBoundary(ui.emit, signal);
  const controllerUi: UiControllerDriver = {
    mode: ui.mode,
    choose: async (request) => {
      const projected = projectChoiceRequest(request, signal);
      const decision = parseChoiceDecision(await ui.choose(projected.request));
      if (
        decision.type === "accepted" &&
        !projected.actionableIds.has(decision.value.id)
      ) {
        throw new ValidationError("UI returned a non-actionable or unknown choice");
      }
      return decision;
    },
    review: async (request) =>
      parseReviewDecision(await ui.review(projectReviewRequest(request, signal))),
  };
  try {
    for (;;) {
      if (signal.aborted) return { type: "cancelled" };
      const context: ExecutionContext = { signal, emit: boundary.beginGeneration() };
      const intent = parseControllerDecision(
        await controller.resolveIntent(options, controllerUi, context),
      );
      if (intent.type === "cancelled" || signal.aborted) return { type: "cancelled" };
      const prepared = await controller.prepare(intent.value, context);
      if (signal.aborted) return { type: "cancelled" };
      const review = parseReviewDecision(
        await controller.review(prepared, controllerUi, context),
      );
      if (review.type === "cancelled" || signal.aborted) return { type: "cancelled" };
      if (review.type === "back") {
        boundary.assertGenerationFinished();
        continue;
      }
      const result = await controller.execute(prepared, context);
      boundary.finishExecution();
      if (signal.aborted) return { type: "cancelled" };
      const viewModel = projectUiData(
        parseCommandViewModel(completion.screen, completion.buildViewModel(result)),
      );
      await ui.complete(completion.screen, viewModel);
      if (signal.aborted) return { type: "cancelled" };
      return { type: "completed", result };
    }
  } catch (error) {
    if (isAbortRejection(error, signal)) return { type: "cancelled" };
    const failure = errorOf(error);
    try {
      await ui.fail(errorView(failure));
    } catch {
      // Preserve the domain/controller failure rather than masking it with presentation failure.
    }
    throw failure;
  } finally {
    boundary.deactivate();
  }
}
