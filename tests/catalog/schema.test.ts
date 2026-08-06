import { describe, it, expect } from "vitest";
import { CatalogSchema, CatalogModelSchema } from "../../src/catalog/schema.js";
import { denseModel, moeModel, validCatalog } from "./fixtures.js";

describe("CatalogModelSchema", () => {
  it("accepts a valid dense model", () => {
    expect(() => CatalogModelSchema.parse(denseModel)).not.toThrow();
  });

  it("accepts a valid MoE model with activeParams", () => {
    expect(() => CatalogModelSchema.parse(moeModel)).not.toThrow();
  });

  describe("license gate", () => {
    for (const license of ["proprietary", "closed-source", "unknown", ""]) {
      it(`rejects non-allow-listed license ${JSON.stringify(license)}`, () => {
        expect(() => CatalogModelSchema.parse({ ...denseModel, license })).toThrow();
      });
    }

    it("rejects a missing license", () => {
      const { license: _license, ...withoutLicense } = denseModel;
      expect(() => CatalogModelSchema.parse(withoutLicense)).toThrow();
    });

    it("accepts an allow-listed license", () => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, license: "apache-2.0" })).not.toThrow();
    });
  });

  describe("MoE requires activeParams", () => {
    it("rejects an moe model without activeParams", () => {
      const { activeParams: _drop, ...moeWithout } = moeModel;
      expect(() => CatalogModelSchema.parse(moeWithout)).toThrow();
    });

    it("allows a dense model without activeParams", () => {
      expect(denseModel).not.toHaveProperty("activeParams");
      expect(() => CatalogModelSchema.parse(denseModel)).not.toThrow();
    });

    it("rejects a dense model that declares activeParams", () => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, activeParams: "4B" })).toThrow();
    });
  });

  describe("open-weight consistency", () => {
    it("rejects openWeight:false even with an allow-listed license", () => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, openWeight: false })).toThrow();
    });
  });

  describe("releaseDate", () => {
    it("rejects an impossible calendar date", () => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, releaseDate: "2024-02-30" })).toThrow();
      expect(() => CatalogModelSchema.parse({ ...denseModel, releaseDate: "2024-13-01" })).toThrow();
    });

    it("accepts a real date", () => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, releaseDate: "2024-02-29" })).not.toThrow();
    });
  });

  describe("quantization bytes", () => {
    it("rejects negative disk bytes", () => {
      const bad = { ...denseModel, quantizations: [{ ...denseModel.quantizations[0]!, diskBytes: -1 }] };
      expect(() => CatalogModelSchema.parse(bad)).toThrow();
    });

    it("rejects missing minRamBytes", () => {
      const { minRamBytes: _drop, ...quantWithout } = denseModel.quantizations[0]!;
      const bad = { ...denseModel, quantizations: [quantWithout] };
      expect(() => CatalogModelSchema.parse(bad)).toThrow();
    });

    it("rejects a malformed sha256", () => {
      const bad = { ...denseModel, quantizations: [{ ...denseModel.quantizations[0]!, sha256: "xyz" }] };
      expect(() => CatalogModelSchema.parse(bad)).toThrow();
    });

    it("requires at least one quantization", () => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, quantizations: [] })).toThrow();
    });
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => CatalogModelSchema.parse({ ...denseModel, rogue: true })).toThrow();
  });

  it("requires a source with at least ollama or hf", () => {
    expect(() => CatalogModelSchema.parse({ ...denseModel, source: {} })).toThrow();
  });

  describe("kvBytesPerToken (optional attention-geometry field)", () => {
    it("accepts a valid positive-integer value", () => {
      expect(() =>
        CatalogModelSchema.parse({ ...denseModel, kvBytesPerToken: 131072 }),
      ).not.toThrow();
    });

    it("accepts absence (honesty gate — unknown geometry)", () => {
      expect(denseModel).not.toHaveProperty("kvBytesPerToken");
      expect(() => CatalogModelSchema.parse(denseModel)).not.toThrow();
    });

    it.each([0, -1, 1.5, 131072.0001])("rejects a non-positive-integer value %s", (bad) => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, kvBytesPerToken: bad })).toThrow();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-finite value %s", (bad) => {
      expect(() => CatalogModelSchema.parse({ ...denseModel, kvBytesPerToken: bad })).toThrow();
    });
  });
});

describe("CatalogSchema", () => {
  it("accepts a valid catalog and round-trips values", () => {
    const parsed = CatalogSchema.parse(validCatalog);
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[1]?.activeParams).toBe("32B");
  });

  it("rejects the wrong schemaVersion", () => {
    expect(() => CatalogSchema.parse({ ...validCatalog, schemaVersion: 1 })).toThrow();
  });

  it("rejects a non-ISO generatedAt", () => {
    expect(() => CatalogSchema.parse({ ...validCatalog, generatedAt: "2026-08-04" })).toThrow();
  });

  it("rejects an empty models array", () => {
    expect(() => CatalogSchema.parse({ ...validCatalog, models: [] })).toThrow();
  });
});
