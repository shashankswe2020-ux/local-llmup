import { describe, expect, it, vi } from "vitest";
import { runCatalog, type CatalogDeps } from "../../src/commands/catalog.js";
import type { Catalog, CatalogModel, HardwareProfile, Quantization } from "../../src/types.js";
import type { RawRegistryModel } from "../../src/catalog/enrich.js";
import { createDefaultRegistry } from "../../src/backend/registry.js";
import { requiredMemoryBytes } from "../../src/hardware/memory-math.js";
import {
  expectNoninteractiveGolden,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";

const GiB = 1024 ** 3;

function quant(name: string, gib: number): Quantization {
  const bytes = gib * GiB;
  return { name, diskBytes: bytes, minRamBytes: bytes, minVramBytes: bytes };
}

function model(
  id: string,
  params: string,
  quants: readonly Quantization[],
  overrides: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    id,
    family: id.split(":")[0] ?? id,
    params,
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 8192,
    capabilities: ["chat"],
    releaseDate: "2025-01-01",
    source: { ollama: id },
    quantizations: quants,
    ...overrides,
  };
}

function hardware(totalRamGiB: number): HardwareProfile {
  return {
    arch: "arm64",
    platform: "darwin",
    totalRamBytes: totalRamGiB * GiB,
    freeRamBytes: totalRamGiB * GiB,
    gpu: [{ vendor: "apple", vramBytes: 0 }],
    freeDiskBytes: 500 * GiB,
  };
}

const CATALOG: Catalog = {
  schemaVersion: 2,
  generatedAt: "2026-08-04T00:00:00.000Z",
  models: [
    model("llama3.1:8b", "8B", [quant("Q4_K_M", 6)], { releaseDate: "2025-07-23" }),
    model("kimi-k2:instruct", "1T", [quant("Q4_K_M", 620)], {
      architecture: "moe",
      activeParams: "32B",
      license: "modified-mit",
      capabilities: ["chat", "reasoning"],
      releaseDate: "2025-07-11",
    }),
  ],
};

function baseDeps(overrides: Partial<CatalogDeps> = {}): { deps: CatalogDeps; stdout: string[] } {
  const stdout: string[] = [];
  const deps: CatalogDeps = {
    loadCatalog: () => CATALOG,
    detectHardware: async () => hardware(32),
    loadCandidates: () => [] as readonly RawRegistryModel[],
    enrichCatalog: vi.fn(() => ({
      catalog: CATALOG,
      diff: { added: [], updated: [], removed: [], skipped: [], capped: [] },
    })),
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    registry: createDefaultRegistry(),
    write: (text) => stdout.push(text),
    ...overrides,
  };
  return { deps, stdout };
}

