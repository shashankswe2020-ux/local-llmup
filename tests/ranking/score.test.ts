import { describe, expect, it } from "vitest";
import {
  compareRankedModels,
  rankModels,
  recencyScore,
  type RankedModel,
} from "../../src/ranking/rank.js";
import { RANKING_WEIGHTS, RECENCY_WINDOW_DAYS } from "../../src/ranking/weights.js";
import type { Capability, Catalog, CatalogModel, HardwareProfile } from "../../src/types.js";

const GIB = 1024 ** 3;
const GENERATED_AT = "2026-01-01T00:00:00.000Z";

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "llama3.1:8b",
    family: "llama3.1",
    params: "8B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 131072,
    capabilities: ["chat"],
    releaseDate: "2025-07-23",
    source: { ollama: "llama3.1:8b" },
    quantizations: [
      {
        name: "Q4_K_M",
        diskBytes: 4_900_000_000,
        minRamBytes: 6_500_000_000,
        minVramBytes: 6_000_000_000,
      },
    ],
    ...overrides,
  };
}

function catalog(models: readonly CatalogModel[], generatedAt = GENERATED_AT): Catalog {
  return { schemaVersion: 1, generatedAt, models };
}

function gpuHw(vramBytes: number): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 64 * GIB,
    freeRamBytes: 64 * GIB,
    gpu: [{ vendor: "nvidia", vramBytes }],
    freeDiskBytes: 1_000 * GIB,
  };
}

function ranked(
  overrides: Partial<RankedModel> & { model: CatalogModel; score: number },
): RankedModel {
  return {
    quant: overrides.model.quantizations[0]!,
    requiredBytes: 1,
    usableBytes: 2,
    scores: { quality: 0, fit: 0, speed: 0, recency: 0, capability: 0 },
    ...overrides,
  };
}

describe("weights invariant", () => {
  it("the five composite weights sum to 1", () => {
    const sum =
      RANKING_WEIGHTS.quality +
      RANKING_WEIGHTS.fit +
      RANKING_WEIGHTS.speed +
      RANKING_WEIGHTS.recency +
      RANKING_WEIGHTS.capability;
    expect(sum).toBeGreaterThan(0.999);
    expect(sum).toBeLessThan(1.001);
  });
});

describe("recencyScore", () => {
  it("scores a release on the reference date at 1", () => {
    expect(recencyScore("2026-01-01", GENERATED_AT)).toBeCloseTo(1, 10);
  });

  it("scores a release one full window earlier at 0", () => {
    const old = new Date(Date.parse(GENERATED_AT) - RECENCY_WINDOW_DAYS * 86_400_000);
    const iso = old.toISOString().slice(0, 10);
    expect(recencyScore(iso, GENERATED_AT)).toBeCloseTo(0, 6);
  });

  it("clamps a future release date to 1", () => {
    expect(recencyScore("2030-01-01", GENERATED_AT)).toBe(1);
  });

  it("clamps a very old release to 0", () => {
    expect(recencyScore("2000-01-01", GENERATED_AT)).toBe(0);
  });

  it("is pinned to the reference date, not the wall clock", () => {
    // Same model, two different catalog generatedAt values → different recency.
    const younger = recencyScore("2025-01-01", "2025-06-01T00:00:00.000Z");
    const older = recencyScore("2025-01-01", "2026-06-01T00:00:00.000Z");
    expect(younger).toBeGreaterThan(older);
  });
});

