import { describe, expect, it } from "vitest";
import { ModelResolutionError, ValidationError } from "../src/errors.js";
import { resolveModel } from "../src/resolver.js";
import type { Catalog, CatalogModel, Quantization } from "../src/types.js";

function quant(name: string): Quantization {
  return { name, diskBytes: 1, minRamBytes: 1, minVramBytes: 0 };
}

function model(
  id: string,
  family: string,
  quants: readonly Quantization[],
): CatalogModel {
  return {
    id,
    family,
    params: "8B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 4096,
    capabilities: ["chat"],
    releaseDate: "2025-01-01",
    source: { ollama: id },
    quantizations: quants,
  };
}

const CATALOG: Catalog = {
  schemaVersion: 2,
  generatedAt: "2026-08-04T00:00:00Z",
  models: [
    model("llama3.1:8b", "llama3.1", [quant("Q4_K_M")]),
    model("llama3.1:70b", "llama3.1", [quant("Q4_K_M")]),
    model("qwen3:30b-a3b", "qwen3", [quant("Q4_K_M")]),
    model("gemma2:2b", "gemma2", [quant("Q4_K_M"), quant("Q8_0")]),
  ],
};

describe("resolveModel", () => {
  it("resolves an exact model id", () => {
    const resolved = resolveModel(CATALOG, "llama3.1:8b");
    expect(resolved.model.id).toBe("llama3.1:8b");
    expect(resolved.quant).toBeUndefined();
  });

  it("resolves a family with a single model", () => {
    expect(resolveModel(CATALOG, "qwen3").model.id).toBe("qwen3:30b-a3b");
  });

  it("resolves an id with an explicit quant suffix", () => {
    const resolved = resolveModel(CATALOG, "gemma2:2b-Q4_K_M");
    expect(resolved.model.id).toBe("gemma2:2b");
    expect(resolved.quant?.name).toBe("Q4_K_M");
  });

  it("matches the quant suffix case-insensitively", () => {
    expect(resolveModel(CATALOG, "gemma2:2b-q4_k_m").quant?.name).toBe("Q4_K_M");
  });

  it("selects a specific quant among several", () => {
    expect(resolveModel(CATALOG, "gemma2:2b-q8_0").quant?.name).toBe("Q8_0");
  });

  it("resolves a fuzzy prefix to a single model", () => {
    expect(resolveModel(CATALOG, "gemma").model.id).toBe("gemma2:2b");
  });

  it("throws an ambiguity error listing sorted candidates", () => {
    try {
      resolveModel(CATALOG, "llama3.1");
      expect.unreachable("expected ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      expect((error as ModelResolutionError).candidates).toEqual([
        "llama3.1:70b",
        "llama3.1:8b",
      ]);
    }
  });

  it("throws a not-found error for an unknown model", () => {
    try {
      resolveModel(CATALOG, "does-not-exist");
      expect.unreachable("expected not found");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      expect((error as ModelResolutionError).candidates).toEqual([]);
    }
  });

  it("rejects path-traversal input", () => {
    try {
      resolveModel(CATALOG, "../../etc/passwd");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).not.toBeInstanceOf(ModelResolutionError);
      expect((error as Error).message).toContain("traversal");
    }
  });

  it("strips control/ANSI bytes from echoed error input", () => {
    try {
      resolveModel(CATALOG, "..\u001b[2Jx");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as Error).message.includes("\u001b")).toBe(false);
    }
  });

  it("rejects a resolved model whose backend source id is unsafe", () => {
    const poisoned: Catalog = {
      ...CATALOG,
      models: [
        {
          ...(CATALOG.models[0] as CatalogModel),
          id: "safe:id",
          family: "safe",
          source: { ollama: "x; rm -rf ~" },
        },
      ],
    };
    expect(() => resolveModel(poisoned, "safe:id")).toThrow(ValidationError);
  });

  it("rejects empty input", () => {
    expect(() => resolveModel(CATALOG, "   ")).toThrow(ValidationError);
  });

  const badInputs = ["llama 3.1", "llama$(id)", "a|b", "a;b", "a`b`"];
  for (const input of badInputs) {
    it(`rejects invalid characters in ${JSON.stringify(input)}`, () => {
      expect(() => resolveModel(CATALOG, input)).toThrow(ValidationError);
    });
  }
});
