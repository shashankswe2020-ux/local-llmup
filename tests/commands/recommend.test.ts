import { describe, expect, it } from "vitest";
import {
  buildRecommendation,
  formatRecommendationJson,
  formatRecommendationText,
  runRecommend,
  parseContextTokens,
  assertModesExclusive,
  CONTEXT_CEILING,
  type RecommendDeps,
} from "../../src/commands/recommend.js";
import { loadCatalog } from "../../src/catalog/load.js";
import { loadPerf } from "../../src/advisor/perf-data.js";
import { ValidationError } from "../../src/errors.js";
import { createRegistry } from "../../src/backend/registry.js";
import type { BackendAdapter } from "../../src/backend/adapter.js";
import type { Capability, Catalog, CatalogModel, HardwareProfile } from "../../src/types.js";

function fakeAdapter(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  return {
    name: "ollama",
    capabilities: {
      canPull: true,
      canEmbed: true,
      openAiCompatible: true,
      formats: ["ollama"],
      defaultPort: 11434,
    },
    isInstalled: async () => true,
    installHint: () => "brew install ollama",
    pull: async () => ({ modelId: "x", digestVerified: true }),
    serve: async () => ({ endpoint: "http://127.0.0.1:11434", pid: 1, port: 11434, ownedByUs: true }),
    waitUntilReady: async () => undefined,
    stop: async () => undefined,
    chat: async () => ({ content: "" }),
    embed: async () => ({ vectors: [], dimension: 0 }),
    ...overrides,
  };
}

const GIB = 1024 ** 3;
const PERF = loadPerf();

/** Thin wrapper that threads the real perf dataset into the pure builder. */
function build(
  cat: Catalog,
  hw: HardwareProfile,
  options?: Parameters<typeof buildRecommendation>[3],
): ReturnType<typeof buildRecommendation> {
  return buildRecommendation(cat, hw, PERF, options);
}

function dense(
  id: string,
  params: string,
  diskBytes: number,
  overrides: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    id,
    family: id.split(":")[0]!,
    params,
    architecture: "dense",
    license: "apache-2.0",
    openWeight: true,
    contextLength: 8192,
    capabilities: ["chat"],
    releaseDate: "2025-06-01",
    source: { ollama: id },
    quantizations: [
      {
        name: "Q4_K_M",
        diskBytes,
        minRamBytes: diskBytes + 1_500_000_000,
        minVramBytes: diskBytes + 1_000_000_000,
      },
    ],
    ...overrides,
  };
}

const KIMI: CatalogModel = {
  id: "kimi-k2:instruct",
  family: "kimi-k2",
  params: "1T",
  architecture: "moe",
  activeParams: "32B",
  license: "modified-mit",
  openWeight: true,
  contextLength: 131072,
  capabilities: ["chat", "reasoning"],
  releaseDate: "2025-07-01",
  source: { ollama: "kimi-k2:instruct" },
  quantizations: [
    { name: "Q4_K_M", diskBytes: 600 * GIB, minRamBytes: 620 * GIB, minVramBytes: 600 * GIB },
  ],
};

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

function appleHw(totalRamGib: number): HardwareProfile {
  return {
    arch: "arm64",
    platform: "darwin",
    totalRamBytes: totalRamGib * GIB,
    freeRamBytes: totalRamGib * GIB,
    gpu: [{ vendor: "apple", vramBytes: 0 }],
    freeDiskBytes: 1_000 * GIB,
  };
}

/** An x64 box with an AMD GPU: fits by VRAM, but has no perf profile. */
function amdHw(vramGib: number): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 64 * GIB,
    freeRamBytes: 60 * GIB,
    gpu: [{ vendor: "amd", vramBytes: vramGib * GIB }],
    freeDiskBytes: 1_000 * GIB,
  };
}

const FIXTURE = catalog([
  dense("llama3.1:8b", "8B", 4_900_000_000, { benchmarkProxy: 0.82 }),
  dense("gemma2:2b", "2B", 1_600_000_000),
  KIMI,
]);

