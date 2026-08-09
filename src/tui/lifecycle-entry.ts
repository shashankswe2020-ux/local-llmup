import {
  executePreparedDown,
  formatDownResult,
  prepareDownConfirmation,
  type DownOptions,
  type DownPrepared,
  type DownResult,
  type DownExecutionObserver,
} from "../commands/down.js";
import {
  executePreparedSwitch,
  formatSwitchResult,
  prepareSwitch,
  type SwitchPrepared,
  type SwitchResult,
  type SwitchExecutionObserver,
} from "../commands/switch.js";
import {
  executePreparedUp,
  formatUpResult,
  prepareUp,
  type UpOptions,
  type UpPrepared,
  type UpResult,
  type UpExecutionObserver,
} from "../commands/up.js";
import { loadCatalog } from "../catalog/load.js";
import { loadConfig } from "../config.js";
import { readState } from "../state/state.js";
import type { BackendName } from "../types.js";
import { MemoryError } from "../errors.js";

export class LifecycleUiHandledError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LifecycleUiHandledError";
  }
}
import { ConfirmationDriftError } from "./snapshots.js";
import type { UiModeSelection } from "./capabilities.js";
import { createBoundedCookedLineReader } from "./cooked-line-reader.js";
import { runAccessibleLifecycleReview } from "./lifecycle-accessible.js";
import type {
  LifecycleProgressItem,
  LifecycleReviewDecision,
  LifecycleReviewViewModel,
} from "./lifecycle-types.js";
import type {
  LifecycleProgressSession,
  LifecycleReviewSession,
} from "./lifecycle-renderer.js";

export type InteractiveLifecycleSelection = UiModeSelection & {
  readonly mode: "tui" | "accessible";
};

interface VisualLifecycleModule {
  readonly mountLifecycleReview: (options: {
    readonly viewModel: LifecycleReviewViewModel;
    readonly stdin: NodeJS.ReadStream;
    readonly stderr: NodeJS.WriteStream;
    readonly color: boolean;
    readonly unicode: boolean;
  }) => LifecycleReviewSession;
  readonly mountLifecycleProgress: (options: {
    readonly screen: "up" | "switch" | "down";
    readonly target: string;
    readonly stdin: NodeJS.ReadStream;
    readonly stderr: NodeJS.WriteStream;
    readonly color: boolean;
    readonly unicode: boolean;
  }) => LifecycleProgressSession;
}

interface VisualPickerModule {
  readonly mountModelPicker: (options: {
    readonly title: string;
    readonly choices: readonly string[];
    readonly stdin: NodeJS.ReadStream;
    readonly stderr: NodeJS.WriteStream;
    readonly unicode: boolean;
  }) => { readonly waitForDecision: () => Promise<string | null> };
}

