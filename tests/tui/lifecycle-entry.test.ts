import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  DownExecutionObserver,
  DownPrepared,
  DownResult,
} from "../../src/commands/down.js";
import {
  runInteractiveDown,
  filterSwitchModelChoices,
  runInteractiveSwitch,
  runInteractiveUp,
  type InteractiveSwitchDeps,
  type InteractiveUpDeps,
} from "../../src/tui/lifecycle-entry.js";
import type { LifecycleReviewDecision } from "../../src/tui/lifecycle-types.js";
import type { UiModeSelection } from "../../src/tui/capabilities.js";

const mode: UiModeSelection & { readonly mode: "accessible" } = {
  mode: "accessible",
  explicit: true,
  color: false,
  unicode: false,
};

const autoTuiMode: UiModeSelection & { readonly mode: "tui" } = {
  mode: "tui",
  explicit: false,
  color: false,
  unicode: false,
};

const prepared: DownPrepared = {
  snapshot: {
    operation: "down",
    canonicalTargetIds: ["qwen3:14b"],
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    ownedByUs: true,
    processIdentityHash: "a".repeat(64),
    stateRevisionHash: "b".repeat(64),
    sourceStoreIdentityHash: null,
    targetStoreIdentityHash: null,
  },
  processIdentity: {
    expectedProcess: { pid: 1, executable: "/usr/bin/ollama", started: "start" },
    hash: "a".repeat(64),
  },
};

function streams(): { readonly stdin: NodeJS.ReadStream; readonly stderr: NodeJS.WriteStream } {
  return {
    stdin: new PassThrough() as NodeJS.ReadStream,
    stderr: new PassThrough() as NodeJS.WriteStream,
  };
}

function dependencies(decision: LifecycleReviewDecision) {
  const execute = vi.fn((_prepared: DownPrepared, observe?: DownExecutionObserver): Promise<DownResult> => {
    try {
      observe?.({
        phase: "locked-revalidate",
        status: "started",
        label: "Revalidate active server",
      });
    } catch {
      // Mirrors the real command's advisory observer boundary.
    }
    return Promise.resolve({
      type: "stopped",
      modelId: "qwen3:14b",
      endpoint: "http://127.0.0.1:11434",
    });
  });
  const writeStdout = vi.fn();
  return {
    execute,
    writeStdout,
    deps: {
      ...streams(),
      prepare: vi.fn(() => Promise.resolve(prepared)),
      execute,
      format: vi.fn(() => "Stopped qwen3:14b (http://127.0.0.1:11434).\n"),
      writeStdout,
      writeStderr: vi.fn(),
      runAccessibleReview: vi.fn(() => Promise.resolve(decision)),
      loadVisualRenderer: vi.fn(() => Promise.reject(new Error("unused"))),
    },
  };
}

