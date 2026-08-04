import { describe, expect, it } from "vitest";
import {
  parseParamCount,
  requiredMemoryBytes,
  usableMemoryBytes,
} from "../../src/hardware/memory-math.js";
import { ValidationError } from "../../src/errors.js";
import type { CatalogModel, HardwareProfile, Quantization } from "../../src/types.js";

const GIB = 1024 ** 3;
const OS_RESERVE_BYTES = 2 * GIB;

function hw(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 32 * GIB,
    freeRamBytes: 24 * GIB,
    gpu: [],
    freeDiskBytes: 500 * GIB,
    ...overrides,
  };
}

function quant(overrides: Partial<Quantization> = {}): Quantization {
  return {
    name: "Q4_K_M",
    diskBytes: 4_900_000_000,
    minRamBytes: 6_500_000_000,
    minVramBytes: 6_000_000_000,
    ...overrides,
  };
}

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
    quantizations: [quant()],
    ...overrides,
  };
}

describe("usableMemoryBytes", () => {
  it("uses total RAM minus OS reserve on Apple unified memory", () => {
    const profile = hw({
      arch: "arm64",
      platform: "darwin",
      totalRamBytes: 16 * GIB,
      gpu: [{ vendor: "apple", vramBytes: 0 }],
    });
    expect(usableMemoryBytes(profile)).toBe(16 * GIB - OS_RESERVE_BYTES);
  });

  it("returns the single largest VRAM pool for a discrete GPU (no double count)", () => {
    const profile = hw({
      gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }],
      freeRamBytes: 64 * GIB,
    });
    // RAM must not be added to VRAM.
    expect(usableMemoryBytes(profile)).toBe(8 * GIB);
  });

  it("picks the largest single GPU across multiple, never the sum", () => {
    const profile = hw({
      gpu: [
        { vendor: "nvidia", vramBytes: 8 * GIB },
        { vendor: "nvidia", vramBytes: 12 * GIB },
      ],
    });
    expect(usableMemoryBytes(profile)).toBe(12 * GIB);
  });

  it("falls back to free RAM minus reserve when there is no GPU", () => {
    const profile = hw({ gpu: [], freeRamBytes: 10 * GIB });
    expect(usableMemoryBytes(profile)).toBe(10 * GIB - OS_RESERVE_BYTES);
  });

  it("treats a zero-VRAM integrated GPU as CPU-only (free RAM path)", () => {
    const profile = hw({ gpu: [{ vendor: "amd", vramBytes: 0 }], freeRamBytes: 9 * GIB });
    expect(usableMemoryBytes(profile)).toBe(9 * GIB - OS_RESERVE_BYTES);
  });

  it("handles the reserve boundary exactly and one byte either side", () => {
    const base = { arch: "arm64", platform: "darwin", gpu: [] } as const;
    expect(usableMemoryBytes(hw({ ...base, totalRamBytes: OS_RESERVE_BYTES }))).toBe(0);
    expect(usableMemoryBytes(hw({ ...base, totalRamBytes: OS_RESERVE_BYTES + 1 }))).toBe(1);
    expect(usableMemoryBytes(hw({ ...base, totalRamBytes: OS_RESERVE_BYTES - 1 }))).toBe(0);
  });

  it("handles the free-RAM reserve boundary on the CPU-only path", () => {
    const base = { arch: "x64", platform: "linux", gpu: [] } as const;
    expect(usableMemoryBytes(hw({ ...base, freeRamBytes: OS_RESERVE_BYTES }))).toBe(0);
    expect(usableMemoryBytes(hw({ ...base, freeRamBytes: OS_RESERVE_BYTES + 1 }))).toBe(1);
    expect(usableMemoryBytes(hw({ ...base, freeRamBytes: OS_RESERVE_BYTES - 1 }))).toBe(0);
  });

  it("reports discrete VRAM exactly, including a one-byte pool", () => {
    expect(usableMemoryBytes(hw({ gpu: [{ vendor: "nvidia", vramBytes: 1 }] }))).toBe(1);
    expect(usableMemoryBytes(hw({ gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }] }))).toBe(
      8 * GIB,
    );
  });
});

describe("requiredMemoryBytes", () => {
  it("returns weight bytes plus runtime overhead for a dense model", () => {
    const req = requiredMemoryBytes(model(), quant({ diskBytes: 4_900_000_000 }));
    expect(req).toBeGreaterThan(4_900_000_000);
    // Overhead is bounded — not an order of magnitude.
    expect(req).toBeLessThan(4_900_000_000 * 2);
  });

  it("sizes a MoE model by TOTAL params even when diskBytes was under-reported", () => {
    // diskBytes here is mistakenly sized like the 32B active set, not the 1T total.
    const moe = model({
      id: "kimi-k2:instruct",
      family: "kimi-k2",
      params: "1T",
      architecture: "moe",
      activeParams: "32B",
    });
    const req = requiredMemoryBytes(moe, quant({ diskBytes: 20 * GIB }));
    // Total-param footprint (~1T weights) dwarfs the under-reported disk size.
    expect(req).toBeGreaterThan(400 * GIB);
  });

  it("ranks a 1T MoE far above a 32B dense model with the same quant", () => {
    const moe = requiredMemoryBytes(
      model({ params: "1T", architecture: "moe", activeParams: "32B" }),
      quant({ diskBytes: 20 * GIB }),
    );
    const dense = requiredMemoryBytes(
      model({ params: "32B", architecture: "dense" }),
      quant({ diskBytes: 20 * GIB }),
    );
    expect(moe).toBeGreaterThan(dense * 10);
  });

  it.each([0, -1, Number.NaN])("throws ValidationError for diskBytes %s", (bad) => {
    expect(() => requiredMemoryBytes(model(), quant({ diskBytes: bad }))).toThrow(ValidationError);
  });

  it("throws ValidationError when diskBytes is missing", () => {
    const broken = { name: "Q4_K_M" } as unknown as Quantization;
    expect(() => requiredMemoryBytes(model(), broken)).toThrow(ValidationError);
  });

  it("throws ValidationError for a non-positive param count", () => {
    expect(() => requiredMemoryBytes(model({ params: "0B" }), quant())).toThrow(ValidationError);
  });

  it("applies the total-param floor for IQ-family quants on MoE", () => {
    const moe = model({ params: "1T", architecture: "moe", activeParams: "32B" });
    const req = requiredMemoryBytes(moe, quant({ name: "IQ4_XS", diskBytes: 20 * GIB }));
    expect(req).toBeGreaterThan(400 * GIB);
  });

  it("refuses to size a MoE model with an unrecognized quant rather than under-provision", () => {
    const moe = model({ params: "1T", architecture: "moe", activeParams: "32B" });
    expect(() => requiredMemoryBytes(moe, quant({ name: "mystery", diskBytes: 20 * GIB }))).toThrow(
      ValidationError,
    );
  });

  it("falls back to disk size for a dense model with an unrecognized quant", () => {
    const req = requiredMemoryBytes(
      model({ params: "8B" }),
      quant({ name: "mystery", diskBytes: 5 * GIB }),
    );
    expect(req).toBe(5 * GIB + Math.ceil(5 * GIB * 0.15));
  });
});

describe("parseParamCount", () => {
  it.each([
    ["8B", 8e9],
    ["3.8B", 3.8e9],
    ["700M", 7e8],
    ["1T", 1e12],
  ])("parses %s to %d", (label, expected) => {
    expect(parseParamCount(label)).toBe(expected);
  });

  it.each(["", "8", "8G", "-1B", "0B", "abc"])("throws for invalid label %s", (label) => {
    expect(() => parseParamCount(label)).toThrow(ValidationError);
  });
});