describe("buildRecommendation", () => {
  it("ranks fitting models, lists won't-fit, and picks a top command", () => {
    const result = build(FIXTURE, appleHw(32));
    expect(result.entries.map((e) => e.model.id)).toEqual(["llama3.1:8b", "gemma2:2b"]);
    expect(result.entries[0]!.rank).toBe(1);
    expect(result.wontFit).toHaveLength(1);
    expect(result.wontFit[0]!.model.id).toBe("kimi-k2:instruct");
    expect(result.wontFit[0]!.reason).toBe("ram-bound");
    expect(result.command).toBe("local-llmup up llama3.1:8b");
    expect(result.memoryKind).toBe("ram");
  });

  it("attaches a yes/slow verdict and a known throughput range to each fitting entry", () => {
    const result = build(FIXTURE, appleHw(32));
    for (const entry of result.entries) {
      expect(["yes", "slow"]).toContain(entry.verdict);
      expect(entry.throughput.known).toBe(true);
      expect(entry.throughput.lowTokPerSec).toBeGreaterThan(0);
      expect(entry.throughput.highTokPerSec).toBeGreaterThanOrEqual(entry.throughput.lowTokPerSec);
    }
  });

  it("carries a slow verdict with unknown throughput when hardware has no perf profile", () => {
    const result = build(catalog([dense("llama3.1:8b", "8B", 4_900_000_000)]), amdHw(16));
    const top = result.entries[0]!;
    expect(top.verdict).toBe("slow");
    expect(top.throughput.known).toBe(false);
    const json = JSON.parse(formatRecommendationJson(result)) as {
      ranked: { estTokPerSec: unknown }[];
    };
    expect(json.ranked[0]!.estTokPerSec).toBeNull();
  });

  it("treats an absent --task identically to a task every survivor satisfies", () => {
    const noTask = build(FIXTURE, appleHw(32));
    const chat: Capability = "chat";
    const withChat = build(FIXTURE, appleHw(32), { task: chat });
    expect(withChat.entries.map((e) => e.model.id)).toEqual(noTask.entries.map((e) => e.model.id));
    for (let i = 0; i < noTask.entries.length; i += 1) {
      expect(withChat.entries[i]!.score).toBeCloseTo(noTask.entries[i]!.score, 10);
    }
  });

  it("returns no command when nothing fits", () => {
    const result = build(catalog([KIMI]), appleHw(16));
    expect(result.entries).toEqual([]);
    expect(result.wontFit).toHaveLength(1);
    expect(result.command).toBeNull();
  });
});

describe("formatRecommendationText", () => {
  it("renders a ranked table, the up command, and a won't-fit section", () => {
    const text = formatRecommendationText(build(FIXTURE, appleHw(32)));
    expect(text).toContain("Rank");
    expect(text).toContain("llama3.1:8b");
    expect(text).toContain("gemma2:2b");
    expect(text).toContain("Q4_K_M");
    expect(text).toContain("local-llmup up llama3.1:8b");
    expect(text).toContain("kimi-k2:instruct");
    expect(text).toContain("ram-bound");
    expect(text).toContain("Verdict");
    expect(text).toContain("tok/s");
    expect(text).toMatch(/✓|⚠️/u);
    expect(text).toContain("❌");
  });

  it("distinguishes an empty catalog from an all-too-big catalog", () => {
    const empty = formatRecommendationText(build(catalog([]), appleHw(32)));
    expect(empty).toContain("No models in the catalog");

    const tooBig = formatRecommendationText(build(catalog([KIMI]), appleHw(16)));
    expect(tooBig).toContain("No models fit");
    expect(tooBig).toContain("kimi-k2:instruct");
    expect(tooBig).not.toContain("No models in the catalog");
  });

  it("strips control characters from ids in the command line and won't-fit section", () => {
    const evil = catalog([
      dense("good\u001b[31m:8b", "8B", 4_900_000_000),
      { ...KIMI, id: "bad\u0000:1t" },
    ]);
    const text = formatRecommendationText(build(evil, appleHw(32)));
    expect(text.includes("\u001b")).toBe(false);
    expect(text.includes("\u0000")).toBe(false);
    expect(text).toContain("local-llmup up good:8b");
    expect(text).toContain("bad:1t");
  });
});

