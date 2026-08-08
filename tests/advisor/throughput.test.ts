import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPerf, parsePerf } from "../../src/advisor/perf-data.js";
import { estimateTokPerSec } from "../../src/advisor/throughput.js";
import { requiredMemoryBytes } from "../../src/hardware/memory-math.js";
import type {
  Arch,
  CatalogModel,
  GpuInfo,
  HardwareProfile,
  ModelArchitecture,
  Platform,
  Quantization,
} from "../../src/types.js";

const GIB = 1024 ** 3;

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
    quantizations: [quant()],
  };
}

const perf = loadPerf();

describe("estimateTokPerSec — structure & honesty", () => {
  it("is pure — identical inputs yield an identical estimate", () => {
    const a = estimateTokPerSec(model("7B"), quant(), hw(), perf);
    const b = estimateTokPerSec(model("7B"), quant(), hw(), perf);
    expect(a).toEqual(b);
  });

  it("returns a positive range with known=true for matched hardware", () => {
    const est = estimateTokPerSec(model("7B"), quant(), hw(), perf);
    expect(est.known).toBe(true);
    expect(est.lowTokPerSec).toBeGreaterThan(0);
    expect(est.highTokPerSec).toBeGreaterThan(est.lowTokPerSec);
  });

  it("applies a ±30% band around the point estimate by default", () => {
    const est = estimateTokPerSec(model("7B"), quant(), hw(), perf);
    // low = point*0.7, high = point*1.3 → high/low = 1.3/0.7 ≈ 1.857
    expect(est.highTokPerSec / est.lowTokPerSec).toBeCloseTo(1.3 / 0.7, 2);
  });

  it("honesty gate: unmatched hardware → known=false with no number (AC7)", () => {
    const amd = estimateTokPerSec(
      model("7B"),
      quant(),
      hw({ gpu: [{ vendor: "amd", vramBytes: 16 * GIB }] }),
      perf,
    );
    expect(amd.known).toBe(false);
    expect(amd.lowTokPerSec).toBe(0);
    expect(amd.highTokPerSec).toBe(0);

    const oversized = estimateTokPerSec(
      model("7B"),
      quant(),
      hw({ gpu: [{ vendor: "nvidia", vramBytes: 48 * GIB }] }),
      perf,
    );
    expect(oversized.known).toBe(false);
  });

  it("MoE decode uses ACTIVE params while footprint uses TOTAL (AC8)", () => {
    const unified = hw({
      arch: "arm64" as Arch,
      platform: "darwin" as Platform,
      gpu: [{ vendor: "apple", vramBytes: 0 } as GpuInfo],
      totalRamBytes: 128 * GIB,
    });
    const moe = model("47B", "moe", "13B");
    const denseActive = model("13B");
    const denseTotal = model("47B");

    const moeEst = estimateTokPerSec(moe, quant(), unified, perf);
    const denseActiveEst = estimateTokPerSec(denseActive, quant(), unified, perf);
    const denseTotalEst = estimateTokPerSec(denseTotal, quant(), unified, perf);

    // Decode speed is driven by the ACTIVE set: MoE matches a dense model of its
    // active size, not its total size.
    expect(moeEst.lowTokPerSec).toBeCloseTo(denseActiveEst.lowTokPerSec, 5);
    expect(moeEst.highTokPerSec).toBeCloseTo(denseActiveEst.highTokPerSec, 5);
    // …and is therefore much faster than a dense model of its TOTAL size.
    expect(moeEst.lowTokPerSec).toBeGreaterThan(denseTotalEst.highTokPerSec);

    // Memory footprint still sizes by TOTAL params (all experts resident).
    expect(requiredMemoryBytes(moe, quant())).toBeGreaterThan(
      requiredMemoryBytes(denseActive, quant()),
    );
  });
});

interface CalibrationCase {
  readonly label: string;
  readonly arch: Arch;
  readonly platform: Platform;
  readonly gpu: readonly GpuInfo[];
  readonly totalRamBytes: number;
  readonly params: string;
  readonly architecture: ModelArchitecture;
  readonly activeParams?: string;
  readonly quant: string;
  readonly diskBytes: number;
  readonly publishedTokPerSec: number;
  readonly source: string;
}

const CALIBRATION: readonly CalibrationCase[] = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/calibration.json"),
    "utf8",
  ),
) as CalibrationCase[];

