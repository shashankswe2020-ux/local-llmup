import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ renderMock: vi.fn() }));

vi.mock("ink", () => ({
  render: hoisted.renderMock,
}));

import { mountLifecycleProgress } from "../../src/tui/lifecycle-renderer.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolveFn: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectFn: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (reason) => rejectFn?.(reason),
  };
}

describe("mountLifecycleProgress", () => {
  it("reports an unexpected fulfilled Ink exit before unmount", async () => {
    const exit = deferred<void>();
    hoisted.renderMock.mockReturnValueOnce({
      waitUntilExit: () => exit.promise,
      cleanup: () => undefined,
      unmount: () => undefined,
    });
    const session = mountLifecycleProgress({
      screen: "up",
      target: "qwen3:14b",
      stdin: process.stdin,
      stderr: process.stderr,
      color: false,
      unicode: false,
    });
    const handler = vi.fn();
    session.onFailure(handler);

    exit.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(expect.any(Error));
    session.unmount();
  });

  it("does not report the expected fulfilled exit after explicit unmount", async () => {
    const exit = deferred<void>();
    hoisted.renderMock.mockReturnValueOnce({
      waitUntilExit: () => exit.promise,
      cleanup: () => undefined,
      unmount: () => undefined,
    });
    const session = mountLifecycleProgress({
      screen: "up",
      target: "qwen3:14b",
      stdin: process.stdin,
      stderr: process.stderr,
      color: false,
      unicode: false,
    });
    const handler = vi.fn();
    session.onFailure(handler);

    session.unmount();
    exit.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });
});
