import { describe, expect, it } from "vitest";
import {
  ACTIVATION_OVERHEAD_FRACTION,
  kvBytesPerToken,
  kvCacheBytes,
  maxContextTokens,
  parseParamCount,
  requiredMemoryAtContext,
  requiredMemoryBytes,
  usableMemoryBytes,
  weightBytes,
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

// ---------------------------------------------------------------------------
// Context-window-aware sizing (T-CW1). All fp16 KV. Decisions D6, D7, D10.
// ---------------------------------------------------------------------------

// Llama 3.1 8B geometry: 32 layers × 8 KV heads × head-dim 128 → fp16 KV
// per token = 2 (K,V) × 32 × 8 × 128 × 2 bytes = 131,072 B/token (128 KiB).
const KV_PER_TOKEN_8B = 131_072;
// Q4_K_M on 8B: bits/param 4.7 → formula floor 4.7e9 < disk 4.9e9 → resident 4.9e9.
const DISK_8B = 4_900_000_000;
const WEIGHTS_8B = DISK_8B; // resident weights, no runtime overhead
const LEGACY_8B = WEIGHTS_8B + Math.ceil(WEIGHTS_8B * 0.15);

function ctxModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return model({ kvBytesPerToken: KV_PER_TOKEN_8B, ...overrides });
}

const ctxQuant = quant({ name: "Q4_K_M", diskBytes: DISK_8B });

describe("weightBytes", () => {
  it("returns resident weights without the runtime-overhead margin", () => {
    expect(weightBytes(ctxModel(), ctxQuant)).toBe(WEIGHTS_8B);
    // And is strictly below the legacy footprint, which adds 15% overhead.
    expect(weightBytes(ctxModel(), ctxQuant)).toBeLessThan(
      requiredMemoryBytes(ctxModel(), ctxQuant),
    );
  });

  it("applies the total-param floor for a MoE model", () => {
    const moe = ctxModel({ params: "1T", architecture: "moe", activeParams: "32B" });
    expect(weightBytes(moe, quant({ diskBytes: 20 * GIB }))).toBeGreaterThan(400 * GIB);
  });
});

describe("kvBytesPerToken (honesty gate accessor)", () => {
  it("returns the sourced per-token figure when present", () => {
    expect(kvBytesPerToken(ctxModel())).toBe(KV_PER_TOKEN_8B);
  });

  it("returns undefined when the model has no attention geometry", () => {
    expect(kvBytesPerToken(model())).toBeUndefined();
  });
});

