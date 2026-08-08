import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTuiSession,
  type TuiSession,
  type TuiSessionOptions,
  type TuiSignal,
} from "../../src/tui/session.js";

interface FakeInput {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(enabled: boolean): FakeInput;
  isPaused(): boolean;
  pause(): FakeInput;
  resume(): FakeInput;
  readonly rawModes: boolean[];
  readonly pauseCalls: string[];
}

interface FakeOutput extends EventEmitter {
  columns: number;
  rows: number;
  write(value: string): boolean;
  readonly writes: string[];
}

function fakeInput(paused = true): FakeInput {
  let isPaused = paused;
  const rawModes: boolean[] = [];
  const pauseCalls: string[] = [];
  return {
    isTTY: true,
    isRaw: false,
    rawModes,
    pauseCalls,
    setRawMode(enabled: boolean): FakeInput {
      rawModes.push(enabled);
      this.isRaw = enabled;
      return this;
    },
    isPaused: () => isPaused,
    pause(): FakeInput {
      isPaused = true;
      pauseCalls.push("pause");
      return this;
    },
    resume(): FakeInput {
      isPaused = false;
      pauseCalls.push("resume");
      return this;
    },
  };
}

function fakeOutput(): FakeOutput {
  const output = new EventEmitter() as FakeOutput;
  output.columns = 80;
  output.rows = 24;
  output.writes = [];
  output.write = (value: string): boolean => {
    output.writes.push(value);
    return true;
  };
  return output;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function harness(overrides: Partial<TuiSessionOptions> = {}): {
  readonly session: TuiSession;
  readonly stdin: FakeInput;
  readonly stdout: FakeOutput;
  readonly signals: EventEmitter;
} {
  const stdin = fakeInput();
  const stdout = fakeOutput();
  const signals = new EventEmitter();
  const session = createTuiSession({
    stdin,
    stdout,
    signalTarget: signals,
    ...overrides,
  });
  return { session, stdin, stdout, signals };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TuiSession restoration", () => {
  it("owns visual raw mode, cursor, stdin pause state, and listeners exactly once", async () => {
    const onRestore = vi.fn();
    const { session, stdin, stdout, signals } = harness({ onRestore });

    session.start();
    expect(stdin.rawModes).toEqual([true]);
    expect(stdin.pauseCalls).toEqual(["resume"]);
    expect(stdout.writes).toEqual(["\u001b[?25l"]);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(stdout.listenerCount("resize")).toBe(1);

    session.close();
    session.close();
    await session.waitUntilRestored();

    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.pauseCalls).toEqual(["resume", "pause"]);
    expect(stdout.writes).toEqual(["\u001b[?25l", "\u001b[?25h"]);
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(stdout.listenerCount("resize")).toBe(0);
  });

  it("accessible sessions never enable raw mode, hide the cursor, or resume stdin", () => {
    const { session, stdin, stdout } = harness({ mode: "accessible" });
    session.start();
    session.close();
    expect(stdin.rawModes).toEqual([]);
    expect(stdin.pauseCalls).toEqual([]);
    expect(stdout.writes).toEqual([]);
  });

  it("restores partially acquired resources when startup throws", async () => {
    const { session, stdin, stdout, signals } = harness();
    stdout.write = (value: string): boolean => {
      stdout.writes.push(value);
      if (value === "\u001b[?25l") throw new Error("write failed");
      return true;
    };

    expect(() => session.start()).toThrow("write failed");
    await session.waitUntilRestored();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdout.writes).toContain("\u001b[?25h");
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("restores raw mode when setRawMode mutates then throws", async () => {
    const { session, stdin } = harness();
    const original = stdin.setRawMode.bind(stdin);
    stdin.setRawMode = (enabled: boolean): FakeInput => {
      original(enabled);
      if (enabled) throw new Error("raw failed after mutation");
      return stdin;
    };
    expect(() => session.start()).toThrow("raw failed after mutation");
    await session.waitUntilRestored();
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });

  it("restores stdin pause state when resume mutates then throws", async () => {
    const { session, stdin } = harness();
    const originalResume = stdin.resume.bind(stdin);
    stdin.resume = (): FakeInput => {
      originalResume();
      throw new Error("resume failed after mutation");
    };
    expect(() => session.start()).toThrow("resume failed after mutation");
    await session.waitUntilRestored();
    expect(stdin.pauseCalls).toEqual(["resume", "pause"]);
    expect(stdin.isPaused()).toBe(true);
  });

  it("does not leak listeners across repeated sessions", () => {
    const stdin = fakeInput(false);
    const stdout = fakeOutput();
    const signals = new EventEmitter();
    for (let index = 0; index < 20; index += 1) {
      const session = createTuiSession({ stdin, stdout, signalTarget: signals });
      session.start();
      session.close();
    }
    expect(stdout.listenerCount("resize")).toBe(0);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(signals.listenerCount(signal)).toBe(0);
    }
  });

  it("continues restoration when listener removal throws", async () => {
    const { session, stdin, stdout, signals } = harness();
    const remove = stdout.removeListener.bind(stdout);
    let threw = false;
    stdout.removeListener = (event: string, listener: (...args: unknown[]) => void): FakeOutput => {
      if (!threw) {
        threw = true;
        throw new Error("remove failed");
      }
      return remove(event, listener) as FakeOutput;
    };
    session.start();
    session.close();
    await session.waitUntilRestored();
    expect(stdin.isRaw).toBe(false);
    expect(stdout.writes.at(-1)).toBe("\u001b[?25h");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(signals.listenerCount(signal)).toBe(0);
    }
  });

  it("cannot reacquire resources after close-before-start", async () => {
    const { session, stdin, stdout, signals } = harness();
    session.close();
    await session.waitUntilRestored();
    session.start();
    expect(stdin.rawModes).toEqual([]);
    expect(stdout.writes).toEqual([]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});

describe("TuiSession cancellation and resize", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "aborts once, waits for %s cleanup, then restores",
    async (signal) => {
      const cleanup = deferred();
      const onSignal = vi.fn((_signal: TuiSignal) => cleanup.promise);
      const { session, stdin, signals } = harness({ onSignal });
      session.start();

      signals.emit(signal);
      expect(session.signal.aborted).toBe(true);
      expect(onSignal).toHaveBeenCalledTimes(1);
      expect(stdin.isRaw).toBe(true);

      cleanup.resolve();
      await session.waitUntilRestored();
      expect(stdin.isRaw).toBe(false);
    },
  );

  it("debounces resize and restores below the visual minimum without cancelling domain work", async () => {
    vi.useFakeTimers();
    const onBelowMinimum = vi.fn();
    const { session, stdout } = harness({ onBelowMinimum });
    session.start();
    stdout.columns = 70;
    stdout.emit("resize");
    stdout.columns = 59;
    stdout.emit("resize");

    await vi.advanceTimersByTimeAsync(49);
    expect(onBelowMinimum).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onBelowMinimum).toHaveBeenCalledTimes(1);
    expect(session.signal.aborted).toBe(false);
    await session.waitUntilRestored();
    expect(stdout.listenerCount("resize")).toBe(0);
  });

  it("restores after a bounded cleanup timeout", async () => {
    vi.useFakeTimers();
    const cleanup = deferred();
    const { session, stdin, signals } = harness({
      cleanupTimeoutMs: 100,
      onSignal: () => cleanup.promise,
    });
    session.start();
    signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(99);
    expect(stdin.isRaw).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await session.waitUntilRestored();
    expect(stdin.isRaw).toBe(false);
  });

  it("does not let close bypass pending signal cleanup", async () => {
    const cleanup = deferred();
    const { session, stdin, signals } = harness({ onSignal: () => cleanup.promise });
    session.start();
    signals.emit("SIGINT");
    session.close();
    expect(stdin.isRaw).toBe(true);
    cleanup.resolve();
    await session.waitUntilRestored();
    expect(stdin.isRaw).toBe(false);
  });

  it("does not let resize fallback bypass pending signal cleanup", async () => {
    vi.useFakeTimers();
    const cleanup = deferred();
    const onBelowMinimum = vi.fn();
    const { session, stdin, stdout, signals } = harness({
      onSignal: () => cleanup.promise,
      onBelowMinimum,
    });
    session.start();
    signals.emit("SIGINT");
    stdout.columns = 59;
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(50);
    expect(onBelowMinimum).toHaveBeenCalledTimes(1);
    expect(stdin.isRaw).toBe(true);
    cleanup.resolve();
    await session.waitUntilRestored();
    expect(stdin.isRaw).toBe(false);
  });

  it("reports repeated signals without bypassing pending cleanup", async () => {
    const cleanup = deferred();
    const onSignal = vi.fn(() => cleanup.promise);
    const onRepeatedSignal = vi.fn();
    const { session, stdin, signals } = harness({
      cleanupTimeoutMs: 1_000,
      onSignal,
      onRepeatedSignal,
    });
    session.start();
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    expect(onRepeatedSignal).toHaveBeenCalledWith("SIGTERM");
    expect(stdin.isRaw).toBe(true);
    cleanup.resolve();
    await session.waitUntilRestored();
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(stdin.isRaw).toBe(false);
    expect(session.signal.aborted).toBe(true);
  });

  it("uses the accessible 40x10 resize minimum", async () => {
    vi.useFakeTimers();
    const onBelowMinimum = vi.fn();
    const { session, stdout } = harness({ mode: "accessible", onBelowMinimum });
    stdout.columns = 40;
    stdout.rows = 10;
    session.start();
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(50);
    expect(onBelowMinimum).not.toHaveBeenCalled();
    stdout.rows = 9;
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(50);
    expect(onBelowMinimum).toHaveBeenCalledTimes(1);
  });

  it("contains resize fallback callback errors and still restores", async () => {
    vi.useFakeTimers();
    const { session, stdin, stdout } = harness({
      onBelowMinimum: () => {
        throw new Error("fallback failed");
      },
    });
    session.start();
    stdout.columns = 59;
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(50);
    await session.waitUntilRestored();
    expect(stdin.isRaw).toBe(false);
  });
});
