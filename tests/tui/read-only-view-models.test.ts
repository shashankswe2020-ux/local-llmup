import { describe, expect, it } from "vitest";
import type { CanRunResult } from "../../src/commands/can-run.js";
import type { CatalogResult } from "../../src/commands/catalog.js";
import type { DoctorReport } from "../../src/commands/doctor.js";
import type { LsResult } from "../../src/commands/ls.js";
import type { RecommendationResult } from "../../src/commands/recommend.js";
import {
  buildCanRunViewModel,
  buildCatalogViewModel,
  buildDoctorViewModel,
  buildLsViewModel,
  buildRecommendViewModel,
} from "../../src/tui/read-only-view-models.js";
import type { CatalogModel, HardwareProfile, Quantization } from "../../src/types.js";
import { parseCommandViewModel } from "../../src/tui/view-model-schema.js";

const GIB = 1024 ** 3;
const quant: Quantization = {
  name: "Q4_K_M",
  diskBytes: 4 * GIB,
  minRamBytes: 5 * GIB,
  minVramBytes: 5 * GIB,
};

function model(id = "qwen3:14b"): CatalogModel {
  return {
    id,
    family: "qwen3",
    params: "14B",
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 32_768,
    capabilities: ["chat"],
    releaseDate: "2025-01-01",
    source: { ollama: "qwen3:14b" },
    quantizations: [quant],
  };
}

const hardware: HardwareProfile = {
  arch: "arm64",
  platform: "darwin",
  totalRamBytes: 32 * GIB,
  freeRamBytes: 24 * GIB,
  gpu: [{ vendor: "apple", vramBytes: 0 }],
  freeDiskBytes: 100 * GIB,
};

function recommendation(id = "qwen3:14b"): RecommendationResult {
  const entryModel = model(id);
  return {
    hardware,
    usableBytes: 30 * GIB,
    memoryKind: "ram",
    entries: [
      {
        rank: 1,
        model: entryModel,
        quant,
        requiredBytes: 5 * GIB,
        usableBytes: 30 * GIB,
        score: 0.82,
        scores: { quality: 0.8, fit: 0.7, speed: 0.6, recency: 0.5, capability: 1 },
        verdict: "slow",
        throughput: { known: false, lowTokPerSec: null, highTokPerSec: null },
        throughputEvidence: {
          backend: "ollama",
          source: "offline-estimate",
          unknownReason: "no-sourced-performance-profile",
        },
        backends: ["ollama"],
      },
    ],
    wontFit: [{ model: model("too-big:70b"), reason: "ram-bound" }],
    command: `local-llmup up ${id}`,
    throughputBackend: "ollama",
    maxContextMode: false,
  };
}