describe("formatRecommendationJson", () => {
  it("emits a stable, parseable schema", () => {
    const json = JSON.parse(formatRecommendationJson(build(FIXTURE, appleHw(32))));
    expect(json).toMatchObject({
      hardware: { arch: "arm64", platform: "darwin", memoryKind: "ram" },
      command: "local-llmup up llama3.1:8b",
    });
    expect(typeof json.hardware.usableMemoryBytes).toBe("number");
    expect(Array.isArray(json.ranked)).toBe(true);
    expect(json.ranked[0]).toEqual({
      rank: 1,
      id: "llama3.1:8b",
      family: "llama3.1",
      params: "8B",
      quant: "Q4_K_M",
      requiredBytes: json.ranked[0].requiredBytes,
      license: "apache-2.0",
      capabilities: ["chat"],
      score: json.ranked[0].score,
      verdict: json.ranked[0].verdict,
      estTokPerSec: json.ranked[0].estTokPerSec,
      backends: ["ollama"],
      throughputBackend: "ollama",
    });
    expect(["yes", "slow"]).toContain(json.ranked[0].verdict);
    expect(json.ranked[0].estTokPerSec).toMatchObject({
      lowTokPerSec: json.ranked[0].estTokPerSec.lowTokPerSec,
      highTokPerSec: json.ranked[0].estTokPerSec.highTokPerSec,
    });
    expect(json.wontFit).toEqual([{ id: "kimi-k2:instruct", reason: "ram-bound" }]);
  });
});

describe("backend surfacing (B12)", () => {
  const HF_ONLY = dense("hfmodel:1b", "1B", 1_000_000_000, { source: { hf: "org/hfmodel" } });

  it("lists servable backends per entry and pins throughputBackend to ollama by default", () => {
    const result = build(FIXTURE, appleHw(32));
    expect(result.throughputBackend).toBe("ollama");
    expect(result.entries[0]!.backends).toEqual(["ollama"]);
  });

  it("reports no servable backend for an advisory-only (hf) model but still ranks it", () => {
    const result = build(catalog([HF_ONLY]), appleHw(32));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.backends).toEqual([]);
  });

  it("exposes backends[] and throughputBackend in --json", () => {
    const json = JSON.parse(formatRecommendationJson(build(FIXTURE, appleHw(32)))) as {
      ranked: { backends: string[]; throughputBackend: string }[];
    };
    expect(json.ranked[0]!.backends).toEqual(["ollama"]);
    expect(json.ranked[0]!.throughputBackend).toBe("ollama");
  });

  it("scopes throughput to --backend and echoes it; an unsourced pair is unknown but still ranked", () => {
    const result = build(FIXTURE, appleHw(32), { backend: "mlx" });
    expect(result.throughputBackend).toBe("mlx");
    expect(result.entries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(entry.throughput.known).toBe(false);
    }
  });

  it("keeps MLX throughput unknown and never advertises MLX as servable off Apple Silicon", () => {
    const mlxModel = dense("smollm2:360m", "360M", 1_300, {
      source: {
        mlx: {
          repo: "mlx-community/SmolLM2-360M-Instruct-6bit",
          revision: "a".repeat(40),
          files: [
            { file: "config.json", sha256: "b".repeat(64), bytes: 100 },
            { file: "tokenizer_config.json", sha256: "c".repeat(64), bytes: 200 },
            { file: "model.safetensors", sha256: "d".repeat(64), bytes: 1_000 },
          ],
        },
      },
    });
    const mlx = fakeAdapter({
      name: "mlx",
      capabilities: {
        canPull: true,
        canEmbed: false,
        openAiCompatible: true,
        formats: ["mlx"],
        defaultPort: 8080,
      },
    });
    const registry = createRegistry([mlx]);

    const apple = buildRecommendation(
      catalog([mlxModel]),
      appleHw(32),
      PERF,
      { backend: "mlx" },
      registry,
    );
    expect(apple.entries[0]?.backends).toEqual(["mlx"]);
    expect(apple.entries[0]?.throughput.known).toBe(false);

    const nonApple = buildRecommendation(
      catalog([mlxModel]),
      amdHw(16),
      PERF,
      { backend: "mlx" },
      registry,
    );
    expect(nonApple.entries).toHaveLength(1);
    expect(nonApple.entries[0]?.backends).toEqual([]);
    expect(nonApple.entries[0]?.throughput.known).toBe(false);
  });

  it("annotates servable backends in the text table", () => {
    const text = formatRecommendationText(build(FIXTURE, appleHw(32)));
    expect(text).toContain("Backends");
    expect(text).toContain("ollama");
  });
});

