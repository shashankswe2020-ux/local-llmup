import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import {
  createModelManager,
  parseContextWindowPreset,
  parseGuiUpRequest,
} from "../../src/gui/management.js";
import type { RecommendationResult } from "../../src/commands/recommend.js";
import type { LsResult } from "../../src/commands/ls.js";

function makeRecommendation(): RecommendationResult {
  return {
    task: null,
    availableBackendsOnly: false,
    hardware: {} as RecommendationResult["hardware"],
    usableBytes: 34 * 1024 ** 3,
    memoryKind: "ram",
    entries: [
      {
        rank: 1,
        model: {
          id: "qwen2.5:1.5b",
          family: "qwen2.5",
          params: "1.5B",
          architecture: "dense",
          license: "apache-2.0",
          openWeight: true,
          contextLength: 32_768,
          capabilities: ["chat"],
          releaseDate: "2024-09-19",
          source: { ollama: "qwen2.5:1.5b" },
          quantizations: [
            {
              name: "Q4_K_M",
              diskBytes: 986 * 1024 ** 2,
              minRamBytes: 0,
              minVramBytes: 0,
            },
          ],
        },
        quant: {
          name: "Q4_K_M",
          diskBytes: 986 * 1024 ** 2,
          minRamBytes: 0,
          minVramBytes: 0,
        },
        requiredBytes: 1024 ** 3,
        score: 0.9,
        scores: {} as RecommendationResult["entries"][number]["scores"],
        usableBytes: 34 * 1024 ** 3,
        verdict: "yes",
        throughput: { lowTokPerSec: 40, highTokPerSec: 60, known: true },
        throughputEvidence: {
          backend: "ollama",
          source: "offline-estimate",
          unknownReason: null,
        },
        backends: ["ollama"],
      },
    ],
    wontFit: [],
    command: "local-llmup up qwen2.5:1.5b",
    throughputBackend: "ollama",
    maxContextMode: false,
  };
}

function makeActive(): LsResult {
  return {
    type: "active",
    modelId: "qwen2.5:1.5b",
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    port: 11434,
    ownedByUs: false,
  };
}

describe("parseGuiUpRequest", () => {
  it("accepts a valid model id with an optional port", () => {
    expect(parseGuiUpRequest({ model: "qwen2.5:1.5b", port: 11434 })).toEqual({
      model: "qwen2.5:1.5b",
      port: 11434,
    });
  });

  it("accepts a model id without a port", () => {
    expect(parseGuiUpRequest({ model: "qwen2.5:1.5b" })).toEqual({ model: "qwen2.5:1.5b" });
  });

  it("rejects an empty model id", () => {
    expect(() => parseGuiUpRequest({ model: "" })).toThrow(ValidationError);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseGuiUpRequest({ model: "x", port: 70000 })).toThrow(ValidationError);
  });

  it("accepts an optional backend from the known set", () => {
    expect(parseGuiUpRequest({ model: "qwen2.5:0.5b", backend: "llamacpp" })).toEqual({
      model: "qwen2.5:0.5b",
      backend: "llamacpp",
    });
  });

  it("rejects an unknown backend", () => {
    expect(() => parseGuiUpRequest({ model: "x", backend: "vllm" })).toThrow(ValidationError);
  });
});

describe("parseContextWindowPreset", () => {
  it("accepts the four context-window presets and an absent value", () => {
    expect(["low", "mid", "high", "max"].map(parseContextWindowPreset)).toEqual([
      "low",
      "mid",
      "high",
      "max",
    ]);
    expect(parseContextWindowPreset(null)).toBeUndefined();
  });

  it("rejects unknown context-window presets", () => {
    expect(() => parseContextWindowPreset("extreme")).toThrow(ValidationError);
  });
});