describe("runInteractiveDown", () => {
  it("performs no mutation when the default confirmation is cancelled", async () => {
    const { deps, execute, writeStdout } = dependencies({ type: "cancelled" });

    const outcome = await runInteractiveDown({}, mode, false, deps);

    expect(outcome).toEqual({ type: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
    expect(writeStdout).not.toHaveBeenCalled();
  });

  it("executes the reviewed preparation exactly once and emits one plain result", async () => {
    const { deps, execute, writeStdout } = dependencies({ type: "accepted" });

    const outcome = await runInteractiveDown({}, mode, false, deps);

    expect(outcome.type).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(prepared, expect.any(Function));
    expect(writeStdout).toHaveBeenCalledOnce();
  });

  it("allows command-scoped --yes to bypass only the prompt", async () => {
    const { deps, execute } = dependencies({ type: "cancelled" });

    await runInteractiveDown({}, mode, true, deps);

    expect(deps.runAccessibleReview).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(prepared, expect.any(Function));
  });

  it("preserves committed stdout when progress emission and cleanup fail", async () => {
    const { deps, writeStdout } = dependencies({ type: "accepted" });
    const emit = vi.fn(() => {
      throw new Error("render failed");
    });
    const visualDeps = {
      ...deps,
      loadVisualRenderer: vi.fn(() =>
        Promise.resolve({
          mountLifecycleReview: () => ({
            unmount: () => undefined,
            waitForDecision: () => Promise.resolve({ type: "accepted" as const }),
          }),
          mountLifecycleProgress: () => ({
            emit,
            onFailure: () => undefined,
            unmount: () => {
              throw new Error("cleanup failed");
            },
          }),
        }),
      ),
    };

    const outcome = await runInteractiveDown(
      {},
      { ...autoTuiMode, explicit: true },
      false,
      visualDeps,
    );

    expect(outcome.type).toBe("completed");
    expect(emit).toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledOnce();
    expect(visualDeps.writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
    );
    expect(visualDeps.writeStderr).toHaveBeenCalledWith("Revalidate active server\n");
  });

  it("reports review failure before execution and performs no action", async () => {
    const { deps, execute } = dependencies({ type: "accepted" });
    const writeStderr = vi.fn();

    await expect(
      runInteractiveDown({}, mode, false, {
        ...deps,
        writeStderr,
        runAccessibleReview: () => Promise.reject(new Error("review failed")),
      }),
    ).rejects.toMatchObject({ name: "LifecycleUiHandledError" });

    expect(execute).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
  });
});

describe("lifecycle renderer failure and picker policy", () => {
  it("filters the active Ollama model and rejects picker targets for non-Ollama runtimes", () => {
    expect(
      filterSwitchModelChoices(["qwen3:14b", "llama3.1:8b"], {
        backend: "ollama",
        modelId: "qwen3:14b",
      }),
    ).toEqual(["llama3.1:8b"]);
    expect(
      filterSwitchModelChoices(["qwen3:14b", "llama3.1:8b"], {
        backend: "llamacpp",
        modelId: "qwen3:14b",
      }),
    ).toEqual([]);
  });

  it("fails before execution when auto TUI initialization fails without an explicit up model", async () => {
    const writes: string[] = [];
    const prepare = vi.fn(() => Promise.reject(new Error("unused")));
    const deps: InteractiveUpDeps = {
      ...streams(),
      prepare,
      execute: () => Promise.reject(new Error("unused")),
      format: () => "unused",
      listModels: () => ["qwen3:14b"],
      loadVisualRenderer: () => Promise.reject(new Error("renderer missing")),
      loadVisualPicker: () => Promise.reject(new Error("unused")),
      runAccessibleReview: () => Promise.resolve({ type: "cancelled" }),
      runAccessiblePicker: () => Promise.resolve(null),
      writeStdout: vi.fn(),
      writeStderr: (text) => writes.push(text),
    };

    await expect(runInteractiveUp({}, autoTuiMode, deps)).rejects.toThrow("renderer missing");
    expect(prepare).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("renderer_pre_execution");
    expect(writes.join("")).not.toContain("continuing in plain mode");
  });

  it("fails before execution when auto TUI initialization fails without a switch model", async () => {
    const writes: string[] = [];
    const prepare = vi.fn(() => Promise.reject(new Error("unused")));
    const deps: InteractiveSwitchDeps = {
      ...streams(),
      prepare,
      execute: () => Promise.reject(new Error("unused")),
      format: () => "unused",
      listModels: () => ["qwen3:14b"],
      loadVisualRenderer: () => Promise.reject(new Error("renderer missing")),
      loadVisualPicker: () => Promise.reject(new Error("unused")),
      runAccessibleReview: () => Promise.resolve({ type: "cancelled" }),
      runAccessiblePicker: () => Promise.resolve(null),
      writeStdout: vi.fn(),
      writeStderr: (text) => writes.push(text),
    };

    await expect(runInteractiveSwitch({}, autoTuiMode, deps)).rejects.toThrow(
      "renderer missing",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("renderer_pre_execution");
    expect(writes.join("")).not.toContain("continuing in plain mode");
  });

  it("cancels switch before preparation when no backend-eligible targets exist", async () => {
    const prepare = vi.fn(() => Promise.reject(new Error("unused")));
    const deps: InteractiveSwitchDeps = {
      ...streams(),
      prepare,
      execute: () => Promise.reject(new Error("unused")),
      format: () => "unused",
      listModels: () => [],
      loadVisualRenderer: () => Promise.reject(new Error("unused")),
      loadVisualPicker: () => Promise.reject(new Error("unused")),
      runAccessibleReview: () => Promise.resolve({ type: "cancelled" }),
      runAccessiblePicker: () => Promise.resolve(null),
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
    };

    const outcome = await runInteractiveSwitch({}, mode, deps);
    expect(outcome).toEqual({ type: "cancelled" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("performs no switch execution when progress mounting fails after acceptance", async () => {
    const execute = vi.fn(() => Promise.reject(new Error("must not execute")));
    const writeStderr = vi.fn();
    const deps: InteractiveSwitchDeps = {
      ...streams(),
      prepare: () =>
        Promise.resolve({
          type: "already-active",
          targetId: "qwen3:14b",
          endpoint: "http://127.0.0.1:11434",
          backend: "ollama",
        }),
      execute,
      format: () => "unused",
      listModels: () => ["qwen3:14b"],
      loadVisualRenderer: () =>
        Promise.resolve({
          mountLifecycleReview: () => ({
            unmount: () => undefined,
            waitForDecision: () => Promise.resolve({ type: "accepted" as const }),
          }),
          mountLifecycleProgress: () => {
            throw new Error("mount failed");
          },
        }),
      loadVisualPicker: () => Promise.reject(new Error("unused")),
      runAccessibleReview: () => Promise.resolve({ type: "accepted" }),
      runAccessiblePicker: () => Promise.resolve(null),
      writeStdout: vi.fn(),
      writeStderr,
    };

    await expect(
      runInteractiveSwitch({ model: "qwen3:14b" }, { ...autoTuiMode, explicit: true }, deps),
    ).rejects.toThrow("mount failed");
    expect(execute).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
  });

  it("performs no execution when the mounted Ink progress instance fails before start", async () => {
    const execute = vi.fn(() => Promise.reject(new Error("must not execute")));
    const writeStderr = vi.fn();
    const deps: InteractiveSwitchDeps = {
      ...streams(),
      prepare: () =>
        Promise.resolve({
          type: "already-active",
          targetId: "qwen3:14b",
          endpoint: "http://127.0.0.1:11434",
          backend: "ollama",
        }),
      execute,
      format: () => "unused",
      listModels: () => ["qwen3:14b"],
      loadVisualRenderer: () =>
        Promise.resolve({
          mountLifecycleReview: () => ({
            unmount: () => undefined,
            waitForDecision: () => Promise.resolve({ type: "accepted" as const }),
          }),
          mountLifecycleProgress: () => ({
            emit: () => undefined,
            onFailure: (handler: (error: Error) => void) => {
              queueMicrotask(() => handler(new Error("ink failed")));
            },
            unmount: () => undefined,
          }),
        }),
      loadVisualPicker: () => Promise.reject(new Error("unused")),
      runAccessibleReview: () => Promise.resolve({ type: "accepted" }),
      runAccessiblePicker: () => Promise.resolve(null),
      writeStdout: vi.fn(),
      writeStderr,
    };

    await expect(
      runInteractiveSwitch({ model: "qwen3:14b" }, { ...autoTuiMode, explicit: true }, deps),
    ).rejects.toMatchObject({ name: "LifecycleUiHandledError" });
    expect(execute).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
    );
  });
});