describe("runRecommend — backend surfacing (B12)", () => {
  function deps(overrides: Partial<RecommendDeps> = {}): { deps: RecommendDeps; writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      deps: {
        loadCatalog: () => FIXTURE,
        detectHardware: () => Promise.resolve(appleHw(32)),
        loadPerf: () => PERF,
        registry: createRegistry([fakeAdapter()]),
        write: (text) => writes.push(text),
        ...overrides,
      },
    };
  }

  it("default output is byte-identical whether or not a backend is installed", async () => {
    let probed = false;
    const installed = createRegistry([
      fakeAdapter({
        isInstalled: async () => {
          probed = true;
          return true;
        },
      }),
    ]);
    const notInstalled = createRegistry([fakeAdapter({ isInstalled: async () => false })]);

    const a = deps({ registry: installed });
    const b = deps({ registry: notInstalled });
    await runRecommend({ json: true }, a.deps);
    await runRecommend({ json: true }, b.deps);

    expect(a.writes.join("")).toBe(b.writes.join(""));
    expect(probed).toBe(false);
  });

  it("--available-backends drops models with no installed servable backend when passed", async () => {
    const notInstalled = createRegistry([fakeAdapter({ isInstalled: async () => false })]);
    const { deps: d, writes } = deps({ registry: notInstalled });
    await runRecommend({ availableBackends: true, json: true }, d);
    const parsed = JSON.parse(writes.join("")) as { ranked: unknown[] };
    expect(parsed.ranked).toEqual([]);
  });

  it("default mode never drops models even when no backend is installed", async () => {
    const notInstalled = createRegistry([fakeAdapter({ isInstalled: async () => false })]);
    const { deps: d, writes } = deps({ registry: notInstalled });
    await runRecommend({ json: true }, d);
    const parsed = JSON.parse(writes.join("")) as { ranked: unknown[] };
    expect(parsed.ranked.length).toBeGreaterThan(0);
  });
});

describe("runRecommend", () => {
  function deps(overrides: Partial<RecommendDeps> = {}): { deps: RecommendDeps; writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      deps: {
        loadCatalog: () => FIXTURE,
        detectHardware: () => Promise.resolve(appleHw(32)),
        loadPerf: () => PERF,
        registry: createRegistry([fakeAdapter()]),
        write: (text) => writes.push(text),
        ...overrides,
      },
    };
  }

  it("writes the text report by default", async () => {
    const { deps: d, writes } = deps();
    await runRecommend({}, d);
    expect(writes.join("")).toContain("local-llmup up llama3.1:8b");
  });

  it("writes JSON when json is requested", async () => {
    const { deps: d, writes } = deps();
    await runRecommend({ json: true }, d);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.command).toBe("local-llmup up llama3.1:8b");
  });

  it("propagates catalog load failures", async () => {
    const { deps: d } = deps({
      loadCatalog: () => {
        throw new Error("boom");
      },
    });
    await expect(runRecommend({}, d)).rejects.toThrow("boom");
  });
});

