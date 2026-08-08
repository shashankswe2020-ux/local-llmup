import { describe, expect, it, vi } from "vitest";
import { MemoryError } from "../../src/errors.js";
import {
  decideEmbeddingStrategy,
  planMigration,
  SUMMARY_TOKEN_BUDGET,
  type ConversationTurn,
  type MigrationEmbedder,
  type MigrationPlan,
  type SourceMemory,
} from "../../src/memory/migrate.js";

function turn(role: ConversationTurn["role"], content: string, ts: string): ConversationTurn {
  return { role, content, ts };
}

/** Ten ~100-token turns (400 chars each) so a remap must keep some and fold the rest. */
const TURNS: ConversationTurn[] = Array.from({ length: 10 }, (_, i) =>
  turn(
    i % 2 === 0 ? "user" : "assistant",
    `turn${i}`.padEnd(400, "x"),
    `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
  ),
);

const SYSTEM = "S"; // 1 token
const FACTS = "F"; // 1 token → reserved = 2
const RESERVED = 2;

/** ~4 chars/token, mirrors the module's internal estimate. */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function planCost(plan: MigrationPlan): number {
  const turnCost = plan.turns.reduce((sum, t) => sum + tokens(t.content), 0);
  return tokens(plan.systemPrompt ?? "") + tokens(plan.factsText) + turnCost;
}

function baseSource(overrides: Partial<SourceMemory> = {}): SourceMemory {
  return {
    turns: TURNS,
    systemPrompt: SYSTEM,
    factsText: FACTS,
    factsPresent: true,
    embedding: undefined,
    ...overrides,
  };
}

function makeEmbedder(model: string, dimension: number): MigrationEmbedder {
  return {
    model,
    dimension,
    embed: vi.fn(async (inputs: readonly string[]) => ({
      vectors: inputs.map(() => Array.from({ length: dimension }, (_, d) => d + 1)),
      dimension,
    })),
  };
}

describe("decideEmbeddingStrategy", () => {
  it("returns none when the source has no embeddings", () => {
    expect(decideEmbeddingStrategy(undefined, { model: "a", dimension: 3 })).toBe("none");
  });

  it("reuses when there is no target embedder to re-embed with", () => {
    expect(decideEmbeddingStrategy({ model: "a", dimension: 3 }, undefined)).toBe("reuse");
  });

  it("reuses when model and dimension both match", () => {
    expect(
      decideEmbeddingStrategy({ model: "a", dimension: 3 }, { model: "a", dimension: 3 }),
    ).toBe("reuse");
  });

  it("re-embeds when only the dimension differs", () => {
    expect(
      decideEmbeddingStrategy({ model: "a", dimension: 3 }, { model: "a", dimension: 4 }),
    ).toBe("reembed");
  });

  it("re-embeds when only the model differs", () => {
    expect(
      decideEmbeddingStrategy({ model: "a", dimension: 3 }, { model: "b", dimension: 3 }),
    ).toBe("reembed");
  });

  it("re-embeds when both model and dimension differ", () => {
    expect(
      decideEmbeddingStrategy({ model: "a", dimension: 3 }, { model: "b", dimension: 4 }),
    ).toBe("reembed");
  });
});

describe("planMigration — context remap", () => {
  it("carries every turn unchanged when the target context is large enough", async () => {
    const summarizer = vi.fn(async () => "unused");
    const plan = await planMigration({
      source: baseSource(),
      targetContextLength: 100_000,
      summarizer,
    });

    expect(summarizer).not.toHaveBeenCalled();
    expect(plan.summary.strategy).toBe("none");
    expect(plan.summary.turnsCarried).toBe(10);
    expect(plan.summary.turnsSummarized).toBe(0);
    expect(plan.turns).toEqual(TURNS);
    expect(plan.systemPrompt).toBe(SYSTEM);
    expect(plan.factsText).toBe(FACTS);
  });

  it("summarizes the overflow oldest turns and keeps system + facts", async () => {
    const summarizer = vi.fn(async () => "PRIOR");
    // Room for reserved + summary budget + exactly two ~100-token turns.
    const target = RESERVED + SUMMARY_TOKEN_BUDGET + 250;
    const plan = await planMigration({
      source: baseSource(),
      targetContextLength: target,
      summarizer,
    });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(summarizer).toHaveBeenCalledWith(TURNS.slice(0, 8));
    expect(plan.summary.strategy).toBe("summarize");
    expect(plan.summary.turnsCarried).toBe(2);
    expect(plan.summary.turnsSummarized).toBe(8);

    // The two most recent turns survive, preceded by a compact summary turn.
    expect(plan.turns).toHaveLength(3);
    expect(plan.turns.slice(1)).toEqual(TURNS.slice(8));
    expect(plan.turns[0]?.role).toBe("system");
    expect(plan.turns[0]?.content).toContain("PRIOR");

    // System prompt and facts are never dropped by a remap.
    expect(plan.systemPrompt).toBe(SYSTEM);
    expect(plan.factsText).toBe(FACTS);

    // The remapped context provably fits the target window.
    expect(planCost(plan)).toBeLessThanOrEqual(target);
  });

  it("bounds an overlong summary so the remap still fits the target window", async () => {
    const summarizer = vi.fn(async () => "X".repeat(100_000));
    const target = RESERVED + SUMMARY_TOKEN_BUDGET + 250;
    const plan = await planMigration({
      source: baseSource(),
      targetContextLength: target,
      summarizer,
    });

    expect(plan.summary.strategy).toBe("summarize");
    expect(tokens(plan.turns[0]?.content ?? "")).toBeLessThanOrEqual(SUMMARY_TOKEN_BUDGET);
    expect(planCost(plan)).toBeLessThanOrEqual(target);
  });

  it("falls back to deterministic truncation when no summarizer is available", async () => {
    const target = RESERVED + SUMMARY_TOKEN_BUDGET + 250;
    const plan = await planMigration({ source: baseSource(), targetContextLength: target });

    expect(plan.summary.strategy).toBe("truncate");
    expect(plan.summary.turnsCarried).toBe(2);
    expect(plan.summary.turnsSummarized).toBe(8);
    expect(plan.turns).toHaveLength(3);
    expect(plan.turns[0]?.role).toBe("system");
    expect(plan.turns[0]?.content).toContain("8");
    expect(plan.systemPrompt).toBe(SYSTEM);
    expect(plan.factsText).toBe(FACTS);
  });

  it("carries facts.json byte-identically", async () => {
    const weird = `{"schemaVersion":1,\n  "facts":[  {"text":"x","ts":"t"}]}\n`;
    const plan = await planMigration({
      source: baseSource({ factsText: weird }),
      targetContextLength: 100_000,
    });
    expect(plan.factsText).toBe(weird);
  });
});

describe("planMigration — re-embed matrix", () => {
  const chunks = [
    { id: "id-1", text: "hello", ts: "2026-01-01T00:00:01.000Z" },
    { id: "id-2", text: "world", ts: "2026-01-01T00:00:02.000Z" },
  ] as const;
  const vectors = [
    { id: "id-1", vector: [0.1, 0.2, 0.3] },
    { id: "id-2", vector: [0.4, 0.5, 0.6] },
  ] as const;

  function withEmbeddings(): SourceMemory {
    return baseSource({
      turns: [],
      embedding: { meta: { model: "a", dimension: 3 }, chunks: [...chunks], vectors: [...vectors] },
    });
  }

  it("reuses the index as-is when the target vector space matches", async () => {
    const embedder = makeEmbedder("a", 3);
    const plan = await planMigration({
      source: withEmbeddings(),
      targetContextLength: 1000,
      targetEmbedder: embedder,
    });

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(plan.summary.embeddingStrategy).toBe("reuse");
    expect(plan.summary.vectorsReembedded).toBe(0);
    expect(plan.embedding?.meta).toEqual({ model: "a", dimension: 3 });
    expect(plan.embedding?.vectors).toEqual([...vectors]);
    expect(plan.embedding?.chunks).toEqual([...chunks]);
  });

  it("reuses when no target embedder is provided", async () => {
    const plan = await planMigration({
      source: withEmbeddings(),
      targetContextLength: 1000,
    });
    expect(plan.summary.embeddingStrategy).toBe("reuse");
    expect(plan.summary.vectorsReembedded).toBe(0);
    expect(plan.embedding?.vectors).toEqual([...vectors]);
  });

  it("drops the embedding index when embedding is unsupported (vector-less honesty gate)", async () => {
    const plan = await planMigration({
      source: withEmbeddings(),
      targetContextLength: 1000,
      targetEmbedder: makeEmbedder("a", 3),
      embeddingUnsupported: true,
    });

    expect(plan.summary.embeddingStrategy).toBe("none");
    expect(plan.summary.vectorsReembedded).toBe(0);
    expect(plan.embedding).toBeUndefined();
    expect(plan.embeddingUnsupported).toBe(true);
  });

  it("re-embeds source chunks with the target embedder, preserving ids", async () => {
    const embedder = makeEmbedder("b", 2);
    const plan = await planMigration({
      source: withEmbeddings(),
      targetContextLength: 1000,
      targetEmbedder: embedder,
    });

    expect(embedder.embed).toHaveBeenCalledWith(["hello", "world"]);
    expect(plan.summary.embeddingStrategy).toBe("reembed");
    expect(plan.summary.vectorsReembedded).toBe(2);
    expect(plan.embedding?.meta).toEqual({ model: "b", dimension: 2 });
    expect(plan.embedding?.chunks).toEqual([...chunks]);
    expect(plan.embedding?.vectors).toEqual([
      { id: "id-1", vector: [1, 2] },
      { id: "id-2", vector: [1, 2] },
    ]);
  });

  it("reports no embedding work when the source has no index", async () => {
    const plan = await planMigration({
      source: baseSource({ turns: [] }),
      targetContextLength: 1000,
      targetEmbedder: makeEmbedder("b", 2),
    });
    expect(plan.summary.embeddingStrategy).toBe("none");
    expect(plan.summary.vectorsReembedded).toBe(0);
    expect(plan.embedding).toBeUndefined();
  });

  it("rejects a re-embed whose vector dimension disagrees with the embedder", async () => {
    const embedder: MigrationEmbedder = {
      model: "b",
      dimension: 2,
      embed: vi.fn(async (inputs: readonly string[]) => ({
        vectors: inputs.map(() => [1, 2, 3]), // 3 dims, not 2
        dimension: 2,
      })),
    };
    await expect(
      planMigration({
        source: withEmbeddings(),
        targetContextLength: 1000,
        targetEmbedder: embedder,
      }),
    ).rejects.toThrow(MemoryError);
  });
});