export interface InteractiveDownDeps {
  readonly stdin: NodeJS.ReadStream;
  readonly stderr: NodeJS.WriteStream;
  readonly prepare: (options: DownOptions) => Promise<DownPrepared>;
  readonly execute: (
    prepared: DownPrepared,
    observe?: DownExecutionObserver,
  ) => Promise<DownResult>;
  readonly format: (result: DownResult) => string;
  readonly loadVisualRenderer: () => Promise<VisualLifecycleModule>;
  readonly runAccessibleReview: (options: {
    readonly viewModel: LifecycleReviewViewModel;
    readonly readLine: () => Promise<string | null>;
    readonly write: (text: string) => void;
  }) => Promise<LifecycleReviewDecision>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

const defaultDownDeps: InteractiveDownDeps = {
  stdin: process.stdin,
  stderr: process.stderr,
  prepare: (options) => prepareDownConfirmation(options),
  execute: (prepared, observe) => executePreparedDown(prepared, undefined, observe),
  format: formatDownResult,
  loadVisualRenderer: () => import("./lifecycle-renderer.js"),
  runAccessibleReview: runAccessibleLifecycleReview,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface SharedLifecycleDeps<Prepared, Result, Observer> {
  readonly stdin: NodeJS.ReadStream;
  readonly stderr: NodeJS.WriteStream;
  readonly prepare: (options: {
    readonly model: string;
    readonly port?: number | undefined;
    readonly backend?: BackendName | undefined;
  }) => Promise<Prepared>;
  readonly execute: (prepared: Prepared, observe?: Observer) => Promise<Result>;
  readonly format: (result: Result) => string;
  readonly listModels: () => readonly string[];
  readonly loadVisualRenderer: () => Promise<VisualLifecycleModule>;
  readonly loadVisualPicker: () => Promise<VisualPickerModule>;
  readonly runAccessibleReview: InteractiveDownDeps["runAccessibleReview"];
  readonly runAccessiblePicker: (options: {
    readonly title: string;
    readonly choices: readonly string[];
    readonly readLine: () => Promise<string | null>;
    readonly write: (text: string) => void;
  }) => Promise<string | null>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export type InteractiveUpDeps = SharedLifecycleDeps<
  UpPrepared,
  UpResult,
  UpExecutionObserver
>;
export type InteractiveSwitchDeps = SharedLifecycleDeps<
  SwitchPrepared,
  SwitchResult,
  SwitchExecutionObserver
>;

const sharedDefaults = {
  stdin: process.stdin,
  stderr: process.stderr,
  listModels: () => loadCatalog().models.map((model) => model.id),
  loadVisualRenderer: () => import("./lifecycle-renderer.js"),
  loadVisualPicker: () => import("./model-picker.js"),
  runAccessibleReview: runAccessibleLifecycleReview,
  runAccessiblePicker: async (options: {
    readonly title: string;
    readonly choices: readonly string[];
    readonly readLine: () => Promise<string | null>;
    readonly write: (text: string) => void;
  }): Promise<string | null> => {
    const { runAccessibleModelPicker } = await import("./model-picker-accessible.js");
    return runAccessibleModelPicker(options);
  },
  writeStdout: (text: string) => process.stdout.write(text),
  writeStderr: (text: string) => process.stderr.write(text),
};

const defaultUpDeps: InteractiveUpDeps = {
  ...sharedDefaults,
  prepare: (options) => prepareUp(options),
  execute: (prepared, observe) => executePreparedUp(prepared, undefined, observe),
  format: formatUpResult,
};

export function filterSwitchModelChoices(
  modelIds: readonly string[],
  active: { readonly backend: BackendName; readonly modelId: string } | null,
): readonly string[] {
  if (active !== null && active.backend !== "ollama") return Object.freeze([]);
  return Object.freeze(modelIds.filter((modelId) => modelId !== active?.modelId));
}

const defaultSwitchDeps: InteractiveSwitchDeps = {
  ...sharedDefaults,
  listModels: () => {
    const active = readState(loadConfig()).active;
    return filterSwitchModelChoices(
      loadCatalog().models.map((model) => model.id),
      active === null ? null : { backend: active.backend, modelId: active.modelId },
    );
  },
  prepare: (options) => prepareSwitch(options),
  execute: (prepared, observe) => executePreparedSwitch(prepared, undefined, observe),
  format: formatSwitchResult,
};

function downReview(prepared: DownPrepared): LifecycleReviewViewModel {
  const snapshot = prepared.snapshot;
  const modelId = snapshot.canonicalTargetIds[0] ?? "none";
  const owned = snapshot.ownedByUs === true;
  return Object.freeze({
    screen: "down",
    title: owned ? "Stop active server?" : "Detach from active server?",
    canonicalTargetIds: Object.freeze([...snapshot.canonicalTargetIds]),
    lines: Object.freeze([
      `Model: ${modelId}`,
      `Backend: ${snapshot.backend ?? "none"}`,
      `Endpoint: ${snapshot.endpoint ?? "none"}`,
      owned
        ? "Consequence: stop verified local-llmup process and clear state."
        : "Consequence: leave runtime running and forget local state.",
    ]),
    confirmLabel: owned ? "Stop server" : "Detach",
    destructive: true,
  });
}

async function accessibleReview(
  prepared: DownPrepared,
  deps: InteractiveDownDeps,
): Promise<LifecycleReviewDecision> {
  const reader = createBoundedCookedLineReader(deps.stdin, 16);
  try {
    try {
      return await deps.runAccessibleReview({
        viewModel: downReview(prepared),
        readLine: reader.readLine,
        write: deps.writeStderr,
      });
    } catch (error) {
      deps.writeStderr(
        "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
      );
      throw new LifecycleUiHandledError("interactive-ui-pre-execution-failed", { cause: error });
    }
  } finally {
    reader.close();
  }
}

async function visualReview(
  prepared: DownPrepared,
  mode: InteractiveLifecycleSelection,
  renderer: VisualLifecycleModule,
  deps: InteractiveDownDeps,
): Promise<LifecycleReviewDecision> {
  try {
    const session = renderer.mountLifecycleReview({
      viewModel: downReview(prepared),
      stdin: deps.stdin,
      stderr: deps.stderr,
      color: mode.color,
      unicode: mode.unicode,
    });
    return await session.waitForDecision();
  } catch (error) {
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
    throw new LifecycleUiHandledError("interactive-ui-pre-execution-failed", { cause: error });
  }
}

export type InteractiveDownOutcome =
  | { readonly type: "completed"; readonly result: DownResult }
  | { readonly type: "cancelled" };

/** Review and execute `down` without ever re-preparing behind the user's approval. */
export async function runInteractiveDown(
  options: DownOptions,
  mode: InteractiveLifecycleSelection,
  yes: boolean,
  deps: InteractiveDownDeps = defaultDownDeps,
): Promise<InteractiveDownOutcome> {
  let renderer: VisualLifecycleModule | undefined;
  if (mode.mode === "tui") {
    try {
      renderer = await deps.loadVisualRenderer();
    } catch (error) {
      if (!mode.explicit) {
        deps.writeStderr(
          "local-llmup: interactive UI unavailable (renderer_init); continuing in plain mode\n",
        );
        const prepared = await deps.prepare(options);
        const result = await deps.execute(prepared);
        deps.writeStdout(deps.format(result));
        return { type: "completed", result };
      }
      deps.writeStderr(
        "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
      );
      throw error;
    }
  }

  for (;;) {
    const prepared = await deps.prepare(options);
    const hasActiveTarget = prepared.snapshot.canonicalTargetIds.length > 0;
    if (hasActiveTarget && !yes) {
      const decision =
        mode.mode === "accessible"
          ? await accessibleReview(prepared, deps)
          : await visualReview(prepared, mode, renderer as VisualLifecycleModule, deps);
      if (decision.type === "cancelled") return { type: "cancelled" };
    }

    let progress: LifecycleProgressSession | undefined;
    if (mode.mode === "tui") {
      try {
        progress = (renderer as VisualLifecycleModule).mountLifecycleProgress({
          screen: "down",
          target: prepared.snapshot.canonicalTargetIds[0] ?? "no active server",
          stdin: deps.stdin,
          stderr: deps.stderr,
          color: mode.color,
          unicode: mode.unicode,
        });
      } catch (error) {
        deps.writeStderr(
          "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
        );
        throw error;
      }
    }
    const progressBoundary = createProgressFallback(progress, deps);
    try {
      const result = await progressBoundary.execute(() =>
        deps.execute(prepared, (event) =>
          progressBoundary.emit({
            type: event.status,
            phase: event.phase,
            label: event.label,
          }),
        ),
      );
      deps.writeStdout(deps.format(result));
      return { type: "completed", result };
    } catch (error) {
      if (error instanceof ConfirmationDriftError && !yes) {
        deps.writeStderr("Active server changed; returning to a fresh review.\n");
        continue;
      }
      if (error instanceof Error && error.message === "interactive-ui-runtime-failed") {
        return { type: "cancelled" };
      }
      throw error;
    } finally {
      progressBoundary.unmount();
    }
  }
}

async function chooseLifecycleModel<Prepared, Result, Observer>(
  title: string,
  mode: InteractiveLifecycleSelection,
  deps: SharedLifecycleDeps<Prepared, Result, Observer>,
): Promise<string | null> {
  const choices = deps.listModels();
  if (choices.length === 0) {
    deps.writeStderr("No eligible models are available for this lifecycle action.\n");
    return null;
  }
  try {
    if (mode.mode === "tui") {
      const pickerModule = await deps.loadVisualPicker();
      return await pickerModule
        .mountModelPicker({
          title,
          choices,
          stdin: deps.stdin,
          stderr: deps.stderr,
          unicode: mode.unicode,
        })
        .waitForDecision();
    }
    const reader = createBoundedCookedLineReader(deps.stdin, 256);
    try {
      return await deps.runAccessiblePicker({
        title,
        choices,
        readLine: reader.readLine,
        write: deps.writeStderr,
      });
    } finally {
      reader.close();
    }
  } catch (error) {
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
    throw new LifecycleUiHandledError("interactive-ui-pre-execution-failed", { cause: error });
  }
}

async function reviewPrepared<Prepared, Result, Observer>(
  viewModel: LifecycleReviewViewModel,
  mode: InteractiveLifecycleSelection,
  renderer: VisualLifecycleModule | undefined,
  deps: SharedLifecycleDeps<Prepared, Result, Observer>,
): Promise<LifecycleReviewDecision> {
  try {
    if (mode.mode === "tui") {
      return await (renderer as VisualLifecycleModule)
        .mountLifecycleReview({
          viewModel,
          stdin: deps.stdin,
          stderr: deps.stderr,
          color: mode.color,
          unicode: mode.unicode,
        })
        .waitForDecision();
    }
    const reader = createBoundedCookedLineReader(deps.stdin, 16);
    try {
      return await deps.runAccessibleReview({
        viewModel,
        readLine: reader.readLine,
        write: deps.writeStderr,
      });
    } finally {
      reader.close();
    }
  } catch (error) {
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
      throw new LifecycleUiHandledError("interactive-ui-pre-execution-failed", { cause: error });
  }
}

function upReview(prepared: UpPrepared): LifecycleReviewViewModel {
  const prior = prepared.snapshot.canonicalTargetIds[0];
  const replacing = prepared.snapshot.canonicalTargetIds.length === 2;
  return {
    screen: "up",
    title: `Bring ${prepared.model.id} online?`,
    canonicalTargetIds: [...prepared.snapshot.canonicalTargetIds],
    lines: [
      `Model: ${prepared.model.id} (${prepared.quant.name})`,
      `Backend: ${prepared.adapter.name} (${prepared.backendSource})`,
      `Disk: need ${String(prepared.quant.diskBytes)} bytes; ${String(prepared.hardware.freeDiskBytes)} bytes free`,
      `Bind: 127.0.0.1:${String(prepared.port)}`,
      replacing
        ? `Replacement: ${prior ?? "active server"} will be replaced; owned cleanup can leave no active server if startup fails.`
        : "Replacement: no active server.",
      ...(prepared.fitWarning === null ? [] : [`Warning: ${prepared.fitWarning}`]),
    ],
    confirmLabel: "Continue",
    destructive: replacing || prepared.fitWarning !== null,
  };
}

function switchReview(prepared: SwitchPrepared): LifecycleReviewViewModel {
  if (prepared.type === "already-active") {
    return {
      screen: "switch",
      title: `${prepared.targetId} is already active`,
      canonicalTargetIds: [prepared.targetId],
      lines: [`Backend: ${prepared.backend}`, `Endpoint: ${prepared.endpoint}`],
      confirmLabel: "Done",
      destructive: false,
    };
  }
  return {
    screen: "switch",
    title: `Switch to ${prepared.targetId}?`,
    canonicalTargetIds: [prepared.currentModelId, prepared.targetId],
    lines: [
      `Current: ${prepared.currentModelId}`,
      `Target: ${prepared.targetId}`,
      `Backend: ${prepared.backend}`,
      `Endpoint: ${prepared.endpoint}`,
      `Pull: ${prepared.ollamaId} (${String(prepared.expectedSizeBytes)} bytes)`,
    ],
    confirmLabel: "Continue",
    destructive: false,
  };
}

async function loadRenderer<Prepared, Result, Observer>(
  mode: InteractiveLifecycleSelection,
  deps: SharedLifecycleDeps<Prepared, Result, Observer>,
  canFallbackToPlain: boolean,
): Promise<VisualLifecycleModule | undefined> {
  if (mode.mode !== "tui") return undefined;
  try {
    return await deps.loadVisualRenderer();
  } catch (error) {
    if (!mode.explicit && canFallbackToPlain) {
      deps.writeStderr(
        "local-llmup: interactive UI unavailable (renderer_init); continuing in plain mode\n",
      );
      return undefined;
    }
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
    throw error;
  }
}

export type InteractiveLifecycleOutcome<Result> =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "cancelled" };

function emitLifecycle(
  progress: LifecycleProgressSession | undefined,
  deps: { readonly writeStderr: (text: string) => void },
  item: LifecycleProgressItem,
): void {
  if (progress !== undefined) progress.emit(item);
  else deps.writeStderr(`${item.label}\n`);
}

function createProgressFallback(
  initial: LifecycleProgressSession | undefined,
  deps: { readonly writeStderr: (text: string) => void },
): {
  readonly execute: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly emit: (item: LifecycleProgressItem) => void;
  readonly unmount: () => void;
} {
  let progress = initial;
  let failed = false;
  let executionStarted = false;
  let preExecutionFailure: Error | undefined;
  const notice = (): void => {
    if (failed) return;
    failed = true;
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
    );
  };
  const restore = (): boolean => {
    let restoreFailed = false;
    try {
      progress?.unmount();
    } catch {
      restoreFailed = true;
    }
    progress = undefined;
    return restoreFailed;
  };
  initial?.onFailure((error) => {
    restore();
    if (executionStarted) notice();
    else preExecutionFailure = error;
  });
  return {
    execute: async <T>(operation: () => Promise<T>): Promise<T> => {
      await Promise.resolve();
      if (preExecutionFailure !== undefined) {
        deps.writeStderr(
          "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
        );
        throw new LifecycleUiHandledError("interactive-ui-pre-execution-failed", {
          cause: preExecutionFailure,
        });
      }
      executionStarted = true;
      return operation();
    },
    emit: (item): void => {
      try {
        emitLifecycle(progress, deps, item);
      } catch {
        restore();
        notice();
        deps.writeStderr(`${item.label}\n`);
        throw new Error("interactive-ui-runtime-failed");
      }
    },
    unmount: (): void => {
      if (restore()) notice();
    },
  };
}

function mountProgressBeforeExecution(
  renderer: VisualLifecycleModule | undefined,
  screen: "up" | "switch",
  target: string,
  mode: InteractiveLifecycleSelection,
  deps: { readonly stdin: NodeJS.ReadStream; readonly stderr: NodeJS.WriteStream; readonly writeStderr: (text: string) => void },
): LifecycleProgressSession | undefined {
  if (mode.mode !== "tui") return undefined;
  try {
    return (renderer as VisualLifecycleModule).mountLifecycleProgress({
      screen,
      target,
      stdin: deps.stdin,
      stderr: deps.stderr,
      color: mode.color,
      unicode: mode.unicode,
    });
  } catch (error) {
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
    throw error;
  }
}

/** Run the staged up review and execute its exact preparation at most once. */
export async function runInteractiveUp(
  options: Omit<UpOptions, "model"> & { readonly model?: string | undefined },
  mode: InteractiveLifecycleSelection,
  deps: InteractiveUpDeps = defaultUpDeps,
): Promise<InteractiveLifecycleOutcome<UpResult>> {
  const renderer = await loadRenderer(mode, deps, options.model !== undefined);
  if (mode.mode === "tui" && renderer === undefined) {
    if (options.model === undefined) {
      deps.writeStderr(
        "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
      );
      return { type: "cancelled" };
    }
    const prepared = await deps.prepare({
      model: options.model,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.backend !== undefined ? { backend: options.backend } : {}),
    });
    const result = await deps.execute(prepared);
    deps.writeStdout(deps.format(result));
    return { type: "completed", result };
  }
  const model = options.model ?? (await chooseLifecycleModel("Choose a model to start", mode, deps));
  if (model === null) return { type: "cancelled" };
  for (;;) {
    const prepared = await deps.prepare({
      model,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.backend !== undefined ? { backend: options.backend } : {}),
    });
    const decision = await reviewPrepared(upReview(prepared), mode, renderer, deps);
    if (decision.type === "cancelled") return { type: "cancelled" };
    const progress = mountProgressBeforeExecution(
      renderer,
      "up",
      prepared.model.id,
      mode,
      deps,
    );
    const progressBoundary = createProgressFallback(progress, deps);
    try {
      const result = await progressBoundary.execute(() =>
        deps.execute(prepared, (event) =>
          progressBoundary.emit({
            type: event.status,
            phase: event.phase,
            label: event.label,
          }),
        ),
      );
      deps.writeStdout(deps.format(result));
      return { type: "completed", result };
    } catch (error) {
      if (error instanceof ConfirmationDriftError) {
        deps.writeStderr("Active server changed; returning to a fresh review.\n");
        continue;
      }
      if (error instanceof Error && error.message === "interactive-ui-runtime-failed") {
        return { type: "cancelled" };
      }
      throw error;
    } finally {
      progressBoundary.unmount();
    }
  }
}

