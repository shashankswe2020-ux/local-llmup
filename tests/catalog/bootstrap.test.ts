import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_CLOCK,
  FAMILY_QUALITY_OFFSET,
  KV_BYTES_PER_TOKEN_FP16,
  buildBootstrapCatalog,
} from "../../src/catalog/bootstrap.js";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "../../src/catalog/load.js";
import { REGISTRY_SNAPSHOT } from "../../src/catalog/registry-snapshot.js";
import { CatalogSchema } from "../../src/catalog/schema.js";
import { LICENSE_ALLOWLIST } from "../../src/types.js";
import type { Catalog } from "../../src/types.js";

// The curated skeleton the snapshot fully controls. Quant `diskBytes`/`sha256`
// are refreshed live from the registry by the weekly enrich pipeline, and
// `generatedAt` records that refresh, so only this skeleton is guaranteed
// reproducible from the committed snapshot.
function curatedSkeleton(cat: Catalog): unknown {
  return {
    schemaVersion: cat.schemaVersion,
    models: cat.models.map((model) => ({
      ...model,
      quantizations: model.quantizations.map((quant) => ({ name: quant.name })),
    })),
  };
}

describe("bootstrap catalog generation", () => {
  const catalog = buildBootstrapCatalog(REGISTRY_SNAPSHOT, BOOTSTRAP_CLOCK);

  it("produces a schema-valid catalog stamped with the frozen clock", () => {
    expect(() => CatalogSchema.parse(catalog)).not.toThrow();
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.generatedAt).toBe(BOOTSTRAP_CLOCK.toISOString());
  });

  it("admits only open-weight, allow-listed-license models", () => {
    const allow = new Set<string>(LICENSE_ALLOWLIST);
    for (const model of catalog.models) {
      expect(model.openWeight).toBe(true);
      expect(allow.has(model.license)).toBe(true);
    }
  });

  it("assigns a benchmarkProxy in [0,1] to every model", () => {
    for (const model of catalog.models) {
      expect(model.benchmarkProxy).toBeGreaterThanOrEqual(0);
      expect(model.benchmarkProxy).toBeLessThanOrEqual(1);
    }
  });

  it("is materially complete across the required seed families", () => {
    const families = new Set(catalog.models.map((m) => m.family));
    for (const family of [
      "kimi-k2",
      "llama3.1",
      "llama3.2",
      "llama3.3",
      "qwen2.5",
      "qwen3",
      "deepseek-r1",
      "deepseek-v3",
      "mistral",
      "mixtral",
      "gemma2",
      "gemma3",
      "gemma3n",
      "gemma4",
      "phi3",
      "phi4",
      "phi4-mini",
      "glm4",
      "yi",
      "smollm2",
      "olmo2",
      "granite3.1",
    ]) {
      expect(families.has(family)).toBe(true);
    }
    expect(catalog.models.length).toBeGreaterThanOrEqual(40);
  });

  it("includes the official Gemma 4 E4B QAT Ollama artifact", () => {
    const model = catalog.models.find((candidate) => candidate.id === "gemma4:e4b-it-qat");

    expect(model).toMatchObject({
      family: "gemma4",
      params: "8B",
      architecture: "dense",
      contextLength: 131072,
      source: {
        ollama: "gemma4:e4b-it-qat",
        hf: "google/gemma-4-E4B-it-qat-q4_0-gguf",
      },
      quantizations: [{ name: "Q4_0" }],
    });
    expect(model?.kvBytesPerToken).toBeUndefined();
  });

  it("includes the curated consumer-model coverage tranche", () => {
    const byId = new Map(catalog.models.map((model) => [model.id, model]));

    expect([...byId.keys()]).toEqual(
      expect.arrayContaining([
        "gemma3n:e2b",
        "gemma3n:e4b",
        "phi4-mini:3.8b",
        "qwen3:0.6b",
        "qwen3:1.7b",
        "qwen3:4b",
      ]),
    );
    expect(byId.get("gemma3n:e2b")).toMatchObject({
      params: "6B",
      contextLength: 32768,
      source: { ollama: "gemma3n:e2b", hf: "google/gemma-3n-E2B-it" },
    });
    expect(byId.get("gemma3n:e4b")).toMatchObject({
      params: "8B",
      contextLength: 32768,
      source: { ollama: "gemma3n:e4b", hf: "google/gemma-3n-E4B-it" },
    });
    expect(byId.get("phi4-mini:3.8b")).toMatchObject({
      contextLength: 131072,
      source: { ollama: "phi4-mini:3.8b", hf: "microsoft/Phi-4-mini-instruct" },
    });
    expect(byId.get("qwen3:0.6b")?.contextLength).toBe(40960);
    expect(byId.get("qwen3:1.7b")?.contextLength).toBe(40960);
    expect(byId.get("qwen3:4b")?.contextLength).toBe(262144);
  });

  it("covers every required Kimi release", () => {
    const ids = new Set(catalog.models.map((m) => m.id));
    for (const id of [
      "kimi-k2:instruct",
      "kimi-k2:base",
      "kimi-k2-thinking",
      "kimi-vl-a3b",
      "kimi-dev-72b",
      "kimi-linear",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("is deterministic across runs given the frozen clock", () => {
    const again = buildBootstrapCatalog(REGISTRY_SNAPSHOT, BOOTSTRAP_CLOCK);
    expect(again).toEqual(catalog);
  });

  it("reproduces the committed catalog's curated content from the snapshot", () => {
    // Registry-refreshed quant sizes/digests and `generatedAt` are excluded — the
    // snapshot guarantees the curated skeleton, the enrich pipeline the live facts.
    const committed = loadCatalog(DEFAULT_CATALOG_PATH);
    expect(curatedSkeleton(committed)).toEqual(curatedSkeleton(catalog));
  });

  it("has unique model ids", () => {
    const ids = catalog.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the benchmark-offset table in sync with the snapshot families", () => {
    // A family added to the snapshot without a pinned offset silently scores 0;
    // fail loudly here instead of shipping an under-scored model.
    for (const model of REGISTRY_SNAPSHOT) {
      expect(FAMILY_QUALITY_OFFSET).toHaveProperty(model.family);
    }
  });

  describe("kvBytesPerToken attention-geometry backfill (T-CW2)", () => {
    const byId = new Map(catalog.models.map((m) => [m.id, m]));

    // Independent geometry ledger [layers, kvHeads, headDim] per curated id, so
    // the expected KV figure is DERIVED here (`2×2×L×kv×hd`) rather than copied
    // from the source constant. This catches a fat-fingered figure in
    // KV_BYTES_PER_TOKEN_FP16 — the exact under-count that would falsely claim a
    // model fits — instead of comparing the constant to itself.
    const GEOMETRY: Readonly<Record<string, readonly [number, number, number]>> = {
      "llama3.1:8b": [32, 8, 128],
      "llama3.1:70b": [80, 8, 128],
      "llama3.3:70b": [80, 8, 128],
      "llama3.2:1b": [16, 8, 64],
      "llama3.2:3b": [28, 8, 128],
      "qwen2.5:0.5b": [24, 2, 64],
      "qwen2.5:0.5b-mlx": [24, 2, 64],
      "qwen2.5:1.5b": [28, 2, 128],
      "qwen2.5:3b": [36, 2, 128],
      "qwen2.5:7b": [28, 4, 128],
      "qwen2.5:14b": [48, 8, 128],
      "qwen2.5:32b": [64, 8, 128],
      "qwen2.5:72b": [80, 8, 128],
      "qwen2.5-coder:7b": [28, 4, 128],
      "qwen2.5-coder:32b": [64, 8, 128],
      "mistral:7b": [32, 8, 128],
      "mistral-nemo:12b": [40, 8, 128],
      "mistral-small:24b": [40, 8, 128],
    };

    it("the geometry ledger covers exactly the curated table", () => {
      expect(new Set(Object.keys(GEOMETRY))).toEqual(new Set(Object.keys(KV_BYTES_PER_TOKEN_FP16)));
    });

    it("each curated figure equals 2×2×layers×kvHeads×headDim from its geometry", () => {
      for (const [id, [layers, kvHeads, headDim]] of Object.entries(GEOMETRY)) {
        const expected = 2 * 2 * layers * kvHeads * headDim;
        expect(KV_BYTES_PER_TOKEN_FP16[id]).toBe(expected);
        expect(byId.get(id)?.kvBytesPerToken).toBe(expected);
      }
    });

    it("only curates ids that exist in the catalog (no typo'd keys)", () => {
      for (const id of Object.keys(KV_BYTES_PER_TOKEN_FP16)) {
        expect(byId.has(id)).toBe(true);
      }
    });

    it("curates only positive-integer figures", () => {
      for (const value of Object.values(KV_BYTES_PER_TOKEN_FP16)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    });

    it("leaves MLA and sliding-window models on the honesty gate (no figure)", () => {
      // DeepSeek-V2/V3 use MLA; Gemma 2/3 use hybrid sliding-window attention.
      // The generic formula would be wrong for both, so they stay `unknown`.
      for (const id of ["deepseek-v3", "deepseek-r1:671b", "gemma2:9b", "gemma3:12b"]) {
        expect(KV_BYTES_PER_TOKEN_FP16).not.toHaveProperty(id);
        expect(byId.get(id)?.kvBytesPerToken).toBeUndefined();
      }
    });

    it("anchors Llama 3.1 8B to its exact geometry (32 L × 8 kv × 128 hd)", () => {
      // 2 (K,V) × 32 layers × 8 KV heads × 128 head-dim × 2 bytes = 131,072.
      expect(byId.get("llama3.1:8b")?.kvBytesPerToken).toBe(131072);
    });
  });
});
