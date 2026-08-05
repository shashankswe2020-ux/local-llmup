import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_CLOCK,
  FAMILY_QUALITY_OFFSET,
  buildBootstrapCatalog,
} from "../../src/catalog/bootstrap.js";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "../../src/catalog/load.js";
import { REGISTRY_SNAPSHOT } from "../../src/catalog/registry-snapshot.js";
import { CatalogSchema } from "../../src/catalog/schema.js";
import { LICENSE_ALLOWLIST } from "../../src/types.js";

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
      "phi3",
      "phi4",
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

  it("reproduces the committed data/models.json exactly", () => {
    const committed = loadCatalog(DEFAULT_CATALOG_PATH);
    expect(committed).toEqual(catalog);
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
});