describe("estimateTokPerSec — per-backend efficiency resolution (B9)", () => {
  const nvidiaHw = hw({
    gpu: [{ vendor: "nvidia", vramBytes: 24 * GIB }],
    totalRamBytes: 64 * GIB,
  });

  function datasetWith(efficiencyByBackend?: Record<string, number>): ReturnType<typeof loadPerf> {
    const cls: Record<string, unknown> = {
      id: "nvidia-24gb-class",
      label: "NVIDIA 24GB class",
      vendor: "nvidia",
      kind: "discrete",
      memBandwidthGBps: 950,
      efficiency: 0.68,
      minBytes: 20 * GIB,
      maxBytes: 28 * GIB,
      sources: { bandwidth: "vendor spec sheet", efficiency: "llama.cpp decode benchmark" },
    };
    if (efficiencyByBackend !== undefined) {
      cls["efficiencyByBackend"] = efficiencyByBackend;
      cls["sources"] = {
        bandwidth: "vendor spec sheet",
        efficiency: "llama.cpp decode benchmark",
        efficiencyByBackend: Object.fromEntries(
          Object.entries(efficiencyByBackend).map(([backend, value]) => [
            backend,
            {
              value,
              trustTier: "session-verified",
              basisBytesPerToken: 4.4e9,
              url: "https://github.com/ggml-org/llama.cpp/discussions/4167",
            },
          ]),
        ),
      };
    }
    return parsePerf(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-08-06T00:00:00Z",
        classes: [cls],
      }),
    );
  }

  it("defaults to ollama, identical to passing backend:'ollama'", () => {
    const ds = datasetWith();
    const bare = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds);
    const explicit = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "ollama" });
    expect(bare).toEqual(explicit);
  });

  it("llamacpp shares the class efficiency when it has no explicit scalar", () => {
    const ds = datasetWith();
    const ollama = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "ollama" });
    const llamacpp = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "llamacpp" });
    expect(llamacpp).toEqual(ollama);
  });

  it("mlx with no scalar is honesty-gated to known:false", () => {
    const ds = datasetWith();
    const mlx = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "mlx" });
    expect(mlx.known).toBe(false);
    expect(mlx.lowTokPerSec).toBe(0);
    expect(mlx.highTokPerSec).toBe(0);
  });

  it("uses an explicit per-backend scalar when present", () => {
    const ds = datasetWith({ mlx: 0.5 });
    const mlx = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "mlx" });
    const ollama = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "ollama" });
    expect(mlx.known).toBe(true);
    // 0.5/0.68 of the ollama estimate (same bandwidth & bytes/token).
    expect(mlx.lowTokPerSec).toBeCloseTo(ollama.lowTokPerSec * (0.5 / 0.68), 1);
  });

  it("an explicit scalar overrides the shared class efficiency", () => {
    const ds = datasetWith({ llamacpp: 0.9 });
    const shared = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, { backend: "ollama" });
    const overridden = estimateTokPerSec(model("7B"), quant(), nvidiaHw, ds, {
      backend: "llamacpp",
    });
    expect(overridden.lowTokPerSec).toBeGreaterThan(shared.lowTokPerSec);
  });
});

describe("estimateTokPerSec — calibration (AC6)", () => {
  it("contains the published throughput for ≥80% of curated pairs", () => {
    const misses: string[] = [];
    for (const c of CALIBRATION) {
      const profile = hw({
        arch: c.arch,
        platform: c.platform,
        gpu: c.gpu,
        totalRamBytes: c.totalRamBytes,
      });
      const est = estimateTokPerSec(
        model(c.params, c.architecture, c.activeParams),
        quant(c.quant, c.diskBytes),
        profile,
        perf,
      );
      const contained =
        est.known &&
        c.publishedTokPerSec >= est.lowTokPerSec &&
        c.publishedTokPerSec <= est.highTokPerSec;
      if (!contained) {
        misses.push(
          `${c.label}: published ${c.publishedTokPerSec}, got [${est.lowTokPerSec}, ${est.highTokPerSec}]`,
        );
      }
    }
    const ratio = (CALIBRATION.length - misses.length) / CALIBRATION.length;
    expect(ratio, `misses: ${misses.join("; ")}`).toBeGreaterThanOrEqual(0.8);
  });
});
