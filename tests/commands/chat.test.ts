import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { ValidationError } from "../../src/errors.js";
import { runChat, type ChatDeps } from "../../src/commands/chat.js";
import { createRegistry } from "../../src/backend/registry.js";
import { createRegistry as createHarnessRegistry } from "../../src/harness/registry.js";
import type { BackendAdapter, ChatRequest, ChatResult } from "../../src/backend/adapter.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { STATE_SCHEMA_VERSION, type RuntimeState } from "../../src/state/state.js";
import type { LiveProcessIdentity } from "../../src/tui/snapshots.js";
import type { Catalog, CatalogModel, Quantization } from "../../src/types.js";
import {
  expectNoninteractiveGolden,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";

function quant(name: string, overrides: Partial<Quantization> = {}): Quantization {
  return {
    name,
    diskBytes: 5_000_000_000,
    minRamBytes: 6_000_000_000,
    minVramBytes: 6_000_000_000,
    ...overrides,
  };
}

function model(
  id: string,
  overrides: Partial<CatalogModel> = {},
  quants: readonly Quantization[] = [quant("Q4_K_M")],
): CatalogModel {
  return {
    id,
    family: id.split(":")[0] ?? id,
    params: "8B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 8192,
    capabilities: ["chat"],
    releaseDate: "2025-06-01",
    source: { ollama: id },
    quantizations: quants,
    ...overrides,
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

const CAT = catalog([model("llama3.1:8b"), model("qwen2.5:7b")]);

const baseAdapter: BackendAdapter = {
  name: "ollama",
  capabilities: {
    canPull: true,
    canEmbed: true,
    openAiCompatible: true,
    formats: ["ollama"],
    defaultPort: 11434,
  },
  isInstalled: () => Promise.resolve(true),
  installHint: () => "brew install ollama",
  pull: () => Promise.reject(new Error("unused")),
  serve: () => Promise.reject(new Error("unused")),
  waitUntilReady: () => Promise.resolve(),
  stop: () => Promise.reject(new Error("unused")),
  chat: () => Promise.reject(new Error("unused")),
  embed: () => Promise.reject(new Error("unused")),
};

function chatAdapter(replies: readonly string[]): {
  adapter: BackendAdapter;
  chat: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const chat = vi.fn((_request: ChatRequest): Promise<ChatResult> =>
    Promise.resolve({ content: index < replies.length ? (replies[index++] as string) : "" }),
  );
  return { adapter: { ...baseAdapter, chat }, chat };
}

function reader(turns: readonly string[]): () => Promise<string | null> {
  let index = 0;
  return () => Promise.resolve(index < turns.length ? (turns[index++] as string) : null);
}

function activeState(
  modelId: string,
  overrides: Partial<NonNullable<RuntimeState["active"]>> = {},
): RuntimeState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    active: {
      backend: "ollama",
      modelId,
      endpoint: "http://127.0.0.1:11434",
      pid: 9001,
      port: 11434,
      ownedByUs: true,
      ...overrides,
    },
  };
}

let home: string;
let config: Config;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-chat-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const now = (): Date => new Date("2026-01-01T00:00:00.000Z");

interface Harness {
  deps: ChatDeps;
  chat: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  openStore: ReturnType<typeof vi.fn>;
  store: MemoryStore;
}

function harness(options: {
  turns: readonly string[];
  replies: readonly string[];
  state?: RuntimeState;
  cat?: Catalog;
  canEmbed?: boolean;
  backendName?: "ollama" | "llamacpp" | "mlx" | "lmstudio";
  formats?: readonly ("ollama" | "gguf" | "mlx")[];
}): Harness {
  const { adapter: chatCapable, chat } = chatAdapter(options.replies);
  const withBackend: BackendAdapter = {
    ...chatCapable,
    name: options.backendName ?? "ollama",
    capabilities: {
      ...chatCapable.capabilities,
      formats: options.formats ?? ["ollama"],
    },
  };
  const adapter: BackendAdapter =
    options.canEmbed === false
      ? { ...withBackend, capabilities: { ...withBackend.capabilities, canEmbed: false } }
      : withBackend;
  const store: MemoryStore = {
    modelId: "llama3.1:8b",
    dir: join(config.memoryDir, "llama3.1-8b"),
    meta: { schemaVersion: 1, modelId: "llama3.1:8b", createdAt: "2026-01-01T00:00:00.000Z" },
  };
  const openStore = vi.fn((_config: Config, _modelId: string) => store);
  const capture = vi.fn(() =>
    Promise.resolve({ turnsAppended: 2, factsExtracted: 0, vectorsEmbedded: 0 }),
  );
  const deps: ChatDeps = {
    config,
    loadCatalog: () => options.cat ?? CAT,
    readState: () => options.state ?? activeState("llama3.1:8b"),
    registry: createRegistry([adapter]),
    openMemoryStore: openStore,
    captureExchange: capture,
    withLock: (_config: Config, fn: () => unknown) => Promise.resolve(fn()),
    readTurn: reader(options.turns),
    write: (text) => stdout.push(text),
    log: (text) => stderr.push(text),
    captureLiveProcessIdentity: (active): Promise<LiveProcessIdentity> =>
      Promise.resolve({
        expectedProcess: {
          pid: active.pid ?? 9001,
          executable: active.processExecutable ?? "/usr/bin/ollama",
          started: active.processStartedAt ?? "2026-08-08T00:00:00Z",
        },
        hash: "a".repeat(64),
      }),
    now,
  };
  return { deps, chat, capture, openStore, store };
}

describe("runChat", () => {
  it("captures a live process identity for legacy state before inference", async () => {
    const { deps, chat } = harness({ turns: ["hi"], replies: ["ok"] });

    await runChat({}, deps);

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProcess: {
          pid: 9001,
          executable: "/usr/bin/ollama",
          started: "2026-08-08T00:00:00Z",
        },
      }),
    );
  });

  it("forwards each user turn to the backend and writes the reply", async () => {
    const { deps, chat } = harness({
      turns: ["hi", "how are you"],
      replies: ["hello there", "doing well"],
    });

    await withGoldenEnvironment(() => runChat({}, deps));

    expect(chat).toHaveBeenCalledTimes(2);
    expectNoninteractiveGolden(plainGoldenName("chat"), stdout.join(""));
  });

  it("preserves piped EOF behavior without emitting a transcript", async () => {
    const { deps, chat, capture } = harness({ turns: [], replies: [] });

    await withGoldenEnvironment(() => runChat({}, deps));

    expect(stdout.join("")).toBe("");
    expectNoninteractiveGolden("chat-piped-eof-stderr.txt", stderr.join(""));
    expect(chat).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("invokes capture with the exact user/assistant payload", async () => {
    const { deps, capture, store } = harness({ turns: ["hi"], replies: ["hello there"] });

    await runChat({}, deps);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      config,
      store,
      { user: "hi", assistant: "hello there" },
      { now },
    );
  });

  it("captures vector-less with an embeddingUnsupported flag when the backend cannot embed", async () => {
    const { deps, capture } = harness({
      turns: ["hi"],
      replies: ["hello there"],
      canEmbed: false,
    });

    await runChat({}, deps);

    const options = capture.mock.calls[0]?.[3] as {
      embeddingUnsupported?: boolean;
      embedder?: unknown;
    };
    expect(options.embeddingUnsupported).toBe(true);
    expect(options.embedder).toBeUndefined();
  });

  it("accumulates in-session context across turns", async () => {
    const { deps, chat } = harness({
      turns: ["first", "second"],
      replies: ["reply-1", "reply-2"],
    });

    await runChat({}, deps);

    const secondCall = chat.mock.calls[1]?.[0] as ChatRequest;
    expect(secondCall.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "second" },
    ]);
  });

  it("strips control/ANSI from the streamed reply but captures it raw", async () => {
    const { deps, capture } = harness({
      turns: ["hi"],
      replies: ["\u001b[31mred\u001b[0m"],
    });

    await runChat({}, deps);

    expect(stdout.join("")).toContain("red");
    expect(stdout.join("")).not.toContain("\u001b");
    expect(capture.mock.calls[0]?.[2]).toEqual({ user: "hi", assistant: "\u001b[31mred\u001b[0m" });
  });

  it("resolves a fuzzy -m to the canonical model id for backend and store", async () => {
    const { deps, chat, openStore } = harness({ turns: ["hi"], replies: ["ok"] });

    await runChat({ model: "llama3.1" }, deps);

    expect((chat.mock.calls[0]?.[0] as ChatRequest).model).toBe("llama3.1:8b");
    expect(openStore).toHaveBeenCalledWith(config, "llama3.1:8b");
  });

  it("defaults to the active model when -m is omitted", async () => {
    const { deps, chat } = harness({
      turns: ["hi"],
      replies: ["ok"],
      state: activeState("qwen2.5:7b"),
    });

    await runChat({}, deps);

    expect((chat.mock.calls[0]?.[0] as ChatRequest).model).toBe("qwen2.5:7b");
  });

  it("routes through a non-local harness and stores memory under the harness-prefixed model key", async () => {
    const claudeHarness = {
      name: "claude",
      unavailableHint: "Set ANTHROPIC_API_KEY to use the Claude harness.",
      isAvailable: vi.fn(async () => true),
      chat: vi.fn(async function* () {
        yield "hello from claude";
      }),
      chatSync: vi.fn(async () => "hello from claude"),
    };
    const { deps, capture, openStore } = harness({
      turns: ["hi"],
      replies: ["ignored"],
      state: { schemaVersion: STATE_SCHEMA_VERSION, active: null },
    });

    await runChat({ model: "gpt-4o-mini", harness: "claude" }, {
      ...deps,
      harnessRegistry: createHarnessRegistry([claudeHarness]),
    });

    expect(claudeHarness.chatSync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(openStore).toHaveBeenCalledWith(config, "claude:gpt-4o-mini");
    expect(capture).toHaveBeenCalledWith(config, expect.any(Object), {
      user: "hi",
      assistant: "hello from claude",
    }, { now });
  });

  it("passes the active custom endpoint to the adapter", async () => {
    const { deps, chat } = harness({
      turns: ["hi"],
      replies: ["ok"],
      state: activeState("llama3.1:8b", {
        endpoint: "http://127.0.0.1:12000",
        port: 12000,
      }),
    });

    await runChat({}, deps);

    expect((chat.mock.calls[0]?.[0] as ChatRequest).endpoint).toBe("http://127.0.0.1:12000");
  });

  it("chats with a llama.cpp model using its catalog id and active endpoint", async () => {
    const gguf = model("qwen3:14b", {
      source: {
        gguf: {
          repo: "Qwen/Qwen3-14B-GGUF",
          revision: "a".repeat(40),
          file: "Qwen3-14B-Q4_K_M.gguf",
          sha256: "b".repeat(64),
        },
      },
    });
    const { deps, chat } = harness({
      turns: ["hi"],
      replies: ["ok"],
      cat: catalog([gguf]),
      backendName: "llamacpp",
      formats: ["gguf"],
      canEmbed: false,
      state: activeState("qwen3:14b", {
        backend: "llamacpp",
        endpoint: "http://127.0.0.1:18080",
        port: 18080,
      }),
    });

    await runChat({}, deps);

    expect(chat.mock.calls[0]?.[0]).toMatchObject({
      endpoint: "http://127.0.0.1:18080",
      model: "qwen3:14b",
    });
  });

  it("rejects a different model before transmitting to a single-model MLX server", async () => {
    const { deps, chat } = harness({
      turns: ["hi"],
      replies: ["must not send"],
      backendName: "mlx",
      formats: ["mlx"],
      canEmbed: false,
      state: activeState("llama3.1:8b", {
        backend: "mlx",
        endpoint: "http://127.0.0.1:18082",
        port: 18082,
      }),
    });

    await expect(runChat({ model: "qwen2.5:7b" }, deps)).rejects.toThrow(ValidationError);
    expect(chat).not.toHaveBeenCalled();
  });

  it("forwards the persisted MLX token and process identity to chat", async () => {
    const mlxCatalog = catalog([
      model("smollm2:360m", {
        source: {
          mlx: {
            repo: "mlx-community/SmolLM2-360M-Instruct-6bit",
            revision: "a".repeat(40),
            files: [
              { file: "config.json", sha256: "b".repeat(64), bytes: 1 },
              { file: "tokenizer_config.json", sha256: "c".repeat(64), bytes: 1 },
              { file: "model.safetensors", sha256: "d".repeat(64), bytes: 4_999_999_998 },
            ],
          },
        },
      }),
    ]);
    const state = activeState("smollm2:360m", {
      backend: "mlx",
      endpoint: "http://127.0.0.1:18082",
      port: 18082,
      processExecutable: "/usr/bin/python3",
      processStartedAt: "2026-08-08T00:00:00Z",
      modelPath: "Qwen/model.gguf",
      authToken: "a".repeat(64),
    });
    const { deps, chat } = harness({
      turns: ["hi"],
      replies: ["ok"],
      state,
      cat: mlxCatalog,
      backendName: "mlx",
      formats: ["mlx"],
    });

    await runChat({}, deps);

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: "a".repeat(64),
        expectedProcess: {
          pid: 9001,
          executable: "/usr/bin/python3",
          started: "2026-08-08T00:00:00Z",
        },
        expectedModelPath: "Qwen/model.gguf",
      }),
    );
  });

  it("routes chat through an attached LM Studio server", async () => {
    const state = activeState("llama3.1:8b", {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      port: 1234,
      ownedByUs: false,
      pid: 7001,
      processExecutable: "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
      processStartedAt: "2026-08-08T00:00:00Z",
    });
    const { deps, chat } = harness({
      turns: ["hi"],
      replies: ["hello"],
      state,
      backendName: "lmstudio",
      formats: ["gguf"],
    });

    await runChat({}, deps);

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "http://127.0.0.1:1234",
        model: "llama3.1:8b",
        expectedProcess: {
          pid: 7001,
          executable: "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
          started: "2026-08-08T00:00:00Z",
        },
      }),
    );
  });

  it("throws when there is no active server", async () => {
    const { deps } = harness({
      turns: ["hi"],
      replies: ["ok"],
      state: { schemaVersion: STATE_SCHEMA_VERSION, active: null },
    });

    await expect(runChat({}, deps)).rejects.toThrow(ValidationError);
  });

  it("skips blank turns without calling the backend or capture", async () => {
    const { deps, chat, capture } = harness({
      turns: ["   ", "hi"],
      replies: ["ok"],
    });

    await runChat({}, deps);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects a model that has no ollama source", async () => {
    const noSource = catalog([model("custom:1b", { source: {} })]);
    const { deps } = harness({
      turns: ["hi"],
      replies: ["ok"],
      state: activeState("custom:1b"),
      cat: noSource,
    });

    await expect(runChat({}, deps)).rejects.toThrow(ValidationError);
  });

  it("continues the session when recording an exchange fails", async () => {
    const { deps, chat, capture, store } = harness({
      turns: ["first", "second"],
      replies: ["reply-1", "reply-2"],
    });
    capture
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ turnsAppended: 2, factsExtracted: 0, vectorsEmbedded: 0 });

    await runChat({}, deps);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(stdout.join("")).toContain("reply-2");
    expect(stderr.join("")).toContain("failed to record memory");
    expect(store.modelId).toBe("llama3.1:8b");
  });

  it("bounds the transcript sent to the backend", async () => {
    const turns = Array.from({ length: 15 }, (_, i) => `turn-${i}`);
    const replies = Array.from({ length: 15 }, (_, i) => `reply-${i}`);
    const { deps, chat } = harness({ turns, replies });

    await runChat({}, deps);

    const lastCall = chat.mock.calls[14]?.[0] as ChatRequest;
    expect(lastCall.messages.length).toBeLessThanOrEqual(20);
  });
});