describe("createModelManager", () => {
  it("maps recommendation entries to compact summaries", async () => {
    const manager = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    const models = await manager.recommended();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "qwen2.5:1.5b",
      family: "qwen2.5",
      params: "1.5B",
      verdict: "yes",
      quant: "Q4_K_M",
      backends: ["ollama"],
    });
    expect(models[0]?.throughput).toEqual({ known: true, lowTokPerSec: 40, highTokPerSec: 60 });
  });

  it("exposes catalog and scoring evidence for model details", async () => {
    const recommendation = makeRecommendation();
    const entry = recommendation.entries[0]!;
    const manager = createModelManager({
      collectRecommendation: async () => ({
        ...recommendation,
        entries: [
          {
            ...entry,
            model: {
              ...entry.model,
              architecture: "dense",
              license: "apache-2.0",
              openWeight: true,
              contextLength: 32_768,
              capabilities: ["chat", "code"],
              releaseDate: "2025-01-01",
              source: { ollama: "qwen2.5:1.5b", hf: "Qwen/Qwen2.5-1.5B-Instruct" },
              kvBytesPerToken: 49_152,
              benchmarkProxy: 0.72,
              quantizations: [entry.quant],
            },
            score: 0.9,
            scores: { quality: 0.72, fit: 0.91, recency: 0.8, speed: 0.88, capability: 1 },
            requiredBytes: 1_200_000_000,
            usableBytes: 34 * 1024 ** 3,
            contextSizing: {
              tokens: 16_384,
              weightsBytes: 1_000_000_000,
              kvCacheBytes: 805_306_368,
            },
          },
        ],
      }),
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    await expect(manager.recommended()).resolves.toMatchObject([
      {
        architecture: "dense",
        license: "apache-2.0",
        capabilities: ["chat", "code"],
        releaseDate: "2025-01-01",
        contextLength: 32_768,
        requiredBytes: 1_200_000_000,
        usableBytes: 34 * 1024 ** 3,
        score: 0.9,
        scores: { quality: 0.72, fit: 0.91, recency: 0.8, speed: 0.88, capability: 1 },
        throughputEvidence: { backend: "ollama", source: "offline-estimate" },
        source: { ollama: "qwen2.5:1.5b", hf: "Qwen/Qwen2.5-1.5B-Instruct" },
        quantizations: [{ name: "Q4_K_M", diskBytes: 1_033_895_936 }],
        contextSizing: { tokens: 16_384, weightsBytes: 1_000_000_000, kvCacheBytes: 805_306_368 },
      },
    ]);
  });

  it("limits the number of recommended models", async () => {
    const manyEntries = makeRecommendation();
    const cloned: RecommendationResult = {
      ...manyEntries,
      entries: [manyEntries.entries[0]!, manyEntries.entries[0]!, manyEntries.entries[0]!],
    };
    const manager = createModelManager({
      collectRecommendation: async () => cloned,
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    const models = await manager.recommended({ limit: 2 });
    expect(models).toHaveLength(2);
  });

  it("scopes the recommendation to the requested runtime and exposes the runtime list", async () => {
    const seen: unknown[] = [];
    const manager = createModelManager({
      collectRecommendation: async (options) => {
        seen.push(options);
        return makeRecommendation();
      },
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    await manager.recommended({ runtime: "llamacpp" });
    expect(seen).toEqual([{ backend: "llamacpp" }]);

    await manager.recommended();
    expect(seen[1]).toEqual({});

    expect(manager.runtimes()).toEqual(["ollama", "llamacpp", "mlx", "lmstudio"]);
  });

  it.each([
    ["low", 25],
    ["mid", 50],
    ["high", 75],
    ["max", 100],
  ] as const)("maps the %s GUI preset to %i%% model-relative sizing", async (contextPreset, contextPercent) => {
    const collectRecommendation = vi.fn(async () => makeRecommendation());
    const manager = createModelManager({
      collectRecommendation,
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    await manager.recommended({ runtime: "ollama", contextPreset });

    expect(collectRecommendation).toHaveBeenCalledWith({ backend: "ollama", contextPercent });
  });

  it("preserves an unknown context-fit result for honest UI rendering", async () => {
    const recommendation = makeRecommendation();
    const manager = createModelManager({
      collectRecommendation: async () => ({
        ...recommendation,
        entries: [
          {
            ...recommendation.entries[0]!,
            contextSizing: { tokens: 4096, weightsBytes: 1_000_000, kvCacheBytes: null },
          },
        ],
      }),
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    await expect(manager.recommended({ contextPreset: "low" })).resolves.toMatchObject([
      { contextTokens: 4096, contextFitKnown: false },
    ]);
  });

  it("returns the active model summary or null", () => {
    const active = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp: async () => undefined,
      collectLs: () => makeActive(),
    });
    expect(active.active()).toMatchObject({
      modelId: "qwen2.5:1.5b",
      backend: "ollama",
      ownership: "attached",
    });

    const empty = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });
    expect(empty.active()).toBeNull();
  });

  it("brings a model up and reports the new active model", async () => {
    const runUp = vi.fn(async () => undefined);
    let lsResult: LsResult = { type: "empty" };
    const manager = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp,
      collectLs: () => lsResult,
    });

    lsResult = makeActive();
    const result = await manager.up({ model: "qwen2.5:1.5b" });

    expect(runUp).toHaveBeenCalledWith({ model: "qwen2.5:1.5b" });
    expect(result).toMatchObject({ modelId: "qwen2.5:1.5b", backend: "ollama" });
  });

  it("propagates a port to runUp when provided", async () => {
    const runUp = vi.fn(async () => undefined);
    const manager = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp,
      collectLs: () => makeActive(),
    });

    await manager.up({ model: "qwen2.5:1.5b", port: 11500 });
    expect(runUp).toHaveBeenCalledWith({ model: "qwen2.5:1.5b", port: 11500 });
  });

  it("propagates a backend to runUp when provided", async () => {
    const runUp = vi.fn(async () => undefined);
    const manager = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp,
      collectLs: () => makeActive(),
    });

    await manager.up({ model: "qwen2.5:0.5b", backend: "llamacpp" });
    expect(runUp).toHaveBeenCalledWith({ model: "qwen2.5:0.5b", backend: "llamacpp" });
  });

  it("throws when up completes but no active model is recorded", async () => {
    const manager = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    await expect(manager.up({ model: "qwen2.5:1.5b" })).rejects.toThrow(ValidationError);
  });
});