/** Run switch review/pull/commit without re-resolving the reviewed target. */
export async function runInteractiveSwitch(
  options: { readonly model?: string | undefined },
  mode: InteractiveLifecycleSelection,
  deps: InteractiveSwitchDeps = defaultSwitchDeps,
): Promise<InteractiveLifecycleOutcome<SwitchResult>> {
  const renderer = await loadRenderer(mode, deps, options.model !== undefined);
  if (mode.mode === "tui" && renderer === undefined) {
    if (options.model === undefined) {
      deps.writeStderr(
        "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
      );
      return { type: "cancelled" };
    }
    const prepared = await deps.prepare({ model: options.model });
    const result = await deps.execute(prepared);
    deps.writeStdout(deps.format(result));
    return { type: "completed", result };
  }
  const model = options.model ?? (await chooseLifecycleModel("Choose a model to switch to", mode, deps));
  if (model === null) return { type: "cancelled" };
  for (;;) {
    const prepared = await deps.prepare({ model });
    if (prepared.type !== "already-active") {
      const decision = await reviewPrepared(switchReview(prepared), mode, renderer, deps);
      if (decision.type === "cancelled") return { type: "cancelled" };
    }
    const progress = mountProgressBeforeExecution(
      renderer,
      "switch",
      prepared.targetId,
      mode,
      deps,
    );
    const progressBoundary = createProgressFallback(progress, deps);
    try {
      const result = await progressBoundary.execute(() =>
        deps.execute(prepared, (event) =>
          progressBoundary.emit({
            type: event.status,
            phase: event.phase,
            label: event.label,
          }),
        ),
      );
      deps.writeStdout(deps.format(result));
      return { type: "completed", result };
    } catch (error) {
      if (error instanceof ConfirmationDriftError) {
        deps.writeStderr("Active server changed; returning to a fresh review.\n");
        continue;
      }
      if (error instanceof Error && error.message === "interactive-ui-runtime-failed") {
        return { type: "cancelled" };
      }
      throw error;
    } finally {
      progressBoundary.unmount();
    }
  }
}

