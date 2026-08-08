import { describe, expect, it, vi } from "vitest";
import { runReadOnlyPresentation } from "../../src/tui/read-only-command.js";
import { recommendViewModel } from "../fixtures/tui-view-models.js";

function streams(): { readonly stdin: NodeJS.ReadStream; readonly stderr: NodeJS.WriteStream } {
  return {
    stdin: {} as NodeJS.ReadStream,
    stderr: { columns: 100, rows: 24 } as NodeJS.WriteStream,
  };
}

describe("read-only command presentation", () => {
  it("loads visual renderer before domain work, collects once, and writes final plain output after unmount", async () => {
    const order: string[] = [];
    const collect = vi.fn(async () => {
      order.push("collect");
      return { id: "result" };
    });
    const writeStdout = vi.fn((text: string) => order.push(`stdout:${text}`));
    const mount = vi.fn(() => ({
      unmount: vi.fn(),
      waitUntilExit: async () => {
        order.push("exit");
      },
    }));
    const loadVisualRenderer = vi.fn(async () => {
      order.push("load");
      return { mountReadOnlyScreen: mount };
    });

    const outcome = await runReadOnlyPresentation(
      {
        screen: "recommend",
        mode: { mode: "tui", explicit: true, reason: null, color: false, unicode: false },
        collect,
        buildViewModel: recommendViewModel,
        formatPlain: (result) => `plain:${result.id}\n`,
      },
      {
        ...streams(),
        loadVisualRenderer,
        runAccessible: vi.fn(),
        writeStdout,
        writeStderr: vi.fn(),
      },
    );

    expect(outcome).toEqual({ type: "completed", result: { id: "result" } });
    expect(order).toEqual(["load", "collect", "exit", "stdout:plain:result\n"]);
    expect(collect).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "recommend", viewModel: recommendViewModel() }),
    );
  });

  it("p exits through the authoritative plain result instead of trusting display text", async () => {
    let print: ((command: string) => void) | undefined;
    const writeStdout = vi.fn();
    await runReadOnlyPresentation(
      {
        screen: "recommend",
        mode: { mode: "tui", explicit: true, reason: null, color: false, unicode: false },
        collect: async () => ({ id: "result" }),
        buildViewModel: recommendViewModel,
        formatPlain: () => "plain\n",
      },
      {
        ...streams(),
        loadVisualRenderer: async () => ({
          mountReadOnlyScreen: (options) => {
            print = options.onPrintCommand;
            return {
              unmount: vi.fn(),
              waitUntilExit: async () => print?.("truncated-or-forged-display"),
            };
          },
        }),
        runAccessible: vi.fn(),
        writeStdout,
        writeStderr: vi.fn(),
      },
    );
    expect(writeStdout).toHaveBeenCalledOnce();
    expect(writeStdout).toHaveBeenCalledWith("plain\n");
  });

  it("does not execute domain work when an explicit visual renderer cannot load", async () => {
    const collect = vi.fn(async () => ({ id: "result" }));
    await expect(
      runReadOnlyPresentation(
        {
          screen: "recommend",
          mode: { mode: "tui", explicit: true, reason: null, color: false, unicode: false },
          collect,
          buildViewModel: recommendViewModel,
          formatPlain: () => "plain\n",
        },
        {
          ...streams(),
          loadVisualRenderer: async () => Promise.reject(new Error("renderer unavailable")),
          runAccessible: vi.fn(),
          writeStdout: vi.fn(),
          writeStderr: vi.fn(),
        },
      ),
    ).rejects.toThrow("renderer unavailable");
    expect(collect).not.toHaveBeenCalled();
  });

  it("falls back to one plain result when mounting fails after collection", async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const result = await runReadOnlyPresentation(
      {
        screen: "recommend",
        mode: { mode: "tui", explicit: false, reason: null, color: false, unicode: false },
        collect: async () => ({ id: "result" }),
        buildViewModel: recommendViewModel,
        formatPlain: () => "plain\n",
      },
      {
        ...streams(),
        loadVisualRenderer: async () => ({
          mountReadOnlyScreen: () => {
            throw new Error("mount failed\n\u001b[31m");
          },
        }),
        runAccessible: vi.fn(),
        writeStdout,
        writeStderr,
      },
    );
    expect(result.type).toBe("completed");
    expect(writeStdout).toHaveBeenCalledWith("plain\n");
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
    );
  });

  it("preserves a successful result when an explicit final renderer fails after collection", async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    await expect(
      runReadOnlyPresentation(
        {
          screen: "recommend",
          mode: { mode: "tui", explicit: true, reason: null, color: false, unicode: false },
          collect: async () => ({ id: "result" }),
          buildViewModel: recommendViewModel,
          formatPlain: () => "plain\n",
        },
        {
          ...streams(),
          loadVisualRenderer: async () => ({
            mountReadOnlyScreen: () => {
              throw new Error("mount failed");
            },
          }),
          runAccessible: vi.fn(),
          writeStdout,
          writeStderr,
        },
      ),
    ).resolves.toEqual({ type: "completed", result: { id: "result" } });
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
    );
    expect(writeStdout).toHaveBeenCalledWith("plain\n");
  });

  it("uses a stable renderer_init notice for implicit import fallback", async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    await runReadOnlyPresentation(
      {
        screen: "recommend",
        mode: { mode: "tui", explicit: false, reason: null, color: false, unicode: false },
        collect: async () => ({ id: "result" }),
        buildViewModel: recommendViewModel,
        formatPlain: () => "plain\n",
      },
      {
        ...streams(),
        loadVisualRenderer: async () => Promise.reject(new Error("missing")),
        runAccessible: vi.fn(),
        writeStdout,
        writeStderr,
      },
    );
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI unavailable (renderer_init); continuing in plain mode\n",
    );
    expect(writeStdout).toHaveBeenCalledWith("plain\n");
  });

  it("uses accessible rendering without importing Ink and preserves print-command outcome", async () => {
    const loadVisualRenderer = vi.fn();
    const writeStdout = vi.fn();
    const runAccessible = vi.fn(async () => ({
      type: "print-command" as const,
      command: "local-llmup up qwen3:14b",
    }));
    await runReadOnlyPresentation(
      {
        screen: "recommend",
        mode: {
          mode: "accessible",
          explicit: true,
          reason: null,
          color: false,
          unicode: false,
        },
        collect: async () => ({ id: "result" }),
        buildViewModel: recommendViewModel,
        formatPlain: () => "plain\n",
      },
      {
        ...streams(),
        loadVisualRenderer,
        runAccessible,
        writeStdout,
        writeStderr: vi.fn(),
      },
    );
    expect(loadVisualRenderer).not.toHaveBeenCalled();
    expect(runAccessible).toHaveBeenCalledOnce();
    expect(writeStdout).toHaveBeenCalledWith("plain\n");
  });

  it("preserves the result when accessible rendering fails after collection", async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    await expect(
      runReadOnlyPresentation(
        {
          screen: "recommend",
          mode: {
            mode: "accessible",
            explicit: true,
            reason: null,
            color: false,
            unicode: false,
          },
          collect: async () => ({ id: "result" }),
          buildViewModel: recommendViewModel,
          formatPlain: () => "plain\n",
        },
        {
          ...streams(),
          loadVisualRenderer: vi.fn(),
          runAccessible: async () => Promise.reject(new Error("accessible failed")),
          writeStdout,
          writeStderr,
        },
      ),
    ).resolves.toEqual({ type: "completed", result: { id: "result" } });
    expect(writeStderr).toHaveBeenCalledWith(
      "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
    );
    expect(writeStdout).toHaveBeenCalledWith("plain\n");
  });
});
