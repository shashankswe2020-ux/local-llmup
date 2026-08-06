import { describe, expect, it } from "vitest";
import { loadPerf } from "../../src/advisor/perf-data.js";
import { evaluateVerdict } from "../../src/advisor/verdict.js";
import { COMFORT_FLOOR } from "../../src/advisor/weights.js";
import type {
  CatalogModel,
  HardwareProfile,
  ModelArchitecture,
  Quantization,
} from "../../src/types.js";

const GIB = 1024 ** 3;
const perf = loadPerf();

function hw(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 64 * GIB,
    freeRamBytes: 60 * GIB,
    gpu: [{ vendor: "nvidia", vramBytes: 24 * GIB }],
    freeDiskBytes: 500 * GIB,
    ...overrides,
  };
}

function quant(name = "Q4_K_M", diskBytes = 4_400_000_000): Quantization {
  return { name, diskBytes, minRamBytes: diskBytes, minVramBytes: diskBytes };
}

function model(
  params: string,
  quants: readonly Quantization[] = [quant()],
  architecture: ModelArchitecture = "dense",
  activeParams?: string,
): CatalogModel {
  return {
    id: `test-${params}`,
    family: "test",
    params,
    architecture,
    ...(activeParams !== undefined ? { activeParams } : {}),
    license: "apache-2.0",
    openWeight: true,
    contextLength: 4096,
    capabilities: ["chat"],
    releaseDate: "2024-01-01",
    source: { ollama: "test" },
    quantizations: quants,
  };
}

describe("evaluateVerdict", () => {
  it("returns `no` with a vram-bound reason when the model does not fit VRAM", () => {
    const v = evaluateVerdict(model("70B"), hw({ gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }] }), perf);
    expect(v.runnable).toBe("no");
    expect(v.reason).toBe("vram-bound");
    expect(v.throughput.known).toBe(false);
  });

  it("returns `no` with a disk-bound reason when memory fits but disk does not", () => {
    const v = evaluateVerdict(model("7B"), hw({ freeDiskBytes: 1_000_000_000 }), perf);
    expect(v.runnable).toBe("no");
    expect(v.reason).toBe("disk-bound");
  });

  it("returns `yes` when the model fits and estimated throughput clears the floor", () => {
    const v = evaluateVerdict(model("7B"), hw(), perf);
    expect(v.runnable).toBe("yes");
    expect(v.throughput.known).toBe(true);
    expect(v.quant?.name).toBe("Q4_K_M");
    // Sanity: a 7B on an RTX 4090-class card is comfortably above the floor.
    const mid = (v.throughput.lowTokPerSec + v.throughput.highTokPerSec) / 2;
    expect(mid).toBeGreaterThanOrEqual(COMFORT_FLOOR);
  });

  it("returns `slow` when the model fits but estimated throughput is below the floor", () => {
    // 13B on a CPU-only box: fits in RAM, but decode is well under the floor.
    const v = evaluateVerdict(model("13B", [quant("Q4_K_M", 7_900_000_000)]), hw({ gpu: [] }), perf);
    expect(v.runnable).toBe("slow");
    expect(v.throughput.known).toBe(true);
    const mid = (v.throughput.lowTokPerSec + v.throughput.highTokPerSec) / 2;
    expect(mid).toBeLessThan(COMFORT_FLOOR);
  });

  it("downgrades `yes` to `slow` when the model fits but throughput is unknown (honesty gate)", () => {
    // AMD GPU has no perf profile → throughput unknown → cannot claim `yes`.
    const v = evaluateVerdict(model("7B"), hw({ gpu: [{ vendor: "amd", vramBytes: 16 * GIB }] }), perf);
    expect(v.runnable).toBe("slow");
    expect(v.throughput.known).toBe(false);
    expect(v.quant?.name).toBe("Q4_K_M");
  });

  it("is pure — identical inputs yield an identical verdict", () => {
    expect(evaluateVerdict(model("7B"), hw(), perf)).toEqual(evaluateVerdict(model("7B"), hw(), perf));
  });
});

describe("evaluateVerdict with an explicit context", () => {
  function ctxModel(kvBytesPerToken?: number, contextLength = 131072): CatalogModel {
    return {
      ...model("7B"),
      contextLength,
      ...(kvBytesPerToken !== undefined ? { kvBytesPerToken } : {}),
    };
  }

  it("returns `no` context-bound when the requested context exceeds the model cap", () => {
    const v = evaluateVerdict(ctxModel(131072, 8192), hw(), perf, 16384);
    expect(v.runnable).toBe("no");
    expect(v.reason).toBe("context-bound");
    expect(v.throughput.known).toBe(false);
  });

  it("returns `no` with a memory reason when the KV cache overflows the pool", () => {
    // 128K KV cache (~17 GB) on an 8 GB card: memory-bound, not context-bound.
    const v = evaluateVerdict(
      ctxModel(131072),
      hw({ gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }] }),
      perf,
      131072,
    );
    expect(v.runnable).toBe("no");
    expect(v.reason).toBe("vram-bound");
  });

  it("leaves throughput unaffected by context in v1 (same as the no-context verdict)", () => {
    const withCtx = evaluateVerdict(ctxModel(8192), hw(), perf, 4096);
    const without = evaluateVerdict(ctxModel(8192), hw(), perf);
    expect(withCtx.throughput).toEqual(without.throughput);
    expect(withCtx.quant?.name).toBe(without.quant?.name);
  });

  it("still verdicts an unknown-geometry model by weights under a context request", () => {
    const v = evaluateVerdict(ctxModel(undefined), hw(), perf, 65536);
    expect(v.runnable).toBe("yes");
    expect(v.throughput.known).toBe(true);
  });
});
