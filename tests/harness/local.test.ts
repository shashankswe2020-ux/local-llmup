import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { createLocalHarness } from "../../src/harness/local.js";
import { createDefaultRegistry as createDefaultBackendRegistry } from "../../src/backend/registry.js";

function makeRuntimeState(active: object | null) {
  return {
    schemaVersion: 2,
    active,
  } as const;
}

describe("createLocalHarness", () => {
  it("reports unavailable when no local server is active", async () => {
    const harness = createLocalHarness({
      config: { stateFile: "/tmp/local-llmup-state.json" } as never,
      readState: () => makeRuntimeState(null),
      registry: createDefaultBackendRegistry(),
      select: vi.fn(),
    });

    await expect(harness.isAvailable()).resolves.toBe(false);
    expect(harness.unavailableHint).toContain("no active server");
  });

  it("routes a chat request through the active backend adapter", async () => {
    const adapter = {
      name: "ollama",
      capabilities: {
        canPull: true,
        canEmbed: true,
        openAiCompatible: true,
        formats: ["ollama"],
        defaultPort: 11434,
      },
      isInstalled: async () => true,
      installHint: () => "install ollama",
      chat: vi.fn(async ({ model, messages }) => ({
        content: `replied:${model}:${messages[0]?.content ?? ""}`,
      })),
      pull: vi.fn(),
      serve: vi.fn(),
      waitUntilReady: vi.fn(),
      stop: vi.fn(),
      embed: vi.fn(),
    };

    const harness = createLocalHarness({
      config: { stateFile: "/tmp/local-llmup-state.json" } as never,
      readState: () =>
        makeRuntimeState({
          backend: "ollama",
          modelId: "llama3.2",
          endpoint: "http://127.0.0.1:11434",
          port: 11434,
          pid: 2112,
          ownedByUs: true,
          processExecutable: "/usr/local/bin/ollama",
          processStartedAt: "2026-01-01T00:00:00.000Z",
        }),
      registry: createDefaultBackendRegistry(),
      select: vi.fn(async () => ({ adapter })),
    });

    await expect(
      harness.chatSync({
        model: "llama3.2",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).resolves.toBe("replied:llama3.2:hello");

    expect(adapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "http://127.0.0.1:11434",
        model: "llama3.2",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
  });

  it("yields a single chunk for non-streaming backends", async () => {
    const adapter = {
      name: "ollama",
      capabilities: {
        canPull: true,
        canEmbed: true,
        openAiCompatible: true,
        formats: ["ollama"],
        defaultPort: 11434,
      },
      isInstalled: async () => true,
      installHint: () => "install ollama",
      chat: vi.fn(async () => ({ content: "streamed" })),
      pull: vi.fn(),
      serve: vi.fn(),
      waitUntilReady: vi.fn(),
      stop: vi.fn(),
      embed: vi.fn(),
    };

    const harness = createLocalHarness({
      config: { stateFile: "/tmp/local-llmup-state.json" } as never,
      readState: () =>
        makeRuntimeState({
          backend: "ollama",
          modelId: "llama3.2",
          endpoint: "http://127.0.0.1:11434",
          port: 11434,
          pid: 2112,
          ownedByUs: true,
          processExecutable: "/usr/local/bin/ollama",
          processStartedAt: "2026-01-01T00:00:00.000Z",
        }),
      registry: createDefaultBackendRegistry(),
      select: vi.fn(async () => ({ adapter })),
    });

    const chunks: string[] = [];
    for await (const chunk of harness.chat({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["streamed"]);
  });

  it("throws ValidationError when no active server is present during chatSync", async () => {
    const harness = createLocalHarness({
      config: { stateFile: "/tmp/local-llmup-state.json" } as never,
      readState: () => makeRuntimeState(null),
      registry: createDefaultBackendRegistry(),
      select: vi.fn(),
    });

    await expect(
      harness.chatSync({ model: "llama3.2", messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
