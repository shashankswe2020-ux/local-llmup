import type { Catalog } from "../../src/types.js";
import type { RawRegistryModel } from "../../src/catalog/enrich.js";

/**
 * Raw, untrusted registry records (pre-validation) used to drive enrichment
 * tests. These mimic the normalized shape the HF/Ollama collectors emit before
 * the pipeline sizes, gates, and merges them into the catalog.
 */

/** A well-formed dense open-weight candidate. */
export function rawDense(overrides: Partial<RawRegistryModel> = {}): RawRegistryModel {
  return {
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
    quantizations: [{ name: "Q4_K_M", diskBytes: 4_900_000_000 }],
    ...overrides,
  };
}

/** A well-formed MoE open-weight candidate with total + active params. */
export function rawMoe(overrides: Partial<RawRegistryModel> = {}): RawRegistryModel {
  return {
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
      { name: "Q4_K_M", diskBytes: 600_000_000_000, sha256: "a".repeat(64) },
    ],
    ...overrides,
  };
}

/** An empty starting catalog (no models) — used by backfill tests. */
export function emptyCatalog(generatedAt = "2024-01-01T00:00:00Z"): Catalog {
  return { schemaVersion: 2, generatedAt, models: [] };
}