describe("rankModels", () => {
  it("returns a composite score in [0, 1] and the fitting quant", () => {
    const result = rankModels(catalog([model()]), gpuHw(16 * GIB));
    expect(result.ranked).toHaveLength(1);
    const entry = result.ranked[0]!;
    expect(entry.score).toBeGreaterThanOrEqual(0);
    expect(entry.score).toBeLessThanOrEqual(1);
    expect(entry.quant.name).toBe("Q4_K_M");
  });

  it("distinguishes an empty catalog from an all-too-big catalog", () => {
    const empty = rankModels(catalog([]), gpuHw(16 * GIB));
    expect(empty.ranked).toEqual([]);
    expect(empty.wontFit).toEqual([]);

    const kimi = model({
      id: "kimi-k2:instruct",
      params: "1T",
      architecture: "moe",
      activeParams: "32B",
      quantizations: [
        { name: "Q4_K_M", diskBytes: 600 * GIB, minRamBytes: 620 * GIB, minVramBytes: 600 * GIB },
      ],
    });
    const tooBig = rankModels(catalog([kimi]), gpuHw(16 * GIB));
    expect(tooBig.ranked).toEqual([]);
    expect(tooBig.wontFit).toHaveLength(1);
    expect(tooBig.wontFit[0]!.reason).toBe("vram-bound");
  });

  it("orders survivors by descending composite score", () => {
    const strong = model({ id: "a", benchmarkProxy: 0.9, releaseDate: "2025-12-01" });
    const weak = model({ id: "b", benchmarkProxy: 0.1, releaseDate: "2024-01-01" });
    const result = rankModels(catalog([weak, strong]), gpuHw(16 * GIB));
    expect(result.ranked.map((r) => r.model.id)).toEqual(["a", "b"]);
  });

  it("gives a deterministic speed edge to smaller active-param MoE models", () => {
    // Two models with identical footprint quant; the MoE with a small active set
    // should out-score a dense model of the same total size on speed.
    const dense = model({ id: "dense-30b", params: "30B" });
    const moe = model({
      id: "moe-30b-a3b",
      params: "30B",
      architecture: "moe",
      activeParams: "3B",
    });
    const result = rankModels(catalog([dense, moe]), gpuHw(48 * GIB));
    const denseEntry = result.ranked.find((r) => r.model.id === "dense-30b")!;
    const moeEntry = result.ranked.find((r) => r.model.id === "moe-30b-a3b")!;
    expect(moeEntry.scores.speed).toBeGreaterThan(denseEntry.scores.speed);
  });

  it("rewards capability match and stays neutral when no task is given", () => {
    const chatOnly = model({ id: "chat", capabilities: ["chat"] });
    const coder = model({ id: "coder", capabilities: ["chat", "code"] });

    const neutral = rankModels(catalog([chatOnly, coder]), gpuHw(16 * GIB));
    for (const r of neutral.ranked) expect(r.scores.capability).toBe(1);

    const forCode: Capability = "code";
    const scored = rankModels(catalog([chatOnly, coder]), gpuHw(16 * GIB), { task: forCode });
    const chatEntry = scored.ranked.find((r) => r.model.id === "chat")!;
    const coderEntry = scored.ranked.find((r) => r.model.id === "coder")!;
    expect(coderEntry.scores.capability).toBe(1);
    expect(chatEntry.scores.capability).toBe(0);
  });

  it("re-ranks by the context-sized footprint when a context is given", () => {
    // Same weights, but the model with the heavier KV geometry sizes larger at a
    // long context, shifting its utilization and therefore its fit score. The
    // requiredBytes the ranker consumes must reflect the context footprint.
    const light = model({ id: "light", kvBytesPerToken: 8192 });
    const heavy = model({ id: "heavy", kvBytesPerToken: 131072 });

    const base = rankModels(catalog([light, heavy]), gpuHw(48 * GIB));
    const withCtx = rankModels(catalog([light, heavy]), gpuHw(48 * GIB), { context: 65536 });

    const heavyBase = base.ranked.find((r) => r.model.id === "heavy")!;
    const heavyCtx = withCtx.ranked.find((r) => r.model.id === "heavy")!;
    // The 64K KV cache (~8.6 GB) is added on top of the weights at context.
    expect(heavyCtx.requiredBytes).toBeGreaterThan(heavyBase.requiredBytes);
  });

  it("routes a context request through evaluateFitAtContext (context-bound wontFit)", () => {
    const capped = model({ id: "small-ctx", contextLength: 8192, kvBytesPerToken: 8192 });
    const result = rankModels(catalog([capped]), gpuHw(48 * GIB), { context: 16384 });
    expect(result.ranked).toEqual([]);
    expect(result.wontFit).toHaveLength(1);
    expect(result.wontFit[0]!.reason).toBe("context-bound");
  });

  it("still ranks an unknown-geometry model by weights under a context request (CW6)", () => {
    const unknown = model({ id: "no-geo" }); // no kvBytesPerToken
    expect(unknown.kvBytesPerToken).toBeUndefined();
    const result = rankModels(catalog([unknown]), gpuHw(16 * GIB), { context: 65536 });
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]!.model.id).toBe("no-geo");
  });
});

describe("compareRankedModels tie-break", () => {
  const base = model();

  it("breaks equal scores by benchmarkProxy descending", () => {
    const high = ranked({ model: model({ id: "x", benchmarkProxy: 0.8 }), score: 0.5 });
    const low = ranked({ model: model({ id: "y", benchmarkProxy: 0.2 }), score: 0.5 });
    expect([low, high].sort(compareRankedModels).map((r) => r.model.id)).toEqual(["x", "y"]);
  });

  it("then by releaseDate descending", () => {
    const newer = ranked({ model: model({ id: "x", releaseDate: "2025-12-01" }), score: 0.5 });
    const older = ranked({ model: model({ id: "y", releaseDate: "2024-01-01" }), score: 0.5 });
    expect([older, newer].sort(compareRankedModels).map((r) => r.model.id)).toEqual(["x", "y"]);
  });

  it("then by id ascending, for a fully stable order", () => {
    const a = ranked({ model: model({ id: "aaa" }), score: 0.5 });
    const b = ranked({ model: model({ id: "bbb" }), score: 0.5 });
    expect([b, a].sort(compareRankedModels).map((r) => r.model.id)).toEqual(["aaa", "bbb"]);
    expect(base.id).toBe("llama3.1:8b");
  });
});
