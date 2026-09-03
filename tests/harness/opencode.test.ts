import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import {
  createOpenCodeHarness,
  type OpenCodeSpawnFn,
  type OpenCodeSpawnedProcess,
} from "../../src/harness/opencode.js";

interface ProcessFixture {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly code?: number | null;
  readonly error?: Error;
  readonly close?: boolean;
}

function createProcess(fixture: ProcessFixture = {}): OpenCodeSpawnedProcess {
  let stdoutListener: ((chunk: string) => void) | undefined;
  let stderrListener: ((chunk: string) => void) | undefined;
  let closeListener: ((code: number | null) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let scheduled = false;

  const schedule = (): void => {
    if (scheduled || closeListener === undefined || errorListener === undefined) return;
    scheduled = true;
    queueMicrotask(() => {
      if (fixture.error !== undefined) {
        errorListener?.(fixture.error);
        return;
      }
      for (const chunk of fixture.stdout ?? []) stdoutListener?.(chunk);
      for (const chunk of fixture.stderr ?? []) stderrListener?.(chunk);
      if (fixture.close !== false) closeListener?.(fixture.code ?? 0);
    });
  };

  return {
    stdout: { onData: (listener) => { stdoutListener = listener; } },
    stderr: { onData: (listener) => { stderrListener = listener; } },
    onClose(listener): void {
      closeListener = listener;
      schedule();
    },
    onError(listener): void {
      errorListener = listener;
      schedule();
    },
    kill: vi.fn(),
  };
}

function textEvent(text: string): string {
  return JSON.stringify({
    type: "text",
    timestamp: 1,
    sessionID: "ses_test",
    part: { type: "text", text },
  });
}

describe("createOpenCodeHarness", () => {
  it("reports unavailable when the opencode binary is missing", async () => {
    const missing = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({ error: missing }));
    const harness = createOpenCodeHarness({ spawn });

    await expect(harness.isAvailable()).resolves.toBe(false);
    expect(harness.unavailableHint).toContain("opencode");
  });

  it("reports available after a successful version probe", async () => {
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({ stdout: ["1.2.3\n"] }));
    const harness = createOpenCodeHarness({ spawn });

    await expect(harness.isAvailable()).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "opencode",
      ["--version"],
      expect.objectContaining({ shell: false, stdio: "pipe" }),
    );
  });

  it("uses discrete safe arguments, a qualified model, and deny-all inline config", async () => {
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({ stdout: [`${textEvent("ok")}\n`] }));
    const harness = createOpenCodeHarness({ spawn, env: { PATH: "/test/bin" } });

    await expect(harness.chatSync({
      model: "ollama/qwen3:4b",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
    })).resolves.toBe("ok");

    const [command, args, options] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(command).toBe("opencode");
    expect(args).toEqual([
      "run",
      expect.stringContaining("[system]\nBe concise"),
      "--model",
      "ollama/qwen3:4b",
      "--agent",
      "local-llmup-chat",
      "--format",
      "json",
    ]);
    expect(args?.[1]).toContain("[assistant]\nanswer");
    expect(options).toMatchObject({ shell: false, stdio: "pipe" });
    expect(options?.env?.PATH).toBe("/test/bin");
    expect(JSON.parse(options?.env?.OPENCODE_CONFIG_CONTENT ?? "")).toMatchObject({
      autoupdate: false,
      permission: "deny",
      share: "disabled",
      snapshot: false,
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "qwen3:4b": { name: "qwen3:4b" } },
        },
      },
      agent: {
        "local-llmup-chat": {
          mode: "primary",
          permission: "deny",
        },
      },
    });
  });

  it("emits an allow-all config when unrestricted mode is enabled", async () => {
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({ stdout: [`${textEvent("ok")}\n`] }));
    const harness = createOpenCodeHarness({ spawn, unrestricted: true });

    await harness.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, , options] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(JSON.parse(options?.env?.OPENCODE_CONFIG_CONTENT ?? "")).toMatchObject({
      autoupdate: true,
      permission: "allow",
      share: "auto",
      snapshot: true,
      agent: {
        "local-llmup-chat": {
          mode: "primary",
          permission: "allow",
        },
      },
    });
  });

  it("streams text events and surfaces reasoning traces inline", async () => {
    const lines = [
      JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_test", part: { type: "step-start" } }),
      JSON.stringify({ type: "reasoning", timestamp: 2, sessionID: "ses_test", part: { type: "reasoning", text: "planning" } }),
      textEvent("hello"),
      JSON.stringify({ type: "step_finish", timestamp: 3, sessionID: "ses_test", part: { type: "step-finish", reason: "stop" } }),
      textEvent(" world"),
    ];
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({
      stdout: [`${lines[0]}\n${lines[1]}\n${lines[2]?.slice(0, 20)}`, `${lines[2]?.slice(20)}\n${lines[3]}\n${lines[4]}\n`],
    }));
    const harness = createOpenCodeHarness({ spawn });

    const chunks: string[] = [];
    for await (const chunk of harness.chat({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["\n\n> 💭 planning\n", "hello", " world"]);
  });

  it("surfaces tool_use activity as inline markdown", async () => {
    const toolEvent = JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      sessionID: "ses_test",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: {
          status: "completed",
          input: { filePath: "/tmp/x.txt", content: "HI" },
          output: "Wrote file successfully.",
          title: "tmp/x.txt",
        },
      },
    });
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({
      stdout: [`${toolEvent}\n${textEvent("done")}\n`],
    }));
    const harness = createOpenCodeHarness({ spawn });

    const combined = await harness.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(combined).toContain("🔧 `write` · tmp/x.txt");
    expect(combined).toContain("Wrote file successfully.");
    expect(combined).toContain("done");
  });

  it("treats a bare model name as a local Ollama model", async () => {
    const spawn: OpenCodeSpawnFn = vi.fn(() => createProcess({ stdout: [`${textEvent("ok")}\n`] }));
    const harness = createOpenCodeHarness({ spawn });

    await expect(harness.chatSync({
      model: "qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    })).resolves.toBe("ok");
    expect(spawn).toHaveBeenCalledWith(
      "opencode",
      ["run", "[user]\nhi", "--model", "ollama/qwen3:4b", "--agent", "local-llmup-chat", "--format", "json"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("rejects malformed JSON and OpenCode error events", async () => {
    const malformed = createOpenCodeHarness({
      spawn: vi.fn(() => createProcess({ stdout: ["not-json\n"] })),
    });
    await expect(malformed.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toBeInstanceOf(ValidationError);

    const failed = createOpenCodeHarness({
      spawn: vi.fn(() => createProcess({
        stdout: [`${JSON.stringify({ type: "error", timestamp: 1, sessionID: "ses_test", error: { name: "ProviderError", message: "denied" } })}\n`],
        code: 1,
      })),
    });
    await expect(failed.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow("ProviderError");
  });

  it("rejects nonzero exits with bounded sanitized stderr", async () => {
    const harness = createOpenCodeHarness({
      spawn: vi.fn(() => createProcess({ stderr: ["\u001b[31mprovider failed\u001b[0m"], code: 2 })),
    });

    await expect(harness.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof BackendError && error.message.includes("provider failed") && !error.message.includes("\u001b"),
    );
  });

  it("kills the child and rejects when the request is aborted", async () => {
    const child = createProcess({ close: false });
    const harness = createOpenCodeHarness({ spawn: vi.fn(() => child) });
    const controller = new AbortController();
    const pending = harness.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills the child when combined process output exceeds the cap", async () => {
    const child = createProcess({ stdout: ["x".repeat(65)], close: false });
    const harness = createOpenCodeHarness({ spawn: vi.fn(() => child), maxOutputBytes: 64 });

    await expect(harness.chatSync({
      model: "ollama/qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow("output limit");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});