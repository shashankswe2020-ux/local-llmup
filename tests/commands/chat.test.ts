import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { ValidationError } from "../../src/errors.js";
import { runChat, type ChatDeps } from "../../src/commands/chat.js";
import { createRegistry } from "../../src/backend/registry.js";
import type { BackendAdapter, ChatRequest, ChatResult } from "../../src/backend/adapter.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { STATE_SCHEMA_VERSION, type RuntimeState } from "../../src/state/state.js";
import type { Catalog, CatalogModel, Quantization } from "../../src/types.js";

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
  const chat = vi.fn(
    (_request: ChatRequest): Promise<ChatResult> =>
      Promise.resolve({ content: index < replies.length ? (replies[index++] as string) : "" }),
  );
  return { adapter: { ...baseAdapter, chat }, chat };
}

function reader(turns: readonly string[]): () => Promise<string | null> {
  let index = 0;
  return () => Promise.resolve(index < turns.length ? (turns[index++] as string) : null);
}

function activeState(modelId: string): RuntimeState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    active: {
      backend: "ollama",
      modelId,
      endpoint: "http://127.0.0.1:11434",
      pid: 9001,
      port: 11434,
      ownedByUs: true,
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
}): Harness {
  const { adapter: chatCapable, chat } = chatAdapter(options.replies);
  const adapter: BackendAdapter =
    options.canEmbed === false
      ? { ...chatCapable, capabilities: { ...chatCapable.capabilities, canEmbed: false } }
      : chatCapable;
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
    now,
  };
  return { deps, chat, capture, openStore, store };
}

describe("runChat", () => {
  it("forwards each user turn to the backend and writes the reply", async () => {
    const { deps, chat } = harness({
      turns: ["hi", "how are you"],
      replies: ["hello there", "doing well"],
    });

    await runChat({}, deps);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(stdout.join("")).toContain("hello there");
    expect(stdout.join("")).toContain("doing well");
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