describe("runCatalog", () => {
  it("shows only fitting models by default", async () => {
    const { deps, stdout } = baseDeps();

    const result = await withGoldenEnvironment(() => runCatalog({}, deps));

    const out = stdout.join("");
    expectNoninteractiveGolden(plainGoldenName("catalog"), out);
    expect(result).toMatchObject({
      filter: "fits",
      total: 2,
      refresh: null,
      emptyReason: null,
    });
    expect(result.rows.map((row) => row.model.id)).toEqual(["llama3.1:8b"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0]?.model)).toBe(true);
    expect(out).toContain("llama3.1:8b");
    expect(out).not.toContain("kimi-k2:instruct");
    expect(out).toContain("Filter: fits");
  });

  it("shows all models when --all is enabled", async () => {
    const { deps, stdout } = baseDeps();

    const result = await runCatalog({ all: true }, deps);

    const out = stdout.join("");
    expect(out).toContain("llama3.1:8b");
    expect(out).toContain("kimi-k2:instruct");
    expect(out).toContain("Filter: all");
    expect(out).toContain("ram-bound");
    expect(result.rows.map((row) => row.fit)).toEqual(["fit", "ram-bound"]);
  });

  it("reports the evaluated memory requirement for a VRAM-bound row", async () => {
    const discreteGpu: HardwareProfile = {
      arch: "x64",
      platform: "linux",
      totalRamBytes: 128 * GiB,
      freeRamBytes: 100 * GiB,
      gpu: [{ vendor: "nvidia", vramBytes: 8 * GiB }],
      freeDiskBytes: 500 * GiB,
    };
    const gpuQuant: Quantization = {
      name: "Q4_K_M",
      diskBytes: 5 * GiB,
      minRamBytes: 6 * GiB,
      minVramBytes: 12 * GiB,
    };
    const gpuModel = model("gpu:model", "20B", [gpuQuant]);
    const gpuCatalog: Catalog = {
      schemaVersion: 2,
      generatedAt: "2026-08-04T00:00:00.000Z",
      models: [gpuModel],
    };
    const { deps } = baseDeps({
      loadCatalog: () => gpuCatalog,
      detectHardware: async () => discreteGpu,
    });

    const result = await runCatalog({ all: true }, deps);

    expect(result.rows[0]).toMatchObject({
      fit: "vram-bound",
      requiredBytes: requiredMemoryBytes(gpuModel, gpuQuant),
    });
  });

  it("renders a stable header and deterministic row order (release desc, id asc tie-break)", async () => {
    const orderedCatalog: Catalog = {
      schemaVersion: 2,
      generatedAt: "2026-08-04T00:00:00.000Z",
      models: [
        model("zeta:8b", "8B", [quant("Q4_K_M", 6)], { releaseDate: "2026-01-01" }),
        model("alpha:8b", "8B", [quant("Q4_K_M", 6)], { releaseDate: "2026-01-01" }),
        model("mid:8b", "8B", [quant("Q4_K_M", 6)], { releaseDate: "2025-01-01" }),
      ],
    };
    const { deps, stdout } = baseDeps({ loadCatalog: () => orderedCatalog });

    await runCatalog({ all: true }, deps);

    const out = stdout.join("");
    expect(out).toContain("Catalog (Filter: all, shown: 3/3)");
    const lines = out
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const rows = lines.filter(
      (line) =>
        line.startsWith("alpha:8b") || line.startsWith("zeta:8b") || line.startsWith("mid:8b"),
    );
    expect(rows).toEqual([
      expect.stringMatching(/^alpha:8b\s+/u),
      expect.stringMatching(/^zeta:8b\s+/u),
      expect.stringMatching(/^mid:8b\s+/u),
    ]);
  });

  it("runs incremental enrich in dry-run mode and reports diff without writing catalog", async () => {
    const refreshCatalog: Catalog = {
      ...CATALOG,
      models: [
        ...CATALOG.models,
        model("qwen3:8b", "8B", [quant("Q4_K_M", 7)], { releaseDate: "2026-07-01" }),
      ],
    };
    const enrichSpy = vi.fn(() => ({
      catalog: refreshCatalog,
      diff: {
        added: ["qwen3:8b"],
        updated: [],
        removed: [],
        skipped: ["closed:1"],
        capped: [],
      },
    }));
    const candidates: readonly RawRegistryModel[] = [
      {
        id: "qwen3:8b",
        family: "qwen3",
        params: "8B",
        architecture: "dense",
        license: "qwen",
        openWeight: true,
        contextLength: 131072,
        capabilities: ["chat"],
        releaseDate: "2026-07-01",
        source: { ollama: "qwen3:8b" },
        quantizations: [{ name: "Q4_K_M", diskBytes: 7 * GiB }],
      },
    ];

    const { deps, stdout } = baseDeps({
      loadCandidates: () => candidates,
      enrichCatalog: enrichSpy,
    });

    await runCatalog({ refresh: true, all: true }, deps);

    expect(enrichSpy).toHaveBeenCalledOnce();
    expect(enrichSpy).toHaveBeenCalledWith({
      mode: "incremental",
      existing: CATALOG,
      candidates,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });
    const out = stdout.join("");
    expect(out).toContain("Refresh (dry-run)");
    expect(out).toContain("added: 1");
    expect(out).toContain("qwen3:8b");
    expect(out).toContain("No catalog file was written");
  });
});