describe("parseContextTokens", () => {
  it("accepts a positive integer", () => {
    expect(parseContextTokens("4096")).toBe(4096);
    expect(parseContextTokens("1")).toBe(1);
  });

  it("rejects zero, negatives, non-numeric, and non-integer values", () => {
    for (const bad of ["0", "-1", "abc", "1.5", "", "  ", "NaN", "Infinity"]) {
      expect(() => parseContextTokens(bad)).toThrow(ValidationError);
    }
  });

  it("rejects a value over the ceiling", () => {
    expect(() => parseContextTokens(String(CONTEXT_CEILING + 1))).toThrow(ValidationError);
    expect(parseContextTokens(String(CONTEXT_CEILING))).toBe(CONTEXT_CEILING);
  });

  it("has a ceiling at least as large as the largest catalog context length", () => {
    const max = Math.max(...loadCatalog().models.map((m) => m.contextLength));
    expect(CONTEXT_CEILING).toBeGreaterThanOrEqual(max);
  });
});

describe("assertModesExclusive", () => {
  it("throws when both --context and --max-context are set", () => {
    expect(() => assertModesExclusive(4096, true)).toThrow(ValidationError);
  });

  it("permits either mode alone or neither", () => {
    expect(() => assertModesExclusive(4096, undefined)).not.toThrow();
    expect(() => assertModesExclusive(undefined, true)).not.toThrow();
    expect(() => assertModesExclusive(undefined, undefined)).not.toThrow();
  });
});

// Llama-3.1-8B-class KV geometry: 131072 bytes/token → ~17 GB at the 128K cap.
const LLAMA_KV = 131072;

function known(id: string, diskBytes: number, kv: number, contextLength = 131072): CatalogModel {
  return dense(id, "8B", diskBytes, { kvBytesPerToken: kv, contextLength });
}

describe("buildRecommendation --context", () => {
  it("sizes each entry's weights and KV cache at the requested context", () => {
    const cat = catalog([known("llama3.1:8b", 4_900_000_000, LLAMA_KV)]);
    const result = build(cat, appleHw(64), { context: 8192 });
    const entry = result.entries[0]!;
    expect(entry.contextSizing).toBeDefined();
    expect(entry.contextSizing!.tokens).toBe(8192);
    expect(entry.contextSizing!.weightsBytes).toBeGreaterThan(0);
    expect(entry.contextSizing!.kvCacheBytes).toBe(LLAMA_KV * 8192);
  });

  it("moves a model that fits at a small context but not a large one to won't-fit with a memory reason (CW4)", () => {
    const cat = catalog([known("llama3.1:8b", 4_900_000_000, LLAMA_KV)]);

    const small = build(cat, appleHw(16), { context: 2048 });
    expect(small.entries.map((e) => e.model.id)).toContain("llama3.1:8b");

    const large = build(cat, appleHw(16), { context: 131072 });
    expect(large.entries).toEqual([]);
    expect(large.wontFit).toHaveLength(1);
    expect(large.wontFit[0]!.reason).toBe("ram-bound"); // memory, not context-bound
  });

  it("lists a model whose context exceeds its cap as context-bound", () => {
    const cat = catalog([known("small-ctx:8b", 4_900_000_000, LLAMA_KV, 8192)]);
    const result = build(cat, appleHw(64), { context: 16384 });
    expect(result.entries).toEqual([]);
    expect(result.wontFit[0]!.reason).toBe("context-bound");
  });

  it("still ranks an unknown-geometry model by weights, with a null KV cache (CW6)", () => {
    // Large cap so the request is within the model limit; no kvBytesPerToken.
    const cat = catalog([dense("mystery:8b", "8B", 4_900_000_000, { contextLength: 131072 })]);
    const result = build(cat, appleHw(64), { context: 65536 });
    const entry = result.entries.find((e) => e.model.id === "mystery:8b")!;
    expect(entry).toBeDefined();
    expect(entry.contextSizing!.kvCacheBytes).toBeNull();
    expect(entry.contextSizing!.weightsBytes).toBeGreaterThan(0);
  });
});

