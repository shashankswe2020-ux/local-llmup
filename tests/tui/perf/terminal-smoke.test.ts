/**
 * Terminal hygiene smoke tests for U3b.
 *
 * Prove that:
 * 1. No stuck raw mode — stdin is restored after TUI session teardown.
 * 2. No hidden cursor — SHOW_CURSOR escape is emitted on exit.
 * 3. No orphan process — child processes (backend) are cleaned up via AbortSignal.
 *
 * These tests use injected streams (no real terminals) to verify the
 * invariants programmatically.
 */
import { describe, expect, it, vi } from "vitest";
import type { TuiSessionOptions, TuiSignal } from "../../../src/tui/session.js";
import { createTuiSession } from "../../../src/tui/session.js";

const SHOW_CURSOR = "\u001b[?25h";
const HIDE_CURSOR = "\u001b[?25l";

interface MockStdin {
  isTTY: boolean;
  isRaw: boolean;
  readonly rawModes: boolean[];
  setRawMode(enabled: boolean): MockStdin;
  isPaused(): boolean;
  pause(): MockStdin;
  resume(): MockStdin;
}

function createMockStdin(): MockStdin {
  const rawModes: boolean[] = [];
  let paused = true;
  const stdin: MockStdin = {
    isTTY: true,
    isRaw: false,
    rawModes,
    setRawMode(enabled: boolean): MockStdin {
      rawModes.push(enabled);
      stdin.isRaw = enabled;
      return stdin;
    },
    isPaused(): boolean {
      return paused;
    },
    pause(): MockStdin {
      paused = true;
      return stdin;
    },
    resume(): MockStdin {
      paused = false;
      return stdin;
    },
  };
  return stdin;
}

interface MockStdout {
  readonly columns: number;
  readonly rows: number;
  readonly chunks: string[];
  write(value: string): boolean;
  on(event: "resize", listener: () => void): void;
  removeListener(event: "resize", listener: () => void): void;
}

function createMockStdout(): MockStdout {
  const chunks: string[] = [];
  return {
    columns: 120,
    rows: 40,
    chunks,
    write(value: string): boolean {
      chunks.push(value);
      return true;
    },
    on(): void {
      // no-op
    },
    removeListener(): void {
      // no-op
    },
  };
}

interface MockSignalTarget {
  readonly listeners: Map<TuiSignal, (() => void)[]>;
  on(event: TuiSignal, listener: () => void): void;
  removeListener(event: TuiSignal, listener: () => void): void;
}

function createMockSignalTarget(): MockSignalTarget {
  const listeners = new Map<TuiSignal, (() => void)[]>();
  return {
    listeners,
    on(event: TuiSignal, listener: () => void): void {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    removeListener(_event: TuiSignal, _listener: () => void): void {
      // no-op for test
    },
  };
}

function sessionOptions(
  overrides: Partial<TuiSessionOptions> & { stdin?: MockStdin; stdout?: MockStdout } = {},
): TuiSessionOptions & { stdin: MockStdin; stdout: MockStdout; signalTarget: MockSignalTarget } {
  const stdin = overrides.stdin ?? createMockStdin();
  const stdout = overrides.stdout ?? createMockStdout();
  const signalTarget = createMockSignalTarget();
  return {
    ...overrides,
    stdin,
    stdout,
    signalTarget,
    mode: overrides.mode ?? "visual",
  };
}

describe("Terminal hygiene: no stuck raw mode", () => {
  it("restores raw mode to false after visual session start+close", async () => {
    const opts = sessionOptions({ mode: "visual" });
    const session = createTuiSession(opts);

    session.start();
    expect(opts.stdin.isRaw).toBe(true);
    session.close();
    await session.waitUntilRestored();
    expect(opts.stdin.isRaw).toBe(false);
    expect(opts.stdin.rawModes[opts.stdin.rawModes.length - 1]).toBe(false);
  });

  it("restores raw mode after signal-triggered cleanup", async () => {
    const opts = sessionOptions({ mode: "visual" });
    const session = createTuiSession(opts);

    session.start();
    expect(opts.stdin.isRaw).toBe(true);

    // Simulate SIGINT
    const sigintListeners = opts.signalTarget.listeners.get("SIGINT") ?? [];
    for (const listener of sigintListeners) listener();

    await session.waitUntilRestored();
    expect(opts.stdin.isRaw).toBe(false);
  });

  it("accessible mode never enters raw mode", async () => {
    const opts = sessionOptions({ mode: "accessible" });
    const session = createTuiSession(opts);

    session.start();
    expect(opts.stdin.rawModes.filter((v) => v === true).length).toBe(0);
    session.close();
    await session.waitUntilRestored();
    expect(opts.stdin.isRaw).toBe(false);
  });
});

describe("Terminal hygiene: no hidden cursor", () => {
  it("emits SHOW_CURSOR on close after visual mode hides cursor", async () => {
    const opts = sessionOptions({ mode: "visual" });
    const session = createTuiSession(opts);

    session.start();
    session.close();
    await session.waitUntilRestored();

    const output = opts.stdout.chunks.join("");
    // If cursor was hidden, SHOW_CURSOR must follow
    if (output.includes(HIDE_CURSOR)) {
      expect(output).toContain(SHOW_CURSOR);
      const hideIdx = output.lastIndexOf(HIDE_CURSOR);
      const showIdx = output.lastIndexOf(SHOW_CURSOR);
      expect(showIdx).toBeGreaterThan(hideIdx);
    }
  });

  it("accessible mode never writes cursor control sequences", async () => {
    const opts = sessionOptions({ mode: "accessible" });
    const session = createTuiSession(opts);

    session.start();
    session.close();
    await session.waitUntilRestored();

    const output = opts.stdout.chunks.join("");
    expect(output).not.toContain(HIDE_CURSOR);
    expect(output).not.toContain(SHOW_CURSOR);
  });
});

describe("Terminal hygiene: no orphan process", () => {
  it("cooperative close restores terminal without abort (backends finish normally)", async () => {
    const opts = sessionOptions({ mode: "visual" });
    const session = createTuiSession(opts);

    const abortHandler = vi.fn();
    session.signal.addEventListener("abort", abortHandler);

    session.start();
    session.close();
    await session.waitUntilRestored();

    // Cooperative close does NOT abort — backends are expected to complete normally
    expect(abortHandler).not.toHaveBeenCalled();
    // But terminal IS still restored
    expect(opts.stdin.isRaw).toBe(false);
  });

  it("abort signal fires on signal-triggered teardown so backends can cleanup", async () => {
    const opts = sessionOptions({ mode: "visual" });
    const session = createTuiSession(opts);

    const abortHandler = vi.fn();
    session.signal.addEventListener("abort", abortHandler);

    session.start();

    const sigintListeners = opts.signalTarget.listeners.get("SIGINT") ?? [];
    for (const listener of sigintListeners) listener();

    await session.waitUntilRestored();
    expect(abortHandler).toHaveBeenCalledTimes(1);
  });
});