describe("read-only view-model builders", () => {
  it("preserves unknown throughput and produces deterministic frozen recommend output", () => {
    const first = buildRecommendViewModel(recommendation());
    const second = buildRecommendViewModel(recommendation());
    expect(first).toEqual(second);
    expect(first.rows[0]?.throughput).toEqual({
      known: false,
      label: "unknown",
      reason: "no-sourced-performance-profile",
    });
    expect(first.wontFit[0]?.reason).toBe("ram-bound");
    expect(first).toMatchObject({
      hardware: {
        arch: "arm64",
        platform: "darwin",
        totalRamBytes: 32 * GIB,
        freeRamBytes: 24 * GIB,
        freeDiskBytes: 100 * GIB,
        usableBytes: 30 * GIB,
        memoryKind: "ram",
        gpu: [{ vendor: "apple", vramBytes: 0 }],
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.rows)).toBe(true);
    expect(Object.isFrozen(first.rows[0])).toBe(true);
  });

  it("marks unsafe model identifiers non-actionable and visibly escapes display content", () => {
    const view = buildRecommendViewModel(recommendation("Qwen 3\u001b[31m"));
    expect(view.rows[0]?.model.actionable).toBe(false);
    expect(view.rows[0]?.model.display).toContain("\\u{51}");
    expect(view.rows[0]?.model.display).toContain("\\u{1B}");
    expect(view.rows[0]?.model.display).not.toContain("\u001b");
    expect(view.command).toBeNull();
    expect("canonical" in (view.rows[0]?.model ?? {})).toBe(false);
  });

  it("preserves a long validated canonical model ID in argv while bounding display", () => {
    const canonical = "a".repeat(300);
    const view = buildRecommendViewModel(recommendation(canonical));
    expect(view.command?.argv[2]).toBe(canonical);
    expect(view.command?.display.endsWith("…")).toBe(true);
  });

  it("rejects option-like model ids in command handoff slots", () => {
    const view = buildRecommendViewModel(recommendation());
    const forged = {
      ...view,
      command: {
        argv: ["local-llmup", "up", "--help"],
        display: view.command!.display,
      },
    };

    expect(() => parseCommandViewModel("recommend", forged)).toThrow(
      "invalid recommend completion view model",
    );
  });

  it("maps can-run without converting unknowns to zero", () => {
    const result: CanRunResult = {
      modelId: "qwen3:14b",
      runnable: "slow",
      throughput: { known: false, lowTokPerSec: null, highTokPerSec: null },
      quant: "Q4_K_M",
      reason: null,
      backends: ["ollama"],
      throughputBackend: "ollama",
      requiredBytes: 5 * GIB,
      usableBytes: 30 * GIB,
      throughputEvidence: {
        source: "offline-estimate",
        unknownReason: "no-sourced-performance-profile",
      },
    };
    expect(buildCanRunViewModel(result)).toMatchObject({
      verdict: "slow",
      reason: null,
      throughput: {
        known: false,
        label: "unknown",
        reason: "no-sourced-performance-profile",
      },
    });
  });

  it("sanitizes doctor details and backend fields exactly once at the builder boundary", () => {
    const result: DoctorReport = {
      ok: false,
      checks: [{ name: "state", status: "fail", detail: "bad\n\u001b[31mstate" }],
      hardwareScore: null,
      backends: [
        {
          name: "ollama",
          installed: false,
          version: null,
          isDefault: false,
          installHint: "run\ninstaller",
        },
      ],
    };
    const view = buildDoctorViewModel(result);
    expect(view.checks[0]?.detail).toBe("bad\\n\\u{1B}[31mstate");
    expect(view.backends[0]?.installHint).toBe("run\\ninstaller");
  });

  it("preserves every doctor score axis", () => {
    const result: DoctorReport = {
      ok: true,
      checks: [],
      backends: [],
      hardwareScore: {
        total: 73,
        sub: { vram: 60, ram: 80, compute: 70, storage: 90 },
        bottleneck: "vram",
      },
    };

    expect(buildDoctorViewModel(result)).toMatchObject({
      score: 73,
      scoreSub: { vram: 60, ram: 80, compute: 70, storage: 90 },
      bottleneck: "VRAM",
    });
  });

  it("maps typed catalog rows and refresh diff without parsing rendered text", () => {
    const catalogModel: CatalogModel = {
      ...model(),
      activeParams: "3B",
      openWeight: true,
      kvBytesPerToken: 65_536,
      benchmarkProxy: 0.75,
      quantizations: [{ ...quant, sha256: "a".repeat(64), digestVerified: true }],
    };
    const result: CatalogResult = {
      filter: "all",
      total: 1,
      hardware,
      rows: [
        {
          model: catalogModel,
          quant: catalogModel.quantizations[0]!,
          requiredBytes: 5 * GIB,
          fit: "fit",
          supportedBackends: ["ollama"],
        },
      ],
      refresh: {
        added: ["qwen3:14b"],
        updated: [],
        removed: [],
        skipped: ["bad\nmodel"],
        capped: ["capped:model"],
      },
      emptyReason: null,
    };
    const view = buildCatalogViewModel(result);
    expect(view.rows[0]).toMatchObject({ requiredBytes: 5 * GIB, fit: "fit" });
    expect(view.hardware).toMatchObject({
      arch: "arm64",
      platform: "darwin",
      freeDiskBytes: 100 * GIB,
    });
    expect(view.rows[0]?.sources).toEqual([{ type: "ollama", id: "qwen3:14b" }]);
    expect(view).toMatchObject({
      total: 1,
      rows: [
        {
          activeParams: "3B",
          openWeight: true,
          kvBytesPerToken: 65_536,
          benchmarkProxy: 0.75,
          quantizations: [
            {
              sha256: "a".repeat(64),
              digestVerified: true,
            },
          ],
        },
      ],
      refresh: {
        added: ["qwen3:14b"],
        skipped: ["bad\\nmodel"],
        capped: ["capped:model"],
      },
    });
  });

  it("rejects oversized read-only collections before mapping them", () => {
    const row: CatalogResult["rows"][number] = {
      model: model(),
      quant,
      requiredBytes: 5 * GIB,
      fit: "fit",
      supportedBackends: ["ollama"],
    };
    const result: CatalogResult = {
      filter: "all",
      total: 1_001,
      hardware,
      rows: Array.from({ length: 1_001 }, () => row),
      refresh: null,
      emptyReason: null,
    };

    expect(() => buildCatalogViewModel(result)).toThrow("catalog row limit exceeded");
  });

  it("maps ls from state-only typed data", () => {
    const empty: LsResult = { type: "empty" };
    expect(buildLsViewModel(empty)).toEqual({
      type: "empty",
      nextCommand: "local-llmup up <model>",
    });
    const active: LsResult = {
      type: "active",
      modelId: "qwen3:14b",
      backend: "ollama",
      endpoint: "http://127.0.0.1:11434",
      port: 11434,
      ownedByUs: false,
    };
    expect(buildLsViewModel(active)).toMatchObject({
      type: "active",
      ownership: "attached",
      port: 11434,
    });
  });
});
