import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { loadCatalog } from "../src/catalog/load.js";
import { loadPerf } from "../src/advisor/perf-data.js";
import { computeHardwareScore } from "../src/advisor/score.js";
import { evaluateVerdict } from "../src/advisor/verdict.js";
import {
  buildRecommendation,
  formatRecommendationJson,
  formatRecommendationText,
  type RecommendOptions,
} from "../src/commands/recommend.js";
import { buildCanRunResult, formatCanRunJson, formatCanRunText } from "../src/commands/can-run.js";
import { collectCatalog, formatCatalogText } from "../src/commands/catalog.js";
import { resolveModel } from "../src/resolver.js";
import { createDefaultRegistry } from "../src/backend/registry.js";
import { ModelResolutionError, ValidationError } from "../src/errors.js";
import { BACKEND_NAMES, type HardwareProfile } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GIB = 1024 ** 3;
const hardware = (overrides: Partial<HardwareProfile>): HardwareProfile => ({
  arch: "x64",
  platform: "linux",
  totalRamBytes: 32 * GIB,
  freeRamBytes: 24 * GIB,
  freeDiskBytes: 500 * GIB,
  gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }],
  ...overrides,
});
const profiles = [
  hardware({}),
  hardware({ gpu: [{ vendor: "nvidia", vramBytes: 24 * GIB }] }),
  hardware({ arch: "arm64", platform: "darwin", gpu: [{ vendor: "apple", vramBytes: 0 }] }),
  hardware({ gpu: [] }),
  hardware({ platform: "win32", freeDiskBytes: 0 }),
  hardware({ gpu: [{ vendor: "amd", vramBytes: 16 * GIB }] }),
];
const modes: RecommendOptions[] = [
  {},
  { context: 1 },
  { context: 65536 },
  { maxContext: true },
  { contextPercent: 25 },
  { contextPercent: 50 },
  { contextPercent: 75 },
  { contextPercent: 100 },
  { task: "code" },
  ...BACKEND_NAMES.map((backend) => ({ backend })),
];
const catalog = loadCatalog();
const perf = loadPerf();
const registry = createDefaultRegistry();
const queries = [
  ...catalog.models.map((model) => model.id),
  ...catalog.models.map((model) => `${model.id}-${model.quantizations[0]!.name}`),
  ...new Set(catalog.models.map((model) => model.family)),
  "missing",
  "../escape",
  "",
  "bad;input",
  "qwen",
  " LLAMA3.1:8B ",
];

function compare(actual: unknown, expected: unknown, path: string): void {
  if (typeof actual === "number" && typeof expected === "number") {
    assert.ok(
      Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
      `${path}: ${actual} != ${expected}`,
    );
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((entry: unknown, index: number) =>
      compare(actual[index], entry, `${path}[${index}]`),
    );
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", path);
    const wanted = expected as Record<string, unknown>;
    const got = actual as Record<string, unknown>;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(wanted).sort(), path);
    for (const [key, entry] of Object.entries(wanted)) compare(got[key], entry, `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

async function main(): Promise<void> {
  execFileSync("cargo", ["build", "--locked", "-p", "llmup-cli", "--bin", "llmup-native"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const binary = join(
    ROOT,
    "target",
    "debug",
    process.platform === "win32" ? "llmup-native.exe" : "llmup-native",
  );
  let count = 0;
  let queryCount = 0;
  for (const profile of profiles) {
    const selected = modes.map((options) => ({
      hardware: profile,
      options,
      queries: options.contextPercent === undefined ? queries : [],
    }));
    const run = spawnSync(binary, ["--parity"], {
      input: JSON.stringify(selected),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const outputs = z
      .array(
        z.object({
          recommendation: z.unknown(),
          text: z.string(),
          score: z.unknown(),
          catalogText: z.string(),
          checks: z.array(z.unknown()),
          verdicts: z.array(z.unknown()),
        }),
      )
      .parse(JSON.parse(run.stdout) as unknown);
    const cat = await collectCatalog(
      { all: true },
      {
        loadCatalog: () => catalog,
        detectHardware: async () => profile,
        registry,
        loadCandidates: () => [],
        enrichCatalog: () => {
          throw Error("unused");
        },
        now: () => new Date(),
        write: () => {},
      },
    );
    for (const [index, options] of modes.entries()) {
      const output = outputs[index]!;
      const label = `${profile.platform}/${profile.gpu[0]?.vendor ?? "cpu"}/${JSON.stringify(options)}`;
      const recommendation = buildRecommendation(catalog, profile, perf, options, registry);
      compare(
        output.recommendation,
        JSON.parse(formatRecommendationJson(recommendation)),
        `${label}/recommendation`,
      );
      assert.equal(output.text, formatRecommendationText(recommendation), `${label}/text`);
      assert.equal(output.catalogText, formatCatalogText(cat), `${label}/catalog`);
      compare(output.score, computeHardwareScore(profile), `${label}/score`);
      compare(
        output.verdicts,
        catalog.models.map((model) =>
          evaluateVerdict(
            model,
            profile,
            perf,
            options.contextPercent === undefined
              ? options.context
              : Math.max(1, Math.floor((model.contextLength * options.contextPercent) / 100)),
            options.backend,
          ),
        ),
        `${label}/verdicts`,
      );
      if (options.contextPercent === undefined) {
        for (const [queryIndex, query] of queries.entries()) {
          const check = output.checks[queryIndex] as Record<string, unknown>;
          try {
            const resolved = resolveModel(catalog, query);
            compare(check["resolved"], resolved, `${label}/${query}/resolved`);
            const model = resolved.quant
              ? { ...resolved.model, quantizations: [resolved.quant] }
              : resolved.model;
            const report = buildCanRunResult(
              model,
              profile,
              perf,
              options.backend,
              registry,
              options.context,
            );
            compare(
              check["report"],
              JSON.parse(formatCanRunJson(report)),
              `${label}/${query}/report`,
            );
            assert.equal(check["text"], formatCanRunText(report), `${label}/${query}/text`);
          } catch (error) {
            if (!(error instanceof ModelResolutionError || error instanceof ValidationError))
              throw error;
            const response = z
              .object({ code: z.string(), candidates: z.array(z.string()) })
              .parse(check["error"]);
            assert.equal(
              response.code,
              error instanceof ModelResolutionError ? "MODEL_RESOLUTION_ERROR" : "VALIDATION_ERROR",
              query,
            );
            assert.deepEqual(
              response.candidates,
              error instanceof ModelResolutionError ? error.candidates : [],
            );
          }
          queryCount += 1;
        }
      }
      count += 1;
    }
  }
  console.log(
    `Rust advice parity passed: ${count} hardware/mode reports, ${count * catalog.models.length} verdicts, ${queryCount} resolver/can-run cases; plain text exact, JSON numbers within 1e-12 relative tolerance.`,
  );
}
await main();
