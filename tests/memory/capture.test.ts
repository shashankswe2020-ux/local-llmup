import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { MemoryError } from "../../src/errors.js";
import { openMemoryStore, type MemoryStore } from "../../src/memory/store.js";
import { captureExchange, extractFacts, type CaptureEmbedder } from "../../src/memory/capture.js";

let home: string;
let config: Config;
let store: MemoryStore;

/** Deterministic clock for stable timestamps in assertions. */
const now = (): Date => new Date("2026-01-01T00:00:00.000Z");

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

interface StubEmbedder extends CaptureEmbedder {
  readonly embed: ReturnType<typeof vi.fn>;
}

function makeEmbedder(model = "nomic-embed-text", dimension = 3): StubEmbedder {
  const embed = vi.fn(async (inputs: readonly string[]) => ({
    vectors: inputs.map((_, i) => Array.from({ length: dimension }, (_, d) => i + d)),
    dimension,
  }));
  return { model, embed };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-capture-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  store = openMemoryStore(config, "llama3.1:8b");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("extractFacts", () => {
  it("extracts a name from a self-introduction", () => {
    expect(extractFacts("My name is Ada Lovelace.")).toEqual(["name = Ada Lovelace"]);
  });

  it("extracts multiple durable facts from one message", () => {
    expect(extractFacts("My name is Ada. I live in London. I prefer dark mode.")).toEqual([
      "name = Ada",
      "location = London",
      "preference = dark mode",
    ]);
  });

  it("captures an explicit remember instruction verbatim", () => {
    expect(extractFacts("Please remember that my API key rotates on Mondays")).toEqual([
      "my API key rotates on Mondays",
    ]);
  });

  it("returns no facts for ordinary chit-chat", () => {
    expect(extractFacts("What is the capital of France?")).toEqual([]);
  });
});

describe("captureExchange", () => {
  it("appends a user and assistant turn to conversation.jsonl", async () => {
    const result = await captureExchange(
      config,
      store,
      { user: "Hi there", assistant: "Hello!" },
      { now },
    );

    expect(result.turnsAppended).toBe(2);
    const turns = readJsonl(join(store.dir, "conversation.jsonl"));
    expect(turns).toEqual([
      { role: "user", content: "Hi there", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "Hello!", ts: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("appends across calls rather than overwriting", async () => {
    await captureExchange(config, store, { user: "one", assistant: "1" }, { now });
    await captureExchange(config, store, { user: "two", assistant: "2" }, { now });

    const turns = readJsonl(join(store.dir, "conversation.jsonl"));
    expect(turns).toHaveLength(4);
  });

  it("strips ANSI and control sequences from stored content", async () => {
    await captureExchange(
      config,
      store,
      { user: "\u001b[31mred\u001b[0m", assistant: "ok\u0007" },
      { now },
    );

    const turns = readJsonl(join(store.dir, "conversation.jsonl"));
    expect(turns[0]).toMatchObject({ role: "user", content: "red" });
    expect(turns[1]).toMatchObject({ role: "assistant", content: "ok" });
  });

  it("extracts durable facts into facts.json", async () => {
    const result = await captureExchange(
      config,
      store,
      { user: "My name is Ada. I live in London.", assistant: "Nice to meet you." },
      { now },
    );

    expect(result.factsExtracted).toBe(2);
    const facts = JSON.parse(readFileSync(join(store.dir, "facts.json"), "utf8")) as {
      facts: { text: string; ts: string }[];
    };
    expect(facts.facts.map((f) => f.text)).toEqual(["name = Ada", "location = London"]);
    expect(facts.facts[0]?.ts).toBe("2026-01-01T00:00:00.000Z");
  });

  it("deduplicates facts across calls", async () => {
    await captureExchange(config, store, { user: "My name is Ada.", assistant: "ok" }, { now });
    const result = await captureExchange(
      config,
      store,
      { user: "My name is Ada.", assistant: "ok" },
      { now },
    );

    expect(result.factsExtracted).toBe(0);
    const facts = JSON.parse(readFileSync(join(store.dir, "facts.json"), "utf8")) as {
      facts: unknown[];
    };
    expect(facts.facts).toHaveLength(1);
  });

  it("writes an empty facts.json when nothing is extracted", async () => {
    await captureExchange(config, store, { user: "What is 2+2?", assistant: "4" }, { now });

    const facts = JSON.parse(readFileSync(join(store.dir, "facts.json"), "utf8")) as {
      facts: unknown[];
    };
    expect(facts.facts).toEqual([]);
  });

  it("does not create an embeddings store when no embedder is provided", async () => {
    const result = await captureExchange(
      config,
      store,
      { user: "hi", assistant: "hello" },
      { now },
    );

    expect(result.vectorsEmbedded).toBe(0);
    expect(existsSync(join(store.dir, "embeddings"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(store.dir, "meta.json"), "utf8")) as {
      embedding?: unknown;
    };
    expect(meta.embedding).toBeUndefined();
  });

  it("records vector-less capture in meta.json when the backend cannot embed", async () => {
    const result = await captureExchange(
      config,
      store,
      { user: "hi", assistant: "hello" },
      { now, embeddingUnsupported: true },
    );

    expect(result.vectorsEmbedded).toBe(0);
    expect(existsSync(join(store.dir, "embeddings"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(store.dir, "meta.json"), "utf8")) as {
      embedding?: unknown;
      embeddingUnsupported?: unknown;
    };
    expect(meta.embedding).toBeUndefined();
    expect(meta.embeddingUnsupported).toBe(true);
  });

  it("drops a stale embedding descriptor when a later capture is vector-less", async () => {
    // Seed an embed-capable capture, then capture again against a backend that
    // cannot embed: the flag wins and the now-orphaned index descriptor is cleared.
    await captureExchange(
      config,
      store,
      { user: "hello", assistant: "hi" },
      { now, embedder: makeEmbedder() },
    );
    await captureExchange(
      config,
      store,
      { user: "hi again", assistant: "hello" },
      { now, embeddingUnsupported: true },
    );

    const meta = JSON.parse(readFileSync(join(store.dir, "meta.json"), "utf8")) as {
      embedding?: unknown;
      embeddingUnsupported?: unknown;
    };
    expect(meta.embeddingUnsupported).toBe(true);
    expect(meta.embedding).toBeUndefined();
  });

  it("ignores a supplied embedder when the backend cannot embed (no fabricated vectors)", async () => {
    const embedder = makeEmbedder();
    const result = await captureExchange(
      config,
      store,
      { user: "hi", assistant: "hello" },
      { now, embedder, embeddingUnsupported: true },
    );

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result.vectorsEmbedded).toBe(0);
    expect(existsSync(join(store.dir, "embeddings"))).toBe(false);
  });

  it("does not flag meta.embeddingUnsupported on the embed-capable path", async () => {
    await captureExchange(
      config,
      store,
      { user: "hi", assistant: "hello" },
      { now, embedder: makeEmbedder() },
    );

    const meta = JSON.parse(readFileSync(join(store.dir, "meta.json"), "utf8")) as {
      embeddingUnsupported?: unknown;
    };
    expect(meta.embeddingUnsupported).toBeUndefined();
  });

  it("embeds turns and records the embedding model + dimension in meta.json", async () => {
    const embedder = makeEmbedder("nomic-embed-text", 3);
    const result = await captureExchange(
      config,
      store,
      { user: "hi", assistant: "hello" },
      { now, embedder },
    );

    expect(result.vectorsEmbedded).toBe(2);
    const chunks = readJsonl(join(store.dir, "embeddings", "chunks.jsonl"));
    const vectors = readJsonl(join(store.dir, "embeddings", "vectors.jsonl"));
    expect(chunks).toHaveLength(2);
    expect(vectors).toHaveLength(2);

    const meta = JSON.parse(readFileSync(join(store.dir, "meta.json"), "utf8")) as {
      embedding?: { model: string; dimension: number };
    };
    expect(meta.embedding).toEqual({ model: "nomic-embed-text", dimension: 3 });
  });

  it("passes control-stripped content to the embedder", async () => {
    const embedder = makeEmbedder();
    await captureExchange(
      config,
      store,
      { user: "\u001b[31mhi\u001b[0m", assistant: "hello\u0007" },
      { now, embedder },
    );

    expect(embedder.embed).toHaveBeenCalledWith(["hi", "hello"]);
  });

  it("rejects mixing a different embedding model into an existing store", async () => {
    await captureExchange(
      config,
      store,
      { user: "hi", assistant: "hello" },
      { now, embedder: makeEmbedder("nomic-embed-text", 3) },
    );

    await expect(
      captureExchange(
        config,
        store,
        { user: "hi", assistant: "hello" },
        { now, embedder: makeEmbedder("other-embed", 3) },
      ),
    ).rejects.toThrow(MemoryError);
  });

  it("rejects an embedder whose vectors do not match the reported dimension", async () => {
    const embedder: CaptureEmbedder = {
      model: "nomic-embed-text",
      embed: async (inputs) => ({
        vectors: inputs.map(() => [1, 2]),
        dimension: 3,
      }),
    };

    await expect(
      captureExchange(config, store, { user: "hi", assistant: "hello" }, { now, embedder }),
    ).rejects.toThrow(MemoryError);
  });

  it("persists nothing when the embedder fails", async () => {
    const embedder: CaptureEmbedder = {
      model: "nomic-embed-text",
      embed: async () => {
        throw new Error("backend offline");
      },
    };

    await expect(
      captureExchange(config, store, { user: "hi", assistant: "hello" }, { now, embedder }),
    ).rejects.toThrow("backend offline");

    expect(existsSync(join(store.dir, "conversation.jsonl"))).toBe(false);
    expect(existsSync(join(store.dir, "facts.json"))).toBe(false);
    expect(existsSync(join(store.dir, "embeddings"))).toBe(false);
  });

  it("writes memory files 0600 even under a permissive umask", async () => {
    const previous = process.umask(0);
    try {
      await captureExchange(config, store, { user: "hi", assistant: "hello" }, { now });
      expect(statSync(join(store.dir, "conversation.jsonl")).mode & 0o777).toBe(0o600);
      expect(statSync(join(store.dir, "facts.json")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });
});