describe("kvCacheBytes", () => {
  it("is exactly zero at zero tokens (AC-CW1)", () => {
    expect(kvCacheBytes(KV_PER_TOKEN_8B, 0)).toBe(0);
  });

  it("matches the formula-anchored exact byte count (AC-CW1)", () => {
    // 131,072 B/token × 32,768 tokens = 4,294,967,296 bytes = exactly 4 GiB.
    expect(kvCacheBytes(KV_PER_TOKEN_8B, 32_768)).toBe(4 * GIB);
  });

  it("grows linearly: doubling tokens doubles bytes (AC-CW1)", () => {
    const a = kvCacheBytes(KV_PER_TOKEN_8B, 8_192);
    const b = kvCacheBytes(KV_PER_TOKEN_8B, 16_384);
    expect(b).toBe(a * 2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws ValidationError for invalid kvBytesPerToken %s",
    (bad) => {
      expect(() => kvCacheBytes(bad, 1_024)).toThrow(ValidationError);
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws ValidationError for invalid token count %s",
    (bad) => {
      expect(() => kvCacheBytes(KV_PER_TOKEN_8B, bad)).toThrow(ValidationError);
    },
  );
});

describe("requiredMemoryAtContext", () => {
  it("equals max(legacy, weights + KV + activation slack) at a known geometry (AC-CW2)", () => {
    const slack = Math.ceil(WEIGHTS_8B * ACTIVATION_OVERHEAD_FRACTION);
    const explicit = WEIGHTS_8B + kvCacheBytes(KV_PER_TOKEN_8B, 32_768) + slack;
    expect(requiredMemoryAtContext(ctxModel(), ctxQuant, 32_768)).toBe(
      Math.max(LEGACY_8B, explicit),
    );
  });

  it("pins ACTIVATION_OVERHEAD_FRACTION as a named 5% constant (D7)", () => {
    expect(ACTIVATION_OVERHEAD_FRACTION).toBe(0.05);
  });

  it("is floored at the legacy footprint — never more optimistic (AC-CW14)", () => {
    // At the smallest nonzero context the explicit sum is below legacy, so the
    // floor binds and a legacy-fitting boundary can never flip to fits.
    expect(requiredMemoryAtContext(ctxModel(), ctxQuant, 1)).toBe(LEGACY_8B);
  });

  it("is monotone non-decreasing in tokens and always >= legacy (AC-CW14)", () => {
    const at1 = requiredMemoryAtContext(ctxModel(), ctxQuant, 1) as number;
    const at32k = requiredMemoryAtContext(ctxModel(), ctxQuant, 32_768) as number;
    const at128k = requiredMemoryAtContext(ctxModel(), ctxQuant, 131_072) as number;
    expect(at1).toBeGreaterThanOrEqual(LEGACY_8B);
    expect(at32k).toBeGreaterThanOrEqual(at1);
    expect(at128k).toBeGreaterThan(at32k);
  });

  it("returns undefined for a model without attention geometry (AC-CW6, honesty gate)", () => {
    expect(requiredMemoryAtContext(model(), ctxQuant, 32_768)).toBeUndefined();
  });

  it("throws for a present-but-invalid per-token figure (data error, not honesty gate)", () => {
    expect(() => requiredMemoryAtContext(ctxModel({ kvBytesPerToken: 0 }), ctxQuant, 1_024)).toThrow(
      ValidationError,
    );
  });

  it("stays finite at the accepted context ceiling (AC-CW20)", () => {
    const huge = requiredMemoryAtContext(ctxModel(), ctxQuant, 100_000_000) as number;
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBeGreaterThan(1_000 * GIB); // dwarfs any realistic budget
  });
});

describe("maxContextTokens", () => {
  const B = 20 * GIB; // headroom-adjusted budget supplied by the caller

  it("is the exact inverse of the footprint under the supplied budget (AC-CW3)", () => {
    const max = maxContextTokens(ctxModel(), ctxQuant, B) as number;
    expect(requiredMemoryAtContext(ctxModel(), ctxQuant, max) as number).toBeLessThanOrEqual(B);
    expect(requiredMemoryAtContext(ctxModel(), ctxQuant, max + 1) as number).toBeGreaterThan(B);
  });

  it("round-trips inside the [weights+slack, legacy) window without exceeding budget (AC-CW3, C1)", () => {
    // Budget above weights+slack (5.145 GiB) but below the legacy footprint
    // (5.635 GiB): the model cannot load at zero context, so max must be 0 and
    // the (vacuous) footprint at 0 must not be claimed to fit.
    const inWindow = 5_400_000_000;
    expect(maxContextTokens(ctxModel(), ctxQuant, inWindow)).toBe(0);
  });

  it("floors rather than rounding up (AC-CW13)", () => {
    const max = maxContextTokens(ctxModel(), ctxQuant, B) as number;
    expect(Number.isInteger(max)).toBe(true);
    expect(requiredMemoryAtContext(ctxModel(), ctxQuant, max) as number).toBeLessThanOrEqual(B);
  });

  it("honors the supplied budget — a smaller budget yields fewer tokens (AC-CW15)", () => {
    const small = maxContextTokens(ctxModel(), ctxQuant, 12 * GIB) as number;
    const large = maxContextTokens(ctxModel(), ctxQuant, 24 * GIB) as number;
    expect(large).toBeGreaterThan(small);
  });

  it("clamps to 0 when weights alone exceed the budget (AC-CW16)", () => {
    const heavy = ctxModel({ params: "70B" });
    const max = maxContextTokens(heavy, quant({ name: "Q4_K_M", diskBytes: 30 * GIB }), 4 * GIB);
    expect(max).toBe(0);
  });

  it("clamps to 0 when the legacy footprint exceeds the budget (AC-CW16, C1)", () => {
    // weights+slack fits but legacy does not: the model does not fit at any
    // context and must be excluded (0), never reported with a positive ceiling.
    const max = maxContextTokens(ctxModel(), ctxQuant, LEGACY_8B - 1);
    expect(max).toBe(0);
  });

  it("throws for a present-but-invalid per-token figure (AC-CW6 data error)", () => {
    expect(() => maxContextTokens(ctxModel({ kvBytesPerToken: 1.5 }), ctxQuant, B)).toThrow(
      ValidationError,
    );
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "throws for an invalid budget %s",
    (bad) => {
      expect(() => maxContextTokens(ctxModel(), ctxQuant, bad)).toThrow(ValidationError);
    },
  );

  it("returns undefined for a model without attention geometry (AC-CW6, honesty gate)", () => {
    expect(maxContextTokens(model(), ctxQuant, B)).toBeUndefined();
  });
});
