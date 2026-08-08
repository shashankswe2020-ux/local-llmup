import { describe, expect, it } from "vitest";
import {
  buildCanRunResult,
  formatCanRunJson,
  formatCanRunText,
  runCanRun,
  type CanRunDeps,
} from "../../src/commands/can-run.js";
import { loadPerf } from "../../src/advisor/perf-data.js";
import { createDefaultRegistry } from "../../src/backend/registry.js";
import {
  expectNoninteractiveGolden,
  jsonGoldenName,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";
import type {
  Catalog,
  CatalogModel,
  HardwareProfile,
  ModelArchitecture,
  Quantization,
} from "../../src/types.js";

const GIB = 1024 ** 3;
const perf = loadPerf();

function quant(name = "Q4_K_M", diskBytes = 4_400_000_000): Quantization {
  return { name, diskBytes, minRamBytes: diskBytes, minVramBytes: diskBytes };
}

function model(
  id: string,
  params: string,
  quants: readonly Quantization[] = [quant()],
  architecture: ModelArchitecture = "dense",
): CatalogModel {
  return {
    id,
    family: id.split(":")[0]!,
    params,
    architecture,
    license: "apache-2.0",
    openWeight: true,
    contextLength: 4096,
    capabilities: ["chat"],
    releaseDate: "2024-01-01",
    source: { ollama: id },
    quantizations: quants,
  };
}

function catalog(models: readonly CatalogModel[]): Catalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", models };
}

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

function deps(over: Partial<CanRunDeps> = {}): { deps: CanRunDeps; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    deps: {
      loadCatalog: () => catalog([model("llama3.1:8b", "7B")]),
      detectHardware: () => Promise.resolve(hw()),
      loadPerf: () => perf,
      registry: createDefaultRegistry(),
      write: (t) => writes.push(t),
      ...over,
    },
  };
}

describe("buildCanRunResult", () => {
  it("returns a deeply immutable result snapshot", () => {
    const result = buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.throughput)).toBe(true);
    expect(Object.isFrozen(result.backends)).toBe(true);
    expect(Object.isFrozen(result.throughputEvidence)).toBe(true);
  });

  it("reports `yes` with a throughput range when the model fits and is fast", () => {
    const result = buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf);
    expect(result.modelId).toBe("llama3.1:8b");
    expect(result.runnable).toBe("yes");
    expect(result.reason).toBeNull();
    expect(result.quant).toBe("Q4_K_M");
    expect(result.throughput.known).toBe(true);
    expect(result.throughput.lowTokPerSec).toBeGreaterThan(0);
  });

  it("reports `no` with the binding reason when the model does not fit VRAM", () => {
    const result = buildCanRunResult(
      model("giant", "70B"),
      hw({ gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }] }),
      perf,
    );
    expect(result.runnable).toBe("no");
    expect(result.reason).toBe("vram-bound");
    expect(result.throughput.known).toBe(false);
    expect(result.quant).toBeNull();
    expect(result.requiredBytes).not.toBeNull();
    expect(result.requiredBytes).toBeGreaterThan(result.usableBytes);
    expect(result.throughputEvidence.unknownReason).toBe(
      "not-evaluated-model-does-not-fit",
    );
  });

  it("reports `slow` with unknown throughput when hardware has no perf profile", () => {
    const result = buildCanRunResult(
      model("llama3.1:8b", "7B"),
      hw({ gpu: [{ vendor: "amd", vramBytes: 16 * GIB }] }),
      perf,
    );
    expect(result.runnable).toBe("slow");
    expect(result.throughput.known).toBe(false);
  });
});

