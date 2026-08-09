import { render, type Instance } from "ink";
import {
  LifecycleProgressScreen,
  LifecycleReviewScreen,
  type LifecycleStyle,
} from "./screens/lifecycle.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type {
  LifecycleProgressItem,
  LifecycleReviewDecision,
  LifecycleReviewViewModel,
  LifecycleScreen,
} from "./lifecycle-types.js";

const MAX_PROGRESS_EVENTS = 100;

interface RendererStreams {
  readonly stderr: NodeJS.WriteStream;
}

interface ReviewRendererOptions extends RendererStreams {
  readonly viewModel: LifecycleReviewViewModel;
  readonly stdin: NodeJS.ReadStream;
  readonly color: boolean;
  readonly unicode: boolean;
}

interface ProgressRendererOptions extends RendererStreams {
  readonly screen: LifecycleScreen;
  readonly target: string;
  readonly stdin: NodeJS.ReadStream;
  readonly color: boolean;
  readonly unicode: boolean;
}

export interface LifecycleReviewSession {
  unmount(): void;
  waitForDecision(): Promise<LifecycleReviewDecision>;
}

export interface LifecycleProgressSession {
  emit(item: LifecycleProgressItem): void;
  onFailure(handler: (error: Error) => void): void;
  unmount(): void;
}

function style(options: RendererStreams & { readonly color: boolean; readonly unicode: boolean }): LifecycleStyle {
  return {
    color: options.color,
    unicode: options.unicode,
    columns: Math.max(40, options.stderr.columns ?? 80),
  };
}

function safelyUnmount(instance: Instance): void {
  instance.unmount();
  instance.cleanup();
}

/** Mount a confirmation screen whose initial and Enter-default action is Cancel. */
export function mountLifecycleReview(options: ReviewRendererOptions): LifecycleReviewSession {
  let settled = false;
  let resolveDecision: ((decision: LifecycleReviewDecision) => void) | undefined;
  let rejectDecision: ((error: Error) => void) | undefined;
  const decision = new Promise<LifecycleReviewDecision>((resolve, reject) => {
    resolveDecision = resolve;
    rejectDecision = reject;
  });
  const decide = (value: LifecycleReviewDecision): void => {
    if (settled) return;
    settled = true;
    resolveDecision?.(value);
  };
  const viewModel: LifecycleReviewViewModel = Object.freeze({
    ...options.viewModel,
    title: sanitizeTerminalText(options.viewModel.title, "single_line"),
    canonicalTargetIds: Object.freeze([...options.viewModel.canonicalTargetIds]),
    lines: Object.freeze(
      options.viewModel.lines.map((line) => sanitizeTerminalText(line, "single_line")),
    ),
    confirmLabel: sanitizeTerminalText(options.viewModel.confirmLabel, "single_line"),
  });
  const instance = render(
    <LifecycleReviewScreen viewModel={viewModel} style={style(options)} onDecision={decide} />,
    {
      stdin: options.stdin,
      stdout: options.stderr,
      stderr: options.stderr,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  instance.waitUntilExit().then(
    () => {
      if (settled) return;
      settled = true;
      rejectDecision?.(new Error("interactive review exited unexpectedly"));
    },
    (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectDecision?.(error instanceof Error ? error : new Error(String(error)));
    },
  );
  let unmounted = false;
  return {
    unmount: (): void => {
      if (unmounted) return;
      unmounted = true;
      decide({ type: "cancelled" });
      safelyUnmount(instance);
    },
    waitForDecision: async (): Promise<LifecycleReviewDecision> => {
      try {
        return await decision;
      } finally {
        if (!unmounted) {
          unmounted = true;
          safelyUnmount(instance);
        }
      }
    },
  };
}

/** Mount a bounded lifecycle timeline and accept validated immutable updates. */
export function mountLifecycleProgress(options: ProgressRendererOptions): LifecycleProgressSession {
  const events: LifecycleProgressItem[] = [];
  const listeners = new Set<(items: readonly LifecycleProgressItem[]) => void>();
  const subscribe = (
    listener: (items: readonly LifecycleProgressItem[]) => void,
  ): (() => void) => {
    listeners.add(listener);
    listener(Object.freeze([...events]));
    return () => {
      listeners.delete(listener);
    };
  };
  const screenStyle = style(options);
  const target = sanitizeTerminalText(options.target, "action_identifier");
  const app = (
    <LifecycleProgressScreen
      screen={options.screen}
      target={target}
      subscribe={subscribe}
      style={screenStyle}
    />
  );
  const instance = render(app, {
    stdout: options.stderr,
    stderr: options.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  let failureHandler: ((error: Error) => void) | undefined;
  let expectedShutdown = false;
  instance.waitUntilExit().then(
    () => {
      if (!expectedShutdown) {
        failureHandler?.(new Error("interactive progress exited unexpectedly"));
      }
    },
    (error: unknown) => {
      if (!expectedShutdown) {
        failureHandler?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
  let unmounted = false;
  return {
    emit: (item): void => {
      if (unmounted) return;
      const next: LifecycleProgressItem = Object.freeze({
        type: item.type,
        phase: sanitizeTerminalText(item.phase, "single_line"),
        label: sanitizeTerminalText(item.label, "single_line"),
      });
      events.push(next);
      if (events.length > MAX_PROGRESS_EVENTS) events.shift();
      const snapshot = Object.freeze([...events]);
      for (const listener of listeners) listener(snapshot);
    },
    onFailure: (handler): void => {
      failureHandler = handler;
    },
    unmount: (): void => {
      if (unmounted) return;
      unmounted = true;
      expectedShutdown = true;
      listeners.clear();
      safelyUnmount(instance);
    },
  };
}
