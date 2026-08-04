import { describe, it, expect } from "vitest";
import {
  ARCHS,
  PLATFORMS,
  GPU_VENDORS,
  MODEL_ARCHITECTURES,
  CAPABILITIES,
  type HardwareProfile,
  type CatalogModel,
  type Catalog,
} from "../src/types.js";

describe("shared enums", () => {
  it("declares the recognized arch/platform/gpu/architecture values", () => {
    expect(ARCHS).toEqual(["x64", "arm64"]);
    expect(PLATFORMS).toEqual(["darwin", "linux", "win32"]);
    expect(GPU_VENDORS).toEqual(["apple", "nvidia", "amd", "none"]);
    expect(MODEL_ARCHITECTURES).toEqual(["dense", "moe"]);
  });

  it("includes the core capabilities used by the ranker", () => {
    expect(CAPABILITIES).toContain("chat");
    expect(CAPABILITIES).toContain("code");
    expect(CAPABILITIES).toContain("vision");
  });
});

describe("domain type shapes (compile-time)", () => {
  it("accepts a well-formed HardwareProfile", () => {
    const hw: HardwareProfile = {
      arch: "arm64",
      platform: "darwin",
      totalRamBytes: 16 * 1024 ** 3,
      freeRamBytes: 8 * 1024 ** 3,
      gpu: [{ vendor: "apple", vramBytes: 0 }],
      freeDiskBytes: 200 * 1024 ** 3,
    };
    expect(hw.gpu[0]?.vendor).toBe("apple");
  });

  it("accepts a dense and an MoE CatalogModel within a Catalog", () => {
    const dense: CatalogModel = {
      id: "llama3.1:8b",
      family: "llama3.1",
      params: "8B",
      architecture: "dense",
      license: "llama-3.1-community",
      openWeight: true,
      contextLength: 131072,
      capabilities: ["chat", "code"],
      releaseDate: "2024-07-23",
      source: { ollama: "llama3.1:8b", hf: "meta-llama/Llama-3.1-8B" },
      quantizations: [
        { name: "Q4_K_M", diskBytes: 4_900_000_000, minRamBytes: 6_500_000_000, minVramBytes: 6_000_000_000 },
      ],
      benchmarkProxy: 0.71,
    };
    const moe: CatalogModel = {
      id: "kimi-k2:instruct",
      family: "kimi-k2",
      params: "1T",
      architecture: "moe",
      activeParams: "32B",
      license: "modified-mit",
      openWeight: true,
      contextLength: 131072,
      capabilities: ["chat", "reasoning"],
      releaseDate: "2025-07-11",
      source: { ollama: "kimi-k2:instruct" },
      quantizations: [
        { name: "Q4_K_M", diskBytes: 600_000_000_000, minRamBytes: 620_000_000_000, minVramBytes: 600_000_000_000, sha256: "abc123" },
      ],
    };
    const catalog: Catalog = {
      schemaVersion: 2,
      generatedAt: "2026-08-04T00:00:00Z",
      models: [dense, moe],
    };
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[1]?.activeParams).toBe("32B");
  });
});
