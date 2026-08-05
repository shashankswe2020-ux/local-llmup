import { describe, expect, it, vi } from "vitest";
import {
  enrichCatalog,
  fetchRegistryJson,
  parseRawRegistryModels,
  type FetchResponseLike,
} from "../../src/catalog/enrich.js";
import { CatalogModelSchema } from "../../src/catalog/schema.js";
import { CatalogError, ValidationError } from "../../src/errors.js";
import type { Catalog } from "../../src/types.js";
import { denseModel, moeModel } from "./fixtures.js";
import { emptyCatalog, rawDense, rawMoe } from "./registry-fixtures.js";

const NOW = new Date("2026-08-05T00:00:00Z");

function response(
  body: unknown,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): FetchResponseLike {
  const headers = init.headers ?? {};
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe("fetchRegistryJson (allow-listed fetch)", () => {
  it("refuses a non-allow-listed host without invoking fetch", async () => {
    const fetchSpy = vi.fn();
    await expect(
      fetchRegistryJson("https://evil.example.com/models", { fetch: fetchSpy }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws a CatalogError on a non-2xx response", async () => {
    const fetchSpy = vi.fn(async () => response(null, { ok: false, status: 503 }));
    await expect(
      fetchRegistryJson("https://huggingface.co/api/models", { fetch: fetchSpy }),
    ).rejects.toBeInstanceOf(CatalogError);
  });

  it("returns parsed JSON for an allow-listed host", async () => {
    const payload = { models: [{ id: "x" }] };
    const fetchSpy = vi.fn(async () => response(payload));
    const out = await fetchRegistryJson("https://registry.ollama.ai/v2/library", {
      fetch: fetchSpy,
    });
    expect(out).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("re-validates redirect targets and refuses a hop to a private host", async () => {
    const fetchSpy = vi.fn(async () =>
      response(null, { status: 302, headers: { location: "https://localhost/secret" } }),
    );
    await expect(
      fetchRegistryJson("https://huggingface.co/api/models", { fetch: fetchSpy }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("follows a redirect to an allow-listed host", async () => {
    const fetchSpy = vi
      .fn<(url: string) => Promise<FetchResponseLike>>()
      .mockResolvedValueOnce(
        response(null, { status: 302, headers: { location: "https://registry.ollama.ai/v2/x" } }),
      )
      .mockResolvedValueOnce(response({ ok: 1 }));
    const out = await fetchRegistryJson("https://huggingface.co/api/models", { fetch: fetchSpy });
    expect(out).toEqual({ ok: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects a response whose declared Content-Length exceeds the cap", async () => {
    const fetchSpy = vi.fn(async () =>
      response({}, { headers: { "content-length": String(64 * 1024 * 1024) } }),
    );
    await expect(
      fetchRegistryJson("https://huggingface.co/api/models", { fetch: fetchSpy }),
    ).rejects.toBeInstanceOf(CatalogError);
  });
});

describe("parseRawRegistryModels (payload boundary)", () => {
  it("parses a well-formed registry payload", () => {
    const parsed = parseRawRegistryModels([rawDense()]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("llama3.1:8b");
  });

  it("fails closed on a shape-malformed payload", () => {
    expect(() => parseRawRegistryModels([{ id: "x", quantizations: "nope" }])).toThrow(CatalogError);
  });
});

describe("enrichCatalog — sizing + license gate", () => {
  it("adds new candidates, sizing each quant via the shared memory-math formula", () => {
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense()],
      now: NOW,
    });

    expect(diff.added).toEqual(["llama3.1:8b"]);
    const model = catalog.models[0];
    expect(model).toBeDefined();
    const quant = model?.quantizations[0];
    expect(quant).toBeDefined();
    // Formula: resident (>= disk) + 15% overhead, so strictly above disk bytes.
    expect(quant?.minRamBytes).toBeGreaterThan(4_900_000_000);
    expect(quant?.minVramBytes).toBe(quant?.minRamBytes);
    expect(Number.isInteger(quant?.minRamBytes)).toBe(true);
    // The built entry must satisfy the runtime catalog schema.
    expect(() => CatalogModelSchema.parse(model)).not.toThrow();
    expect(catalog.generatedAt).toBe(NOW.toISOString());
  });

  it("gates out a candidate whose license is not open-weight allow-listed", () => {
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense(), rawDense({ id: "closed:1", license: "proprietary-eula" })],
      now: NOW,
    });
    expect(diff.added).toEqual(["llama3.1:8b"]);
    expect(diff.skipped).toContain("closed:1");
    expect(catalog.models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
  });

  it("gates out a gated/closed model even with an allow-listed license", () => {
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense(), rawDense({ id: "gated:1", openWeight: false })],
      now: NOW,
    });
    expect(diff.skipped).toContain("gated:1");
    expect(catalog.models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
  });

  it("rejects a future-dated release", () => {
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense(), rawDense({ id: "future:1", releaseDate: "9999-12-31" })],
      now: NOW,
    });
    expect(diff.skipped).toContain("future:1");
    expect(catalog.models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
  });
});

describe("enrichCatalog — incremental mode", () => {
  it("considers only candidates newer than the catalog and never re-seeds existing", () => {
    const existing: Catalog = {
      schemaVersion: 2,
      generatedAt: "2025-08-01T00:00:00Z",
      models: [denseModel, moeModel], // newest releaseDate = 2025-07-11
    };
    const fresh = rawDense({ id: "new-model:8b", releaseDate: "2025-12-01" });
    const stale = rawDense({ id: "old-model:8b", releaseDate: "2023-01-01" });
    const reseed = rawDense({ id: denseModel.id, contextLength: 999 });

    const { catalog, diff } = enrichCatalog({
      mode: "incremental",
      existing,
      candidates: [fresh, stale, reseed],
      now: NOW,
    });

    expect(diff.added).toEqual(["new-model:8b"]);
    expect(diff.updated).toEqual([]);
    // Existing dense entry is untouched (not re-seeded to contextLength 999).
    const dense = catalog.models.find((m) => m.id === denseModel.id);
    expect(dense?.contextLength).toBe(denseModel.contextLength);
    expect(catalog.models.map((m) => m.id)).not.toContain("old-model:8b");
  });
});

describe("enrichCatalog — merge-by-id reconciliation", () => {
  it("is idempotent: a second backfill run on the same inputs produces no diff", () => {
    const first = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense(), rawMoe()],
      now: NOW,
    });
    const second = enrichCatalog({
      mode: "backfill",
      existing: first.catalog,
      candidates: [rawDense(), rawMoe()],
      now: NOW,
    });
    expect(second.diff.added).toEqual([]);
    expect(second.diff.updated).toEqual([]);
    expect(second.diff.removed).toEqual([]);
    expect(second.catalog.models).toEqual(first.catalog.models);
    // No-op run preserves the prior timestamp → byte-identical on disk.
    expect(second.catalog.generatedAt).toBe(first.catalog.generatedAt);
  });

  it("preserves a curated field across an upstream change to a derived field", () => {
    const existing: Catalog = {
      schemaVersion: 2,
      generatedAt: "2025-01-01T00:00:00Z",
      models: [{ ...denseModel, benchmarkProxy: 0.71 }],
    };
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing,
      candidates: [rawDense({ contextLength: 262144 })],
      now: NOW,
    });
    expect(diff.updated).toEqual([denseModel.id]);
    const merged = catalog.models.find((m) => m.id === denseModel.id);
    expect(merged?.contextLength).toBe(262144); // derived field updated
    expect(merged?.benchmarkProxy).toBe(0.71); // curated field preserved
  });

  it("drops a half-formed new entry while still adding the valid ones", () => {
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense(), rawMoe({ id: "broken:1", params: "not-a-size" })],
      now: NOW,
    });
    expect(diff.added).toEqual(["llama3.1:8b"]);
    expect(diff.skipped).toContain("broken:1");
    expect(catalog.models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
  });

  it("keeps prior data when an existing entry's upstream update is half-formed", () => {
    const existing: Catalog = {
      schemaVersion: 2,
      generatedAt: "2025-01-01T00:00:00Z",
      models: [denseModel],
    };
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing,
      candidates: [rawDense({ params: "not-a-size" })],
      now: NOW,
    });
    expect(diff.updated).toEqual([]);
    expect(diff.skipped).toContain(denseModel.id);
    // Prior, valid entry is retained untouched.
    expect(catalog.models.find((m) => m.id === denseModel.id)).toEqual(denseModel);
  });

  it("removes an existing entry when its license transitions to non-open-weight", () => {
    const existing: Catalog = {
      schemaVersion: 2,
      generatedAt: "2025-01-01T00:00:00Z",
      models: [denseModel, moeModel],
    };
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing,
      candidates: [rawDense({ license: "proprietary-eula" }), rawMoe()],
      now: NOW,
    });
    expect(diff.removed).toEqual([denseModel.id]);
    expect(catalog.models.map((m) => m.id)).not.toContain(denseModel.id);
    expect(catalog.models.map((m) => m.id)).toContain(moeModel.id);
  });

  it("enforces the size cap, dropping the lowest-priority entries deterministically", () => {
    const a = rawDense({ id: "a:1", releaseDate: "2024-01-01" });
    const b = rawDense({ id: "b:1", releaseDate: "2025-01-01" });
    const c = rawDense({ id: "c:1", releaseDate: "2026-01-01" });
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [a, b, c],
      now: NOW,
      maxModels: 2,
    });
    expect(catalog.models).toHaveLength(2);
    // Newest two retained; oldest dropped and reported.
    expect(catalog.models.map((m) => m.id).sort()).toEqual(["b:1", "c:1"]);
    expect(diff.capped).toEqual(["a:1"]);
  });

  it("collapses duplicate ids in one batch (last occurrence wins)", () => {
    const { catalog, diff } = enrichCatalog({
      mode: "backfill",
      existing: emptyCatalog(),
      candidates: [rawDense({ contextLength: 100 }), rawDense({ contextLength: 200 })],
      now: NOW,
    });
    expect(diff.added).toEqual(["llama3.1:8b"]);
    expect(diff.updated).toEqual([]);
    const model = catalog.models.find((m) => m.id === "llama3.1:8b");
    expect(model?.contextLength).toBe(200);
  });

  it("removes a license-revoked existing entry even in incremental mode", () => {
    const existing: Catalog = {
      schemaVersion: 2,
      generatedAt: "2025-08-01T00:00:00Z",
      models: [denseModel, moeModel],
    };
    const { catalog, diff } = enrichCatalog({
      mode: "incremental",
      existing,
      candidates: [rawDense({ license: "proprietary-eula" })],
      now: NOW,
    });
    expect(diff.removed).toEqual([denseModel.id]);
    expect(catalog.models.map((m) => m.id)).not.toContain(denseModel.id);
    expect(catalog.models.map((m) => m.id)).toContain(moeModel.id);
  });

  it("rejects a non-positive size cap", () => {
    expect(() =>
      enrichCatalog({
        mode: "backfill",
        existing: emptyCatalog(),
        candidates: [rawDense()],
        now: NOW,
        maxModels: 0,
      }),
    ).toThrow(ValidationError);
  });
});