/** Present the approved fail-closed migration status without touching any store. */
export async function runInteractiveMigrateUnavailable(
  mode: InteractiveLifecycleSelection,
): Promise<never> {
  const viewModel: LifecycleReviewViewModel = {
    screen: "migrate",
    title: "Migration is unavailable on this runtime",
    canonicalTargetIds: [],
    lines: [
      "No memory store was read or changed.",
      "Node.js cannot bind store traversal and mutation to trusted directory descriptors.",
      "Migration remains fail-closed until a reviewed secure filesystem helper is approved.",
    ],
    confirmLabel: "Acknowledge",
    destructive: false,
  };
  if (mode.mode === "tui") {
    const renderer = await import("./lifecycle-renderer.js");
    await renderer
      .mountLifecycleReview({
        viewModel,
        stdin: process.stdin,
        stderr: process.stderr,
        color: mode.color,
        unicode: mode.unicode,
      })
      .waitForDecision();
  } else {
    const reader = createBoundedCookedLineReader(process.stdin, 16);
    try {
      await runAccessibleLifecycleReview({
        viewModel,
        readLine: reader.readLine,
        write: (text) => process.stderr.write(text),
      });
    } finally {
      reader.close();
    }
  }
  throw new MemoryError(
    "migration is unavailable: this Node.js runtime cannot bind store reads and mutations to trusted directory descriptors",
  );
}
