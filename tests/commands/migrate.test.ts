import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { MemoryError, ValidationError } from "../../src/errors.js";
import { memorySlug } from "../../src/memory/store.js";
import {
  loadSourceMemory,
  planMigration,
  writeMigration,
  type MigrationEmbedder,
} from "../../src/memory/migrate.js";
import { withLock } from "../../src/state/state.js";
import { runMigrate, type MigrateDeps } from "../../src/commands/migrate.js";
import { createRegistry } from "../../src/backend/registry.js";
import type { BackendAdapter, ChatRequest, ChatResult } from "../../src/backend/adapter.js";
import type { Catalog, CatalogModel } from "../../src/types.js";
import { STATE_SCHEMA_VERSION, type RuntimeState } from "../../src/state/state.js";
import {
  expectNoninteractiveGolden,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";

function model(id: string, contextLength = 8192): CatalogModel {
  return {
    id,
    family: id.split(":")[0]!,
    params: "8B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength,
    capabilities: ["chat"],
    releaseDate: "2025-06-01",
    source: { ollama: id },
    quantizations: [
      { name: "Q4_K_M", diskBytes: 5_000_000_000, minRamBytes: 6e9, minVramBytes: 6e9 },
    ],
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

function emptyState(): RuntimeState {
  return { schemaVersion: STATE_SCHEMA_VERSION, active: null };
}

interface SeedOptions {
  readonly turns?: ReadonlyArray<{ role: string; content: string; ts: string }>;
  readonly factsText?: string;
  readonly systemPrompt?: string;
  readonly embedding?: {
    readonly meta: { model: string; dimension: number };
    readonly chunks: ReadonlyArray<{ id: string; text: string; ts: string }>;
    readonly vectors: ReadonlyArray<{ id: string; vector: readonly number[] }>;
  };
}

function seedSourceStore(config: Config, modelId: string, opts: SeedOptions): string {
  const dir = join(config.memoryDir, memorySlug(modelId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      modelId,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...(opts.embedding !== undefined ? { embedding: opts.embedding.meta } : {}),
    }),
  );
  const turns = opts.turns ?? [{ role: "user", content: "hi", ts: "t" }];
  writeFileSync(
    join(dir, "conversation.jsonl"),
    turns.map((t) => `${JSON.stringify(t)}\n`).join(""),
  );
  if (opts.factsText !== undefined) writeFileSync(join(dir, "facts.json"), opts.factsText);
  if (opts.systemPrompt !== undefined) writeFileSync(join(dir, "system.md"), opts.systemPrompt);
  if (opts.embedding !== undefined) {
    const emb = join(dir, "embeddings");
    mkdirSync(emb, { recursive: true });
    writeFileSync(
      join(emb, "chunks.jsonl"),
      opts.embedding.chunks.map((c) => `${JSON.stringify(c)}\n`).join(""),
    );
    writeFileSync(
      join(emb, "vectors.jsonl"),
      opts.embedding.vectors.map((v) => `${JSON.stringify(v)}\n`).join(""),
    );
  }
  return dir;
}

function fakeAdapter(chat?: (req: ChatRequest) => Promise<ChatResult>): BackendAdapter {
  return {
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
    chat: chat ?? (() => Promise.reject(new Error("unused"))),
    embed: () => Promise.reject(new Error("unused")),
  };
}

let home: string;
let config: Config;
let stdout: string[];
let stderr: string[];

function makeDeps(cat: Catalog, overrides: Partial<MigrateDeps> = {}): MigrateDeps {
  return {
    config,
    loadCatalog: () => cat,
    readState: () => emptyState(),
    registry: createRegistry([fakeAdapter()]),
    loadSourceMemory,
    planMigration,
    writeMigration,
    withLock,
    write: (t) => stdout.push(t),
    log: (t) => stderr.push(t),
    now: () => new Date("2026-02-02T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-migrate-cmd-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  mkdirSync(config.memoryDir, { recursive: true });
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("runMigrate", () => {
  it("carries source memory into the target store and prints a summary", async () => {
    const cat = catalog([model("llama3.1:8b"), model("qwen2.5:14b")]);
    seedSourceStore(config, "llama3.1:8b", {
      turns: [
        { role: "user", content: "hi", ts: "t" },
        { role: "assistant", content: "hello", ts: "t" },
      ],
      factsText: `{"schemaVersion":1,"facts":[{"text":"name = Ada","ts":"t"}]}`,
    });

    await withGoldenEnvironment(() =>
      runMigrate({ from: "llama3.1:8b", to: "qwen2.5:14b" }, makeDeps(cat)),
    );

    const targetDir = join(config.memoryDir, memorySlug("qwen2.5:14b"));
    expect(existsSync(join(targetDir, "conversation.jsonl"))).toBe(true);
    // facts carried byte-identically
    expect(readFileSync(join(targetDir, "facts.json"), "utf8")).toBe(
      `{"schemaVersion":1,"facts":[{"text":"name = Ada","ts":"t"}]}`,
    );
    // source left intact (no --move)
    expect(existsSync(join(config.memoryDir, memorySlug("llama3.1:8b")))).toBe(true);
    const summary = stdout.join("");
    expectNoninteractiveGolden(plainGoldenName("migrate"), summary);
  });

  it("copies the embedding index as-is when no target embedder is wired (reuse)", async () => {
    const cat = catalog([model("a"), model("b")]);
    seedSourceStore(config, "a", {
      turns: [{ role: "user", content: "hi", ts: "t" }],
      embedding: {
        meta: { model: "nomic-embed-text", dimension: 2 },
        chunks: [{ id: "c1", text: "hi", ts: "t" }],
        vectors: [{ id: "c1", vector: [0.1, 0.2] }],
      },
    });

    await runMigrate({ from: "a", to: "b" }, makeDeps(cat));

    const targetDir = join(config.memoryDir, memorySlug("b"));
    expect(existsSync(join(targetDir, "embeddings", "vectors.jsonl"))).toBe(true);
    expect(stdout.join("")).toContain("reuse");
  });

  it("captures vector-less and flags meta.json when the target backend cannot embed", async () => {
    const cat = catalog([model("a"), model("b")]);
    seedSourceStore(config, "a", {
      turns: [{ role: "user", content: "hi", ts: "t" }],
      embedding: {
        meta: { model: "nomic-embed-text", dimension: 2 },
        chunks: [{ id: "c1", text: "hi", ts: "t" }],
        vectors: [{ id: "c1", vector: [0.1, 0.2] }],
      },
    });
    const capable = fakeAdapter();
    const noEmbed: BackendAdapter = {
      ...capable,
      capabilities: { ...capable.capabilities, canEmbed: false },
    };
    const deps = makeDeps(cat, {
      registry: createRegistry([noEmbed]),
      readState: () => ({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          backend: "ollama",
          modelId: "b",
          endpoint: "http://127.0.0.1:11434",
          pid: 1,
          port: 11434,
          ownedByUs: true,
        },
      }),
    });

    await runMigrate({ from: "a", to: "b" }, deps);

    const targetDir = join(config.memoryDir, memorySlug("b"));
    expect(existsSync(join(targetDir, "embeddings", "vectors.jsonl"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(targetDir, "meta.json"), "utf8")) as {
      embedding?: unknown;
      embeddingUnsupported?: unknown;
    };
    expect(meta.embedding).toBeUndefined();
    expect(meta.embeddingUnsupported).toBe(true);
  });

  it("re-embeds when a target embedder in a different space is supplied", async () => {
    const cat = catalog([model("a"), model("b")]);
    seedSourceStore(config, "a", {
      turns: [{ role: "user", content: "hi", ts: "t" }],
      embedding: {
        meta: { model: "nomic-embed-text", dimension: 2 },
        chunks: [{ id: "c1", text: "hi", ts: "t" }],
        vectors: [{ id: "c1", vector: [0.1, 0.2] }],
      },
    });
    const embedder: MigrationEmbedder = {
      model: "mxbai-embed-large",
      dimension: 3,
      embed: (inputs) => Promise.resolve({ vectors: inputs.map(() => [1, 2, 3]), dimension: 3 }),
    };

    await runMigrate({ from: "a", to: "b" }, makeDeps(cat, { embedder }));

    expect(stdout.join("")).toContain("re-embedded");
    expect(stdout.join("")).toContain("reembed");
  });

  it("summarizes overflow using the target model when it is the active server", async () => {
    const cat = catalog([model("a"), model("small", 40)]);
    const bigTurns = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i} `.padEnd(400, "x"),
      ts: "t",
    }));
    seedSourceStore(config, "a", { turns: bigTurns });

    const chat = vi.fn((): Promise<ChatResult> =>
      Promise.resolve({ content: "prior chat covered setup and greetings" }),
    );
    const mlxAdapter: BackendAdapter = {
      ...fakeAdapter(chat),
      name: "mlx",
      capabilities: {
        ...fakeAdapter(chat).capabilities,
        canEmbed: false,
        formats: ["mlx"],
        defaultPort: 8080,
      },
    };
    const deps = makeDeps(cat, {
      registry: createRegistry([mlxAdapter]),
      readState: () => ({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          backend: "mlx",
          modelId: "small",
          endpoint: "http://127.0.0.1:12000",
          pid: 1,
          port: 12000,
          ownedByUs: true,
          processExecutable: "/usr/bin/python3",
          processStartedAt: "2026-08-08T00:00:00Z",
          authToken: "a".repeat(64),
        },
      }),
    });

    await runMigrate({ from: "a", to: "small" }, deps);

    expect(chat).toHaveBeenCalled();
    expect(chat.mock.calls[0]?.[0]).toMatchObject({
      endpoint: "http://127.0.0.1:12000",
      model: "small",
      authToken: "a".repeat(64),
      expectedProcess: {
        pid: 1,
        executable: "/usr/bin/python3",
        started: "2026-08-08T00:00:00Z",
      },
    });
    expect(stdout.join("")).toContain("summarize");
  });

  it("deletes the source after a successful --move", async () => {
    const cat = catalog([model("a"), model("b")]);
    seedSourceStore(config, "a", { turns: [{ role: "user", content: "hi", ts: "t" }] });

    await runMigrate({ from: "a", to: "b", move: true }, makeDeps(cat));

    expect(existsSync(join(config.memoryDir, memorySlug("a")))).toBe(false);
    expect(existsSync(join(config.memoryDir, memorySlug("b")))).toBe(true);
  });

  it("--dry-run performs zero filesystem writes but prints the plan", async () => {
    const cat = catalog([model("a"), model("b")]);
    seedSourceStore(config, "a", { turns: [{ role: "user", content: "hi", ts: "t" }] });
    const writeSpy = vi.fn();

    await runMigrate(
      { from: "a", to: "b", dryRun: true },
      makeDeps(cat, { writeMigration: writeSpy }),
    );

    expect(writeSpy).not.toHaveBeenCalled();
    // No target store was created, and no lock file was written.
    expect(existsSync(join(config.memoryDir, memorySlug("b")))).toBe(false);
    expect(existsSync(config.lockFile)).toBe(false);
    const out = stdout.join("");
    expect(out).toContain("dry-run");
    expect(out).toContain("carried");
  });

  it("rejects migrating a model onto itself", async () => {
    const cat = catalog([model("a")]);
    seedSourceStore(config, "a", {});
    await expect(runMigrate({ from: "a", to: "a" }, makeDeps(cat))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects when two distinct ids resolve to the same store directory", async () => {
    // "a:b" and "a-b" both slug to "a-b" (":" collapses to "-").
    const cat = catalog([model("a:b"), model("a-b")]);
    seedSourceStore(config, "a:b", {});
    await expect(
      runMigrate({ from: "a:b", to: "a-b", move: true }, makeDeps(cat)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("propagates an unknown model as a resolution error", async () => {
    const cat = catalog([model("a")]);
    await expect(
      runMigrate({ from: "a", to: "does-not-exist" }, makeDeps(cat)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails when the source model has no memory store", async () => {
    const cat = catalog([model("a"), model("b")]);
    await expect(runMigrate({ from: "a", to: "b" }, makeDeps(cat))).rejects.toBeInstanceOf(
      MemoryError,
    );
  });
});

describe("loadSourceMemory", () => {
  it("reads turns, facts bytes, system prompt, and the embedding index", () => {
    seedSourceStore(config, "a", {
      turns: [{ role: "user", content: "hi", ts: "t" }],
      factsText: `{"schemaVersion":1,"facts":[]}`,
      systemPrompt: "You are helpful.",
      embedding: {
        meta: { model: "nomic-embed-text", dimension: 2 },
        chunks: [{ id: "c1", text: "hi", ts: "t" }],
        vectors: [{ id: "c1", vector: [0.1, 0.2] }],
      },
    });

    const source = loadSourceMemory(config, "a");
    expect(source.turns).toHaveLength(1);
    expect(source.systemPrompt).toBe("You are helpful.");
    expect(source.factsText).toBe(`{"schemaVersion":1,"facts":[]}`);
    expect(source.embedding?.meta).toEqual({ model: "nomic-embed-text", dimension: 2 });
    expect(source.embedding?.vectors).toHaveLength(1);
  });

  it("returns empty facts and no embedding when those files are absent", () => {
    seedSourceStore(config, "a", { turns: [{ role: "user", content: "hi", ts: "t" }] });
    const source = loadSourceMemory(config, "a");
    expect(source.factsText).toBe("");
    expect(source.systemPrompt).toBeUndefined();
    expect(source.embedding).toBeUndefined();
  });
});
