import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchLike, FetchResponseLike } from "../../src/catalog/enrich.js";
import {
  parseOllamaRef,
  quantFromTag,
  refreshCatalogQuants,
} from "../../src/catalog/registry-collector.js";
import type { Catalog, CatalogModel } from "../../src/types.js";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);
const NOW = new Date("2026-09-01T00:00:00.000Z");

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "llama3.1:8b",
    family: "llama3.1",
    params: "8B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 131072,
    capabilities: ["chat"],
    releaseDate: "2024-07-23",
    source: { ollama: "llama3.1:8b" },
    quantizations: [{ name: "Q4_K_M", diskBytes: 1_000, minRamBytes: 1_000, minVramBytes: 1_000 }],
    ...overrides,
  } as CatalogModel;
}

function catalogOf(models: CatalogModel[]): Catalog {
  return { schemaVersion: 2, generatedAt: "2026-08-04T00:00:00.000Z", models } as Catalog;
}

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; contentLength?: string | null } = {},
): FetchResponseLike {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" ? (init.contentLength ?? null) : null,
    },
    json: async () => body,
  };
}

function manifest(size: number, digest: string): unknown {
  return {
    layers: [
      { mediaType: "application/vnd.ollama.image.template", digest: `sha256:${"c".repeat(64)}`, size: 100 },
      { mediaType: "application/vnd.ollama.image.model", digest: `sha256:${digest}`, size },
      { mediaType: "application/vnd.ollama.image.license", digest: `sha256:${"d".repeat(64)}`, size: 50 },
    ],
  };
}

const BASE = "https://registry.ollama.ai";

describe("quantFromTag", () => {
  it("extracts the quant suffix from a tag", () => {
    expect(quantFromTag("8b-instruct-q4_K_M")).toBe("Q4_K_M");
    expect(quantFromTag("70b-q8_0")).toBe("Q8_0");
    expect(quantFromTag("7b-f16")).toBe("F16");
    expect(quantFromTag("7b-bf16")).toBe("BF16");
  });

  it("returns undefined when the tag carries no quant", () => {
    expect(quantFromTag("8b")).toBeUndefined();
    expect(quantFromTag("latest")).toBeUndefined();
  });
});

describe("parseOllamaRef", () => {
  it("splits name and tag", () => {
    expect(parseOllamaRef("llama3.1:8b")).toEqual({ path: "llama3.1", tag: "8b" });
  });

  it("defaults to latest when no tag is present", () => {
    expect(parseOllamaRef("llama3.1")).toEqual({ path: "llama3.1", tag: "latest" });
  });

  it("keeps a namespaced path", () => {
    expect(parseOllamaRef("library/qwen3:8b")).toEqual({ path: "library/qwen3", tag: "8b" });
  });
});

describe("refreshCatalogQuants", () => {
  it("patches the matching quant's size + digest and recomputes its memory floor", async () => {
    const fetch: FetchLike = vi.fn(async (url: string, init?: FetchInit) => {
      expect(url).toBe("https://registry.ollama.ai/v2/library/llama3.1/manifests/8b-q4_K_M");
      expect(init?.headers?.accept).toContain("manifest");
      return jsonResponse(manifest(4_661_211_808, SHA));
    });
    const input = catalogOf([
      model({ source: { ollama: "llama3.1:8b-q4_K_M" } } as Partial<CatalogModel>),
    ]);

    const { catalog, updated } = await refreshCatalogQuants(input, {
      fetch,
      registryBase: BASE,
      now: NOW,
    });

    expect(updated).toEqual(["llama3.1:8b"]);
    const quant = catalog.models[0]?.quantizations[0];
    expect(quant?.diskBytes).toBe(4_661_211_808);
    expect(quant?.sha256).toBe(SHA);
    expect(quant?.minRamBytes).toBeGreaterThan(1_000); // memory recomputed for the new size
    expect(catalog.generatedAt).toBe(NOW.toISOString());
  });

  it("leaves the catalog byte-identical when the registry matches the committed data", async () => {
    const committed = model({
      source: { ollama: "llama3.1:8b-q4_K_M" },
      quantizations: [
        {
          name: "Q4_K_M",
          diskBytes: 4_661_211_808,
          minRamBytes: 5_000_000_000,
          minVramBytes: 5_000_000_000,
          sha256: SHA,
        },
      ],
    } as Partial<CatalogModel>);
    const fetch: FetchLike = vi.fn(async () => jsonResponse(manifest(4_661_211_808, SHA)));

    const input = catalogOf([committed]);
    const { catalog, updated } = await refreshCatalogQuants(input, {
      fetch,
      registryBase: BASE,
      now: NOW,
    });

    expect(updated).toEqual([]);
    expect(catalog.generatedAt).toBe(input.generatedAt); // no bump
    expect(catalog.models[0]).toEqual(committed);
  });

  it("refreshes the primary quant when the tag has no quant suffix", async () => {
    const fetch: FetchLike = vi.fn(async () => jsonResponse(manifest(2_000_000_000, SHA2)));
    const input = catalogOf([
      model({
        source: { ollama: "qwen3:8b" },
        quantizations: [
          { name: "Q4_K_M", diskBytes: 1_000, minRamBytes: 1_000, minVramBytes: 1_000 },
          { name: "Q8_0", diskBytes: 3_000, minRamBytes: 3_000, minVramBytes: 3_000 },
        ],
      } as Partial<CatalogModel>),
    ]);

    const { catalog } = await refreshCatalogQuants(input, { fetch, registryBase: BASE, now: NOW });

    expect(catalog.models[0]?.quantizations[0]?.diskBytes).toBe(2_000_000_000);
    expect(catalog.models[0]?.quantizations[1]?.diskBytes).toBe(3_000); // untouched
  });

  it("keeps committed data when the fetch fails", async () => {
    const fetch: FetchLike = vi.fn(async () => {
      throw new Error("network down");
    });
    const { catalog, updated } = await refreshCatalogQuants(catalogOf([model()]), {
      fetch,
      registryBase: BASE,
      now: NOW,
    });
    expect(updated).toEqual([]);
    expect(catalog.models[0]?.quantizations[0]?.diskBytes).toBe(1_000);
  });

  it("keeps committed data when the manifest lacks a model layer", async () => {
    const fetch: FetchLike = vi.fn(async () =>
      jsonResponse({
        layers: [
          { mediaType: "application/vnd.ollama.image.license", digest: `sha256:${SHA}`, size: 10 },
        ],
      }),
    );
    const { updated } = await refreshCatalogQuants(catalogOf([model()]), {
      fetch,
      registryBase: BASE,
      now: NOW,
    });
    expect(updated).toEqual([]);
  });

  it("does not fetch models that have no ollama source", async () => {
    const fetch: FetchLike = vi.fn(async () => jsonResponse(manifest(2_000, SHA)));
    const hfOnly = model({ id: "kimi", source: { hf: "moonshotai/Kimi" } } as Partial<CatalogModel>);
    const { catalog, updated } = await refreshCatalogQuants(catalogOf([hfOnly]), {
      fetch,
      registryBase: BASE,
      now: NOW,
    });
    expect(updated).toEqual([]);
    expect(catalog.models[0]).toEqual(hfOnly);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a non-2xx manifest response", async () => {
    const fetch: FetchLike = vi.fn(async () => jsonResponse({}, { ok: false, status: 404 }));
    const { updated } = await refreshCatalogQuants(catalogOf([model()]), {
      fetch,
      registryBase: BASE,
      now: NOW,
    });
    expect(updated).toEqual([]);
  });
});