describe("formatCanRunText", () => {
  it("renders the verdict, quant, and a tok/s range for a `yes`", () => {
    const text = formatCanRunText(buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf));
    expect(text).toContain("llama3.1:8b");
    expect(text).toContain("yes");
    expect(text).toContain("tok/s");
    expect(text).toContain("Q4_K_M");
  });

  it("names the reason and shows no fabricated number for a `no`", () => {
    const text = formatCanRunText(
      buildCanRunResult(
        model("giant", "70B"),
        hw({ gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }] }),
        perf,
      ),
    );
    expect(text).toContain("no");
    expect(text).toContain("vram-bound");
  });

  it("says throughput is unknown when there is no perf profile", () => {
    const text = formatCanRunText(
      buildCanRunResult(
        model("llama3.1:8b", "7B"),
        hw({ gpu: [{ vendor: "amd", vramBytes: 16 * GIB }] }),
        perf,
      ),
    );
    expect(text.toLowerCase()).toContain("unknown");
  });
});

describe("formatCanRunJson", () => {
  it("emits stable machine-readable fields", () => {
    const result = buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf);
    const parsed = JSON.parse(formatCanRunJson(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      model: "llama3.1:8b",
      verdict: "yes",
      quant: "Q4_K_M",
      reason: null,
    });
    expect(parsed["throughput"]).toMatchObject({ known: true });
  });
});

describe("backend surfacing (B12)", () => {
  it("lists servable backends and pins throughputBackend to ollama by default", () => {
    const result = buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf);
    expect(result.backends).toEqual(["ollama"]);
    expect(result.throughputBackend).toBe("ollama");
  });

  it("scopes throughput to --backend; an unsourced pair is unknown but still answered", () => {
    const result = buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf, "mlx");
    expect(result.throughputBackend).toBe("mlx");
    expect(result.throughput.known).toBe(false);
    expect(["yes", "slow"]).toContain(result.runnable);
  });

  it("surfaces the native MLX adapter only on Apple Silicon while keeping throughput unknown", () => {
    const mlxModel: CatalogModel = {
      ...model("smollm2:360m", "360M", [quant("6bit", 1_300)]),
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
    };
    const apple = hw({
      platform: "darwin",
      arch: "arm64",
      gpu: [{ vendor: "apple", vramBytes: 0 }],
    });

    const supported = buildCanRunResult(mlxModel, apple, perf, "mlx");
    expect(supported.backends).toEqual(["mlx", "lmstudio"]);
    expect(supported.throughput.known).toBe(false);

    const unsupported = buildCanRunResult(mlxModel, hw(), perf, "mlx");
    expect(unsupported.backends).toEqual([]);
    expect(unsupported.throughput.known).toBe(false);
  });

  it("exposes backends[] and throughputBackend in --json", () => {
    const result = buildCanRunResult(model("llama3.1:8b", "7B"), hw(), perf);
    const parsed = JSON.parse(formatCanRunJson(result)) as {
      backends: string[];
      throughputBackend: string;
    };
    expect(parsed.backends).toEqual(["ollama"]);
    expect(parsed.throughputBackend).toBe("ollama");
  });
});

describe("runCanRun", () => {
  it("resolves the model, detects hardware, and writes a text report", async () => {
    const { deps: d, writes } = deps();
    const result = await withGoldenEnvironment(() => runCanRun({ model: "llama3.1" }, d));
    expect(result.runnable).toBe("yes");
    expectNoninteractiveGolden(plainGoldenName("can-run"), writes.join(""));
  });

  it("emits JSON when --json is set", async () => {
    const { deps: d, writes } = deps();
    await withGoldenEnvironment(() => runCanRun({ model: "llama3.1", json: true }, d));
    expectNoninteractiveGolden(jsonGoldenName("can-run"), writes.join(""));
    const parsed = JSON.parse(writes.join("")) as Record<string, unknown>;
    expect(parsed["verdict"]).toBe("yes");
  });

  it("is deterministic — identical inputs produce an identical result", async () => {
    const a = await runCanRun({ model: "llama3.1" }, deps().deps);
    const b = await runCanRun({ model: "llama3.1" }, deps().deps);
    expect(a).toEqual(b);
  });
});
