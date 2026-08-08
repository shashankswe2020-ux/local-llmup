export type TuiSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export type TuiSessionMode = "visual" | "accessible";

interface TuiInput {
  readonly isTTY: boolean;
  isRaw: boolean;
  setRawMode(enabled: boolean): TuiInput;
  isPaused(): boolean;
  pause(): TuiInput;
  resume(): TuiInput;
}

interface TuiOutput {
  readonly columns: number;
  readonly rows: number;
  write(value: string): boolean;
  on(event: "resize", listener: () => void): unknown;
  removeListener(event: "resize", listener: () => void): unknown;
}

interface SignalTarget {
  on(event: TuiSignal, listener: () => void): unknown;
  removeListener(event: TuiSignal, listener: () => void): unknown;
}

export interface TuiSessionOptions {
  readonly stdin: TuiInput;
  readonly stdout: TuiOutput;
  readonly signalTarget: SignalTarget;
  readonly mode?: TuiSessionMode | undefined;
  readonly resizeDebounceMs?: number | undefined;
  readonly cleanupTimeoutMs?: number | undefined;
  readonly onSignal?: ((signal: TuiSignal) => void | Promise<void>) | undefined;
  readonly onRepeatedSignal?: ((signal: TuiSignal) => void) | undefined;
  readonly onBelowMinimum?: (() => void) | undefined;
  readonly onRestore?: (() => void) | undefined;
}

export interface TuiSession {
  readonly signal: AbortSignal;
  start(): void;
  close(): void;
  waitUntilRestored(): Promise<void>;
}

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const SIGNALS: readonly TuiSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function validDebounce(value: number | undefined): number {
  const debounce = value ?? 50;
  if (!Number.isSafeInteger(debounce) || debounce < 0 || debounce > 10_000) {
    throw new Error("resize debounce must be a nonnegative safe integer");
  }
  return debounce;
}

function validCleanupTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
    throw new Error("cleanup timeout must be a safe integer in 1..300000");
  }
  return timeout;
}

/** Own terminal presentation resources for one interactive command generation. */
export function createTuiSession(options: TuiSessionOptions): TuiSession {
  const mode = options.mode ?? "visual";
  const resizeDebounceMs = validDebounce(options.resizeDebounceMs);
  const cleanupTimeoutMs = validCleanupTimeout(options.cleanupTimeoutMs);
  const abortController = new AbortController();
  const initiallyPaused = options.stdin.isPaused();
  const initiallyRaw = options.stdin.isRaw;
  let started = false;
  let restored = false;
  let rawChanged = false;
  let stdinResumed = false;
  let cursorOwned = false;
  let signalStarted = false;
  let signalCleanupPending = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveRestored: (() => void) | undefined;
  const restoredPromise = new Promise<void>((resolve) => {
    resolveRestored = resolve;
  });
  const signalListeners = new Map<TuiSignal, () => void>();

  function handleResize(): void {
    if (restored) return;
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      if (restored) return;
      const minimumColumns = mode === "accessible" ? 40 : 60;
      const minimumRows = mode === "accessible" ? 10 : 16;
      if (options.stdout.columns >= minimumColumns && options.stdout.rows >= minimumRows) return;
      try {
        options.onBelowMinimum?.();
      } catch {
        // Presentation fallback errors cannot terminate active domain work.
      } finally {
        if (!signalCleanupPending) restore();
      }
    }, resizeDebounceMs);
  }

  const removeListeners = (): void => {
    try {
      options.stdout.removeListener("resize", handleResize);
    } catch {
      try {
        options.stdout.removeListener("resize", handleResize);
      } catch {
        // Continue removing independent signal listeners.
      }
    }
    for (const [signal, listener] of signalListeners) {
      try {
        options.signalTarget.removeListener(signal, listener);
      } catch {
        try {
          options.signalTarget.removeListener(signal, listener);
        } catch {
          // Continue removing the remaining listeners.
        }
      }
    }
    signalListeners.clear();
  };

  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
      }
      if (cleanupTimer !== undefined) {
        clearTimeout(cleanupTimer);
        cleanupTimer = undefined;
      }
      removeListeners();
      if (cursorOwned) {
        try {
          options.stdout.write(SHOW_CURSOR);
        } catch {
          // Continue restoring independent terminal resources.
        }
      }
      if (rawChanged) {
        try {
          options.stdin.setRawMode(initiallyRaw);
        } catch {
          // Continue restoring stdin pause state.
        }
      }
      if (stdinResumed && initiallyPaused) {
        try {
          options.stdin.pause();
        } catch {
          // Restoration remains best effort and idempotent.
        }
      }
      try {
        options.onRestore?.();
      } catch {
        // Observer failures cannot prevent terminal restoration completion.
      }
    } finally {
      resolveRestored?.();
    }
  };

  const beginSignal = (signal: TuiSignal): void => {
    if (restored) return;
    if (signalStarted) {
      try {
        options.onRepeatedSignal?.(signal);
      } catch {
        // Repeated-signal status observers cannot bypass cleanup.
      }
      return;
    }
    signalStarted = true;
    signalCleanupPending = true;
    abortController.abort(signal);
    cleanupTimer = setTimeout(() => {
      signalCleanupPending = false;
      restore();
    }, cleanupTimeoutMs);
    let cleanup: void | Promise<void>;
    try {
      cleanup = options.onSignal?.(signal);
    } catch {
      signalCleanupPending = false;
      restore();
      return;
    }
    void Promise.resolve(cleanup)
      .catch(() => undefined)
      .finally(() => {
        signalCleanupPending = false;
        restore();
      });
  };

  const attachListeners = (): void => {
    options.stdout.on("resize", handleResize);
    for (const signal of SIGNALS) {
      const listener = (): void => beginSignal(signal);
      signalListeners.set(signal, listener);
      options.signalTarget.on(signal, listener);
    }
  };

  return {
    signal: abortController.signal,
    start: (): void => {
      if (started || restored) return;
      started = true;
      try {
        if (mode === "visual") {
          if (!options.stdin.isTTY) throw new Error("visual TUI stdin must be a TTY");
          rawChanged = true;
          options.stdin.setRawMode(true);
          if (initiallyPaused) {
            stdinResumed = true;
            options.stdin.resume();
          }
          cursorOwned = true;
          options.stdout.write(HIDE_CURSOR);
        }
        attachListeners();
      } catch (error) {
        restore();
        throw error;
      }
    },
    close: (): void => {
      if (!signalCleanupPending) restore();
    },
    waitUntilRestored: async (): Promise<void> => {
      await restoredPromise;
    },
  };
}
