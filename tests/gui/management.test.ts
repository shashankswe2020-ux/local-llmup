import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { createModelManager, parseGuiUpRequest } from "../../src/gui/management.js";
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
        } as RecommendationResult["entries"][number]["model"],
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

    const models = await manager.recommended(2);
    expect(models).toHaveLength(2);
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

  it("throws when up completes but no active model is recorded", async () => {
    const manager = createModelManager({
      collectRecommendation: async () => makeRecommendation(),
      runUp: async () => undefined,
      collectLs: () => ({ type: "empty" }),
    });

    await expect(manager.up({ model: "qwen2.5:1.5b" })).rejects.toThrow(ValidationError);
  });
});
