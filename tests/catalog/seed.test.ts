import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "../../src/catalog/load.js";
import { CatalogSchema } from "../../src/catalog/schema.js";
import type { Catalog } from "../../src/types.js";

const GIB = 1024 ** 3;

describe("dev seed data/models.json", () => {
  const catalog: Catalog = loadCatalog(DEFAULT_CATALOG_PATH);

  it("loads and validates against the catalog schema", () => {
    expect(() => CatalogSchema.parse(catalog)).not.toThrow();
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.models.length).toBeGreaterThanOrEqual(8);
  });

  it("includes at least one large MoE reasoning model in the kimi-k2 family", () => {
    const largeMoe = catalog.models.filter(
      (m) => m.architecture === "moe" && m.params.endsWith("T"),
    );
    expect(largeMoe.length).toBeGreaterThanOrEqual(1);
    expect(largeMoe.some((m) => m.family === "kimi-k2")).toBe(true);
    // MoE invariant: total params declared alongside a smaller active count.
    for (const m of largeMoe) {
      expect(m.activeParams).toBeDefined();
    }
    // The flagship large MoE is a reasoning model.
    expect(largeMoe.some((m) => m.capabilities.includes("reasoning"))).toBe(true);
  });

  it("provides several small-fit models (assert by capability class, not id)", () => {
    const smallFit = catalog.models.filter((m) =>
      m.quantizations.some((q) => q.minRamBytes <= 16 * GIB),
    );
    expect(smallFit.length).toBeGreaterThanOrEqual(4);
    // Every small-fit model must at least support chat.
    for (const m of smallFit) {
      expect(m.capabilities).toContain("chat");
    }
  });

  it("covers the expected model families as dev data", () => {
    const families = new Set(catalog.models.map((m) => m.family.split(/[.\d]/)[0]));
    for (const expected of [
      "kimi",
      "llama",
      "qwen",
      "deepseek",
      "mistral",
      "gemma",
      "phi",
      "glm",
      "smollm",
    ]) {
      expect([...families].some((f) => f.startsWith(expected))).toBe(true);
    }
  });

  it("has unique model ids", () => {
    const ids = catalog.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares at least one code-capable and one reasoning-capable model", () => {
    expect(catalog.models.some((m) => m.capabilities.includes("code"))).toBe(true);
    expect(catalog.models.some((m) => m.capabilities.includes("reasoning"))).toBe(true);
  });

  it("seeds at least three pinned gguf sources with digest for llamacpp (B15)", () => {
    const ggufModels = catalog.models.filter((m) => m.source.gguf !== undefined);
    expect(ggufModels.length).toBeGreaterThanOrEqual(3);
    for (const model of ggufModels) {
      const gguf = model.source.gguf;
      expect(gguf).toBeDefined();
      expect(gguf?.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(gguf?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(gguf?.file.endsWith(".gguf")).toBe(true);
    }
  });
});
