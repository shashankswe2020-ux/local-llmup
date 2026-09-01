import { describe, expect, it } from "vitest";
import {
  evaluateCatalogCoverage,
  fetchOllamaLibraryInventory,
  OLLAMA_LIBRARY_INVENTORY_URL,
  parseOllamaLibraryInventory,
  selectMonitoredOllamaModels,
} from "../../src/catalog/coverage.js";
import type { CoverageFetchLike } from "../../src/catalog/coverage.js";
import type { Catalog } from "../../src/types.js";

function catalogWithOllamaSources(sources: readonly string[]): Catalog {
  return {
    schemaVersion: 2,
    generatedAt: "2026-09-01T00:00:00.000Z",
    models: sources.map((ollama, index) => ({
      id: `model-${String(index)}`,
      family: `family-${String(index)}`,
      params: "1B",
      architecture: "dense" as const,
      license: "apache-2.0" as const,
      openWeight: true,
      contextLength: 8192,
      capabilities: ["chat" as const],
      releaseDate: "2026-01-01",
      source: { ollama },
      quantizations: [
        { name: "Q4_K_M", diskBytes: 1, minRamBytes: 1, minVramBytes: 1 },
      ],
    })),
  };
}

describe("parseOllamaLibraryInventory", () => {
  it("reads active library entries and ignores commented exclusions", () => {
    const source = `
var libraryModels = []string{
  "gemma4",
  "qwen3.6",
  // "cloud-only",
  /* "too-large", */
}
`;

    expect(parseOllamaLibraryInventory(source)).toEqual(["gemma4", "qwen3.6"]);
  });

  it("fails closed when the expected inventory declaration is absent", () => {
    expect(() => parseOllamaLibraryInventory("package integration\n")).toThrow(/inventory/u);
  });
});

describe("evaluateCatalogCoverage", () => {
  it("reports upstream repositories absent from exact catalog Ollama sources", () => {
    const catalog = catalogWithOllamaSources([
      "gemma4:e4b-it-qat",
      "library/qwen3:8b",
      "namespace/community:latest",
    ]);

    expect(evaluateCatalogCoverage(catalog, ["qwen3.6", "gemma4", "qwen3"])).toEqual({
      upstreamCount: 3,
      coveredCount: 2,
      missing: ["qwen3.6"],
    });
  });

  it("deduplicates and sorts upstream inventory deterministically", () => {
    const catalog = catalogWithOllamaSources([]);

    expect(evaluateCatalogCoverage(catalog, ["zeta", "alpha", "zeta"]).missing).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});

describe("selectMonitoredOllamaModels", () => {
  it("keeps current vendor lineages and excludes unrelated upstream repositories", () => {
    const catalog = catalogWithOllamaSources([
      "gemma4:e4b-it-qat",
      "qwen3:8b",
      "mistral-small:24b",
    ]);

    expect(
      selectMonitoredOllamaModels(catalog, [
        "alfred",
        "gemma3n",
        "gemma4",
        "mistral-small3.2",
        "qwen3.6",
      ]),
    ).toEqual(["gemma3n", "gemma4", "mistral-small3.2", "qwen3.6"]);
  });
});

describe("fetchOllamaLibraryInventory", () => {
  it("fetches and parses the allowlisted official inventory without redirects", async () => {
    const fetch: CoverageFetchLike = async (url, init) => {
      expect(url).toBe(OLLAMA_LIBRARY_INVENTORY_URL);
      expect(init?.redirect).toBe("error");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => 'var libraryModels = []string{\n  "gemma4",\n}\n',
      };
    };

    await expect(fetchOllamaLibraryInventory({ fetch })).resolves.toEqual(["gemma4"]);
  });

  it("fails closed on a non-success response", async () => {
    const fetch: CoverageFetchLike = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => "",
    });

    await expect(fetchOllamaLibraryInventory({ fetch })).rejects.toThrow(/503/u);
  });

  it("rejects a response whose declared size exceeds the limit", async () => {
    const fetch: CoverageFetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "2000000" },
      text: async () => "",
    });

    await expect(fetchOllamaLibraryInventory({ fetch })).rejects.toThrow(/oversized/u);
  });
});