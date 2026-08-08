import { describe, expect, it } from "vitest";
import { computeHardwareScore, identifyBottleneck } from "../../src/advisor/score.js";
import { BOTTLENECKS, type HardwareProfile } from "../../src/types.js";

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

const highEnd = hw();
const mid = hw({
  gpu: [{ vendor: "nvidia", vramBytes: 12 * GIB }],
  totalRamBytes: 32 * GIB,
  freeRamBytes: 28 * GIB,
  freeDiskBytes: 180 * GIB,
});
const lowEnd = hw({
  gpu: [],
  totalRamBytes: 8 * GIB,
  freeRamBytes: 6 * GIB,
  freeDiskBytes: 20 * GIB,
});

describe("computeHardwareScore", () => {
  it("returns a stable integer in 0..100 for every profile (AC1)", () => {
    for (const profile of [highEnd, mid, lowEnd]) {
      const first = computeHardwareScore(profile);
      expect(Number.isInteger(first.total)).toBe(true);
      expect(first.total).toBeGreaterThanOrEqual(0);
      expect(first.total).toBeLessThanOrEqual(100);
      // Pure + deterministic: same input → identical output.
      expect(computeHardwareScore(profile).total).toBe(first.total);
    }
  });

  it("ranks stronger hardware higher (AC1)", () => {
    expect(computeHardwareScore(highEnd).total).toBeGreaterThan(computeHardwareScore(mid).total);
    expect(computeHardwareScore(mid).total).toBeGreaterThan(computeHardwareScore(lowEnd).total);
  });

  it("normalizes every sub-score into 0..1 (AC3)", () => {
    for (const profile of [highEnd, mid, lowEnd]) {
      const { sub } = computeHardwareScore(profile);
      for (const axis of BOTTLENECKS) {
        expect(sub[axis]).toBeGreaterThanOrEqual(0);
        expect(sub[axis]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("exposes a bottleneck consistent with identifyBottleneck", () => {
    for (const profile of [highEnd, mid, lowEnd]) {
      expect(computeHardwareScore(profile).bottleneck).toBe(identifyBottleneck(profile));
    }
  });
});

describe("identifyBottleneck (AC2)", () => {
  it("flags VRAM when there is no usable GPU pool", () => {
    expect(identifyBottleneck(hw({ gpu: [] }))).toBe("vram");
  });

  it("flags RAM when system memory is starved but the GPU is strong", () => {
    expect(identifyBottleneck(hw({ totalRamBytes: 8 * GIB, freeRamBytes: 6 * GIB }))).toBe("ram");
  });

  it("flags storage when the disk is nearly full but all else is strong", () => {
    expect(identifyBottleneck(hw({ freeDiskBytes: 5 * GIB }))).toBe("storage");
  });

  it("defaults to VRAM (highest weight) on a balanced machine", () => {
    expect(identifyBottleneck(highEnd)).toBe("vram");
  });

  it("matches the spec's RTX 3060 12GB / 32GB example → VRAM", () => {
    expect(identifyBottleneck(mid)).toBe("vram");
  });
});

describe("Apple unified memory", () => {
  it("is not falsely flagged as zero-VRAM (unified acts as the GPU pool)", () => {
    const apple = hw({
      arch: "arm64",
      platform: "darwin",
      gpu: [{ vendor: "apple", vramBytes: 0 }],
      totalRamBytes: 32 * GIB,
      freeRamBytes: 28 * GIB,
    });
    expect(computeHardwareScore(apple).sub.vram).toBeGreaterThan(0);
  });
});
