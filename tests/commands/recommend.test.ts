import { describe, expect, it } from "vitest";
import {
  buildRecommendation,
  formatRecommendationJson,
  formatRecommendationText,
  runRecommend,
  type RecommendDeps,
} from "../../src/commands/recommend.js";
import type { Capability, Catalog, CatalogModel, HardwareProfile } from "../../src/types.js";

const GIB = 1024 ** 3;

function dense(
  id: string,
  params: string,
  diskBytes: number,
  overrides: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    id,
    family: id.split(":")[0]!,
    params,
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 8192,
    capabilities: ["chat"],
    releaseDate: "2025-06-01",
    source: { ollama: id },
    quantizations: [
      {
        name: "Q4_K_M",
        diskBytes,
        minRamBytes: diskBytes + 1_500_000_000,
        minVramBytes: diskBytes + 1_000_000_000,
      },
    ],
    ...overrides,
  };
}

const KIMI: CatalogModel = {
  id: "kimi-k2:instruct",
  family: "kimi-k2",
  params: "1T",
  architecture: "moe",
  activeParams: "32B",
  license: "modified-mit",
  openWeight: true,
  contextLength: 131072,
  capabilities: ["chat", "reasoning"],
  releaseDate: "2025-07-01",
  source: { ollama: "kimi-k2:instruct" },
  quantizations: [
    { name: "Q4_K_M", diskBytes: 600 * GIB, minRamBytes: 620 * GIB, minVramBytes: 600 * GIB },
  ],
};

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

function appleHw(totalRamGib: number): HardwareProfile {
  return {
    arch: "arm64",
    platform: "darwin",
    totalRamBytes: totalRamGib * GIB,
    freeRamBytes: totalRamGib * GIB,
    gpu: [{ vendor: "apple", vramBytes: 0 }],
    freeDiskBytes: 1_000 * GIB,
  };
}

const FIXTURE = catalog([
  dense("llama3.1:8b", "8B", 4_900_000_000, { benchmarkProxy: 0.82 }),
  dense("gemma2:2b", "2B", 1_600_000_000),
  KIMI,
]);

describe("buildRecommendation", () => {
  it("ranks fitting models, lists won't-fit, and picks a top command", () => {
    const result = buildRecommendation(FIXTURE, appleHw(32));
    expect(result.entries.map((e) => e.model.id)).toEqual(["llama3.1:8b", "gemma2:2b"]);
    expect(result.entries[0]!.rank).toBe(1);
    expect(result.wontFit).toHaveLength(1);
    expect(result.wontFit[0]!.model.id).toBe("kimi-k2:instruct");
    expect(result.wontFit[0]!.reason).toBe("ram-bound");
    expect(result.command).toBe("local-llmup up llama3.1:8b");
    expect(result.memoryKind).toBe("ram");
  });

  it("treats an absent --task identically to a task every survivor satisfies", () => {
    const noTask = buildRecommendation(FIXTURE, appleHw(32));
    const chat: Capability = "chat";
    const withChat = buildRecommendation(FIXTURE, appleHw(32), { task: chat });
    expect(withChat.entries.map((e) => e.model.id)).toEqual(noTask.entries.map((e) => e.model.id));
    for (let i = 0; i < noTask.entries.length; i += 1) {
      expect(withChat.entries[i]!.score).toBeCloseTo(noTask.entries[i]!.score, 10);
    }
  });

  it("returns no command when nothing fits", () => {
    const result = buildRecommendation(catalog([KIMI]), appleHw(16));
    expect(result.entries).toEqual([]);
    expect(result.wontFit).toHaveLength(1);
    expect(result.command).toBeNull();
  });
});

describe("formatRecommendationText", () => {
  it("renders a ranked table, the up command, and a won't-fit section", () => {
    const text = formatRecommendationText(buildRecommendation(FIXTURE, appleHw(32)));
    expect(text).toContain("Rank");
    expect(text).toContain("llama3.1:8b");
    expect(text).toContain("gemma2:2b");
    expect(text).toContain("Q4_K_M");
    expect(text).toContain("local-llmup up llama3.1:8b");
    expect(text).toContain("kimi-k2:instruct");
    expect(text).toContain("ram-bound");
  });

  it("distinguishes an empty catalog from an all-too-big catalog", () => {
    const empty = formatRecommendationText(buildRecommendation(catalog([]), appleHw(32)));
    expect(empty).toContain("No models in the catalog");

    const tooBig = formatRecommendationText(buildRecommendation(catalog([KIMI]), appleHw(16)));
    expect(tooBig).toContain("No models fit");
    expect(tooBig).toContain("kimi-k2:instruct");
    expect(tooBig).not.toContain("No models in the catalog");
  });

  it("strips control characters from ids in the command line and won't-fit section", () => {
    const evil = catalog([
      dense("good\u001b[31m:8b", "8B", 4_900_000_000),
      { ...KIMI, id: "bad\u0000:1t" },
    ]);
    const text = formatRecommendationText(buildRecommendation(evil, appleHw(32)));
    expect(text.includes("\u001b")).toBe(false);
    expect(text.includes("\u0000")).toBe(false);
    expect(text).toContain("local-llmup up good:8b");
    expect(text).toContain("bad:1t");
  });
});

describe("formatRecommendationJson", () => {
  it("emits a stable, parseable schema", () => {
    const json = JSON.parse(formatRecommendationJson(buildRecommendation(FIXTURE, appleHw(32))));
    expect(json).toMatchObject({
      hardware: { arch: "arm64", platform: "darwin", memoryKind: "ram" },
      command: "local-llmup up llama3.1:8b",
    });
    expect(typeof json.hardware.usableMemoryBytes).toBe("number");
    expect(Array.isArray(json.ranked)).toBe(true);
    expect(json.ranked[0]).toEqual({
      rank: 1,
      id: "llama3.1:8b",
      family: "llama3.1",
      params: "8B",
      quant: "Q4_K_M",
      requiredBytes: json.ranked[0].requiredBytes,
      license: "apache-2.0",
      capabilities: ["chat"],
      score: json.ranked[0].score,
    });
    expect(json.wontFit).toEqual([{ id: "kimi-k2:instruct", reason: "ram-bound" }]);
  });
});

describe("runRecommend", () => {
  function deps(overrides: Partial<RecommendDeps> = {}): { deps: RecommendDeps; writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      deps: {
        loadCatalog: () => FIXTURE,
        detectHardware: () => Promise.resolve(appleHw(32)),
        write: (text) => writes.push(text),
        ...overrides,
      },
    };
  }

  it("writes the text report by default", async () => {
    const { deps: d, writes } = deps();
    await runRecommend({}, d);
    expect(writes.join("")).toContain("local-llmup up llama3.1:8b");
  });

  it("writes JSON when json is requested", async () => {
    const { deps: d, writes } = deps();
    await runRecommend({ json: true }, d);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.command).toBe("local-llmup up llama3.1:8b");
  });

  it("propagates catalog load failures", async () => {
    const { deps: d } = deps({
      loadCatalog: () => {
        throw new Error("boom");
      },
    });
    await expect(runRecommend({}, d)).rejects.toThrow("boom");
  });
});
