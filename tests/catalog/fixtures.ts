import type { Catalog, CatalogModel } from "../../src/types.js";

/** A valid dense model used as the base for positive and mutation tests. */
export const denseModel: CatalogModel = {
  id: "llama3.1:8b",
  family: "llama3.1",
  params: "8B",
  architecture: "dense",
  license: "llama-3.1-community",
  openWeight: true,
  contextLength: 131072,
  capabilities: ["chat", "code"],
  releaseDate: "2024-07-23",
  source: { ollama: "llama3.1:8b", hf: "meta-llama/Llama-3.1-8B" },
  quantizations: [
    {
      name: "Q4_K_M",
      diskBytes: 4_900_000_000,
      minRamBytes: 6_500_000_000,
      minVramBytes: 6_000_000_000,
    },
  ],
  benchmarkProxy: 0.71,
};

/** A valid MoE model (Kimi K2) with total + active params and a weight digest. */
export const moeModel: CatalogModel = {
  id: "kimi-k2:instruct",
  family: "kimi-k2",
  params: "1T",
  architecture: "moe",
  activeParams: "32B",
  license: "modified-mit",
  openWeight: true,
  contextLength: 131072,
  capabilities: ["chat", "reasoning"],
  releaseDate: "2025-07-11",
  source: { ollama: "kimi-k2:instruct" },
  quantizations: [
    {
      name: "Q4_K_M",
      diskBytes: 600_000_000_000,
      minRamBytes: 620_000_000_000,
      minVramBytes: 600_000_000_000,
      sha256: "a".repeat(64),
    },
  ],
};

export const validCatalog: Catalog = {
  schemaVersion: 2,
  generatedAt: "2026-08-04T00:00:00Z",
  models: [denseModel, moeModel],
};
