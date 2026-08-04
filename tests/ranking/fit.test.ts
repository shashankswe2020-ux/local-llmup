import { describe, expect, it } from "vitest";
import { evaluateFit } from "../../src/ranking/fit.js";
import { requiredMemoryBytes } from "../../src/hardware/memory-math.js";
import { HEADROOM } from "../../src/ranking/weights.js";
import type { CatalogModel, HardwareProfile, Quantization } from "../../src/types.js";

const GIB = 1024 ** 3;

const Q4: Quantization = {
  name: "Q4_K_M",
  diskBytes: 4_900_000_000,
  minRamBytes: 6_500_000_000,
  minVramBytes: 6_000_000_000,
};
const Q8: Quantization = {
  name: "Q8_0",
  diskBytes: 8_500_000_000,
  minRamBytes: 10_000_000_000,
  minVramBytes: 9_500_000_000,
};

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
    quantizations: [Q4, Q8],
    ...overrides,
  };
}

function gpuHw(vramBytes: number, freeDiskBytes = 1_000 * GIB): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 64 * GIB,
    freeRamBytes: 64 * GIB,
    gpu: [{ vendor: "nvidia", vramBytes }],
    freeDiskBytes,
  };
}

function cpuHw(freeRamBytes: number, freeDiskBytes = 1_000 * GIB): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: freeRamBytes + 4 * GIB,
    freeRamBytes,
    gpu: [],
    freeDiskBytes,
  };
}

describe("evaluateFit", () => {
  it("selects the highest-quality quant that fits", () => {
    const result = evaluateFit(model(), gpuHw(16 * GIB));
    expect(result.fits).toBe(true);
    if (result.fits) expect(result.quant.name).toBe("Q8_0"); // larger quant preferred
  });

  it("falls back to a smaller quant when the best one does not fit", () => {
    // Enough VRAM for Q4 but not Q8.
    const result = evaluateFit(model(), gpuHw(7 * GIB));
    expect(result.fits).toBe(true);
    if (result.fits) expect(result.quant.name).toBe("Q4_K_M");
  });

  it("excludes kimi-k2 as ram-bound on consumer hardware", () => {
    const kimi = model({
      id: "kimi-k2:instruct",
      family: "kimi-k2",
      params: "1T",
      architecture: "moe",
      activeParams: "32B",
      quantizations: [
        { name: "Q4_K_M", diskBytes: 600 * GIB, minRamBytes: 620 * GIB, minVramBytes: 600 * GIB },
      ],
    });
    const result = evaluateFit(kimi, cpuHw(32 * GIB));
    expect(result.fits).toBe(false);
    if (!result.fits) expect(result.reason).toBe("ram-bound");
  });

  it("sizes a MoE by TOTAL params: fits by active set but not total → ram-bound", () => {
    // diskBytes here is active-set-sized (~32B); the total-param floor (1T) wins.
    const moe = model({
      id: "kimi-mini:instruct",
      family: "kimi-mini",
      params: "1T",
      architecture: "moe",
      activeParams: "32B",
      quantizations: [
        { name: "Q4_K_M", diskBytes: 20 * GIB, minRamBytes: 22 * GIB, minVramBytes: 20 * GIB },
      ],
    });
    // 40 GiB RAM would fit a real 32B model, but not the 1T total footprint.
    const result = evaluateFit(moe, cpuHw(40 * GIB));
    expect(result.fits).toBe(false);
    if (!result.fits) expect(result.reason).toBe("ram-bound");
  });

  it("reports vram-bound when no quant fits the discrete VRAM pool", () => {
    const result = evaluateFit(model(), gpuHw(6 * GIB));
    expect(result.fits).toBe(false);
    if (!result.fits) expect(result.reason).toBe("vram-bound");
  });

  it("reports disk-bound when memory fits but the weights will not download", () => {
    // Plenty of VRAM, but only 1 GiB free disk vs a 4.9 GB Q4 weight file.
    const result = evaluateFit(model({ quantizations: [Q4] }), gpuHw(16 * GIB, 1 * GIB));
    expect(result.fits).toBe(false);
    if (!result.fits) expect(result.reason).toBe("disk-bound");
  });

  it("treats the headroom threshold as inclusive (exactly-fits) and rejects one byte over", () => {
    const single = model({ quantizations: [Q4] });
    const required = requiredMemoryBytes(single, Q4);
    const exactly = Math.ceil(required / (1 - HEADROOM));
    const justUnder = Math.floor((required - 1) / (1 - HEADROOM));

    expect(evaluateFit(single, gpuHw(exactly)).fits).toBe(true);

    const tooSmall = evaluateFit(single, gpuHw(justUnder));
    expect(tooSmall.fits).toBe(false);
    if (!tooSmall.fits) expect(tooSmall.reason).toBe("vram-bound");
  });
});