describe("buildRecommendation --max-context", () => {
  it("reports the model cap when memory allows more, bound by the model", () => {
    const cat = catalog([known("llama3.1:8b", 4_900_000_000, LLAMA_KV, 131072)]);
    const result = build(cat, appleHw(64), { maxContext: true });
    const entry = result.entries[0]!;
    expect(entry.maxContext).toBeDefined();
    expect(entry.maxContext!.tokens).toBe(131072); // clamped to the model cap
    expect(entry.maxContext!.boundBy).toBe("model");
  });

  it("reports the memory ceiling when it is below the model cap, bound by hardware", () => {
    const cat = catalog([known("llama3.1:8b", 4_900_000_000, LLAMA_KV, 131072)]);
    const result = build(cat, appleHw(16), { maxContext: true });
    const entry = result.entries[0]!;
    expect(entry.maxContext!.boundBy).toBe("hardware");
    expect(entry.maxContext!.tokens).toBeGreaterThan(0);
    expect(entry.maxContext!.tokens!).toBeLessThan(131072);
  });

  it("reports unknown for a model with no sourced KV geometry", () => {
    const cat = catalog([dense("mystery:8b", "8B", 4_900_000_000)]);
    const result = build(cat, appleHw(64), { maxContext: true });
    const entry = result.entries[0]!;
    expect(entry.maxContext!.tokens).toBeNull();
    expect(entry.maxContext!.boundBy).toBe("unknown");
  });
});

describe("context-mode rendering", () => {
  const cat = catalog([
    known("llama3.1:8b", 4_900_000_000, LLAMA_KV),
    dense("mystery:8b", "8B", 4_900_000_000),
  ]);

  it("adds Weights and KV columns and notes the context in the header (--context)", () => {
    const text = formatRecommendationText(build(cat, appleHw(64), { context: 8192 }));
    expect(text).toContain("Weights");
    expect(text).toContain("KV");
    expect(text).toContain("8192");
    expect(text).toContain("unknown"); // the unknown-geometry model's KV cell
  });

  it("adds Max Context and Bound-By columns (--max-context) without crashing on unknown rows (CW17)", () => {
    const text = formatRecommendationText(build(cat, appleHw(64), { maxContext: true }));
    expect(text).toContain("Max Context");
    expect(text).toContain("Bound");
    expect(text).toContain("unknown");
  });

  it("emits additive JSON fields incl. kvPrecision for --context (CW18)", () => {
    const json = JSON.parse(formatRecommendationJson(build(cat, appleHw(64), { context: 8192 })));
    const row = json.ranked.find((r: { id: string }) => r.id === "llama3.1:8b");
    // Existing fields still present.
    expect(row).toMatchObject({ rank: expect.any(Number), id: "llama3.1:8b", quant: "Q4_K_M" });
    // Additive context fields.
    expect(row.context).toBe(8192);
    expect(row.weightsBytes).toBeGreaterThan(0);
    expect(row.kvCacheBytes).toBe(LLAMA_KV * 8192);
    expect(row.kvPrecision).toBe("fp16");
    const unknownRow = json.ranked.find((r: { id: string }) => r.id === "mystery:8b");
    expect(unknownRow.kvCacheBytes).toBeNull();
  });

  it("emits additive JSON fields incl. kvPrecision for --max-context", () => {
    const json = JSON.parse(formatRecommendationJson(build(cat, appleHw(64), { maxContext: true })));
    const row = json.ranked.find((r: { id: string }) => r.id === "llama3.1:8b");
    expect(row.maxContextTokens).toBe(131072);
    expect(row.boundBy).toBe("model");
    expect(row.kvPrecision).toBe("fp16");
    const unknownRow = json.ranked.find((r: { id: string }) => r.id === "mystery:8b");
    expect(unknownRow.maxContextTokens).toBeNull();
    expect(unknownRow.boundBy).toBe("unknown");
  });

  it("is deterministic for identical inputs (CW10)", () => {
    const a = formatRecommendationText(build(cat, appleHw(64), { context: 8192 }));
    const b = formatRecommendationText(build(cat, appleHw(64), { context: 8192 }));
    expect(a).toBe(b);
    const ja = formatRecommendationJson(build(cat, appleHw(64), { maxContext: true }));
    const jb = formatRecommendationJson(build(cat, appleHw(64), { maxContext: true }));
    expect(ja).toBe(jb);
  });
});
