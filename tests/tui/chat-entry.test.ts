import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { ValidationError } from "../../src/errors.js";
import {
  runInteractiveChat,
  type InteractiveChatDeps,
  type InteractiveChatSelection,
} from "../../src/tui/chat-entry.js";
import { DRAFT_MAX_BYTES, DRAFT_MAX_GRAPHEMES, DRAFT_MAX_LINES } from "../../src/tui/chat-limits.js";
import { createRegistry } from "../../src/backend/registry.js";
import type { BackendAdapter, ChatRequest, ChatResult } from "../../src/backend/adapter.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { STATE_SCHEMA_VERSION, type RuntimeState } from "../../src/state/state.js";
import type { LiveProcessIdentity } from "../../src/tui/snapshots.js";
import type { Catalog, CatalogModel, Quantization } from "../../src/types.js";

function quant(name: string): Quantization {
  return {
    name,
    diskBytes: 5_000_000_000,
    minRamBytes: 6_000_000_000,
    minVramBytes: 6_000_000_000,
  };
}

function model(id: string): CatalogModel {
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
    quantizations: [quant("Q4_K_M")],
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

const CAT = catalog([model("llama3.1:8b"), model("qwen2.5:7b")]);

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

function chatAdapter(replies: readonly string[]): {
  adapter: BackendAdapter;
  chat: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const chat = vi.fn((_request: ChatRequest): Promise<ChatResult> =>
    Promise.resolve({ content: index < replies.length ? (replies[index++] as string) : "" }),
  );
  const adapter: BackendAdapter = {
    name: "ollama",
    capabilities: {
      canPull: true,
      canEmbed: true,
      embeddingOffload: "unknown",
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
    chat,
    embed: () => Promise.reject(new Error("unused")),
  };
  return { adapter, chat };
}

function reader(turns: readonly string[]): () => Promise<string | null> {
  let index = 0;
  return () => Promise.resolve(index < turns.length ? (turns[index++] as string) : null);
}

const tuiMode: InteractiveChatSelection = {
  mode: "tui",
  color: true,
  unicode: true,
  explicit: false,
};

let home: string;
let config: Config;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-chat-tui-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function harness(options: {
  turns: readonly string[];
  replies: readonly string[];
  state?: RuntimeState;
}): InteractiveChatDeps {
  const { adapter, chat: _chat } = chatAdapter(options.replies);
  const store: MemoryStore = {
    modelId: "llama3.1:8b",
    dir: join(config.memoryDir, "llama3.1-8b"),
    meta: { schemaVersion: 1, modelId: "llama3.1:8b", createdAt: "2026-01-01T00:00:00.000Z" },
  };
  return {
    config,
    loadCatalog: () => CAT,
    readState: () => options.state ?? activeState("llama3.1:8b"),
    registry: createRegistry([adapter]),
    openMemoryStore: () => store,
    captureExchange: vi.fn(() =>
      Promise.resolve({ turnsAppended: 2, factsExtracted: 0, vectorsEmbedded: 0 }),
    ),
    withLock: (_config: Config, fn: () => unknown) => Promise.resolve(fn()),
    captureLiveProcessIdentity: (): Promise<LiveProcessIdentity> =>
      Promise.resolve({
        expectedProcess: { pid: 9001, executable: "/usr/bin/ollama", started: 1000 },
        hash: "abc123",
      }),
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    readTurn: reader(options.turns),
  };
}

describe("runInteractiveChat", () => {
  it("throws when no active server", async () => {
    const deps = harness({ turns: ["hi"], replies: ["hello"] });
    deps.readState = () => ({ schemaVersion: STATE_SCHEMA_VERSION, active: null });
    await expect(runInteractiveChat({}, tuiMode, deps)).rejects.toThrow(ValidationError);
  });

  it("emits session-end summary to stdout (not transcript)", async () => {
    const deps = harness({ turns: ["hello", "bye"], replies: ["hi there", "goodbye"] });
    const result = await runInteractiveChat({}, tuiMode, deps);
    expect(result.turns).toBe(2);
    expect(result.memoryWarnings).toBe(0);
    // Stdout gets only the summary
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toBe("Chat session ended: 2 turns, 0 memory warnings.\n");
    // Stderr gets the assistant replies
    expect(stderr.join("")).toContain("hi there");
    expect(stderr.join("")).toContain("goodbye");
  });

  it("does not emit assistant replies to stdout (auto TUI contract)", async () => {
    const deps = harness({ turns: ["hi"], replies: ["assistant reply"] });
    await runInteractiveChat({}, tuiMode, deps);
    // The assistant reply must NOT appear in stdout
    expect(stdout.join("")).not.toContain("assistant reply");
    // It must appear in stderr (TUI stream)
    expect(stderr.join("")).toContain("assistant reply");
  });

  it("shows pending state without fake streaming", async () => {
    const deps = harness({ turns: ["hi"], replies: ["response"] });
    await runInteractiveChat({}, tuiMode, deps);
    expect(stderr.join("")).toContain("Waiting for response");
  });

  it("validates draft limits and rejects oversized input", async () => {
    const oversizedDraft = "a".repeat(DRAFT_MAX_GRAPHEMES + 1);
    const deps = harness({ turns: [oversizedDraft], replies: [] });
    const result = await runInteractiveChat({}, tuiMode, deps);
    // Draft was rejected, no backend call made, no turns counted
    expect(result.turns).toBe(0);
    expect(stderr.join("")).toContain("grapheme limit");
  });

  it("rejects drafts exceeding byte limit", async () => {
    // Multi-byte characters that exceed 32KiB
    const oversized = "😀".repeat(Math.ceil(DRAFT_MAX_BYTES / 4) + 1);
    const deps = harness({ turns: [oversized], replies: [] });
    const result = await runInteractiveChat({}, tuiMode, deps);
    expect(result.turns).toBe(0);
    expect(stderr.join("")).toContain("byte limit");
  });

  it("rejects drafts exceeding line limit", async () => {
    const oversized = Array.from({ length: DRAFT_MAX_LINES + 1 }, () => "x").join("\n");
    const deps = harness({ turns: [oversized], replies: [] });
    const result = await runInteractiveChat({}, tuiMode, deps);
    expect(result.turns).toBe(0);
    expect(stderr.join("")).toContain("line limit");
  });

  it("warns on response exceeding 1 MiB but continues session", async () => {
    const bigReply = "x".repeat(1_048_577);
    const deps = harness({ turns: ["hi", "again"], replies: [bigReply, "ok"] });
    const result = await runInteractiveChat({}, tuiMode, deps);
    expect(result.turns).toBe(2);
    expect(result.memoryWarnings).toBe(1);
    expect(stderr.join("")).toContain("exceeds 1 MiB");
  });

  it("counts memory capture failures as warnings", async () => {
    const deps = harness({ turns: ["hi"], replies: ["hello"] });
    deps.captureExchange = vi.fn(() => Promise.reject(new Error("store full")));
    const result = await runInteractiveChat({}, tuiMode, deps);
    expect(result.turns).toBe(1);
    expect(result.memoryWarnings).toBe(1);
    expect(stderr.join("")).toContain("failed to record memory");
  });

  it("skips empty turns", async () => {
    const deps = harness({ turns: ["", "  ", "hello"], replies: ["hi"] });
    const result = await runInteractiveChat({}, tuiMode, deps);
    expect(result.turns).toBe(1);
  });

  it("works with accessible mode (same summary contract)", async () => {
    const accessibleMode: InteractiveChatSelection = {
      mode: "accessible",
      color: false,
      unicode: false,
      explicit: false,
    };
    const deps = harness({ turns: ["hi"], replies: ["hello"] });
    const result = await runInteractiveChat({}, accessibleMode, deps);
    expect(result.turns).toBe(1);
    expect(stdout[0]).toBe("Chat session ended: 1 turn, 0 memory warnings.\n");
  });

  it("resolves custom model option", async () => {
    const deps = harness({ turns: ["hi"], replies: ["hey"] });
    const result = await runInteractiveChat({ model: "qwen2.5:7b" }, tuiMode, deps);
    expect(result.turns).toBe(1);
  });
});
