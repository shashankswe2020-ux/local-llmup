import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { loadCatalog } from "../src/catalog/load.js";
import { evaluateFit, evaluateFitAtContext } from "../src/ranking/fit.js";
import {
  maxContextTokens,
  requiredMemoryAtContext,
  requiredMemoryBytes,
  usableMemoryBytes,
  usableMemoryKind,
  weightBytes,
} from "../src/hardware/memory-math.js";
import { HEADROOM } from "../src/ranking/weights.js";
import type { CatalogModel, HardwareProfile } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GIB = 1024 ** 3;

function hardware(overrides: Partial<HardwareProfile>): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 32 * GIB,
    freeRamBytes: 24 * GIB,
    freeDiskBytes: 500 * GIB,
    gpu: [{ vendor: "nvidia", vramBytes: 8 * GIB }],
    ...overrides,
  };
}

function project(model: CatalogModel, hardware: HardwareProfile, context?: number): object {
  return {
    model: {
      id: model.id,
      params: model.params,
      architecture: model.architecture,
      contextLength: model.contextLength,
      quantizations: model.quantizations,
      ...(model.kvBytesPerToken !== undefined ? { kvBytesPerToken: model.kvBytesPerToken } : {}),
    },
    hardware,
    ...(context !== undefined ? { context } : {}),
  };
}

function expected(model: CatalogModel, hardware: HardwareProfile, context?: number): object {
  const usableBytes = usableMemoryBytes(hardware);
  return {
    fit:
      context === undefined
        ? evaluateFit(model, hardware)
        : evaluateFitAtContext(model, hardware, context),
    memoryKind: usableMemoryKind(hardware),
    usableBytes,
    weights: model.quantizations.map((quant) => weightBytes(model, quant)),
    required: model.quantizations.map((quant) => requiredMemoryBytes(model, quant)),
    atContext: model.quantizations.map((quant) =>
      context === undefined ? null : (requiredMemoryAtContext(model, quant, context) ?? null),
    ),
    maxContext: model.quantizations.map(
      (quant) => maxContextTokens(model, quant, usableBytes * (1 - HEADROOM)) ?? null,
    ),
  };
}

export function runRustFitParity(): void {
  execFileSync("cargo", ["build", "--locked", "-p", "llmup-cli", "--bin", "llmup-fit-parity"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const binary = join(
    ROOT,
    "target",
    "debug",
    process.platform === "win32" ? "llmup-fit-parity.exe" : "llmup-fit-parity",
  );
  const profiles = [
    hardware({}),
    hardware({ gpu: [{ vendor: "nvidia", vramBytes: 24 * GIB }] }),
    hardware({ arch: "arm64", platform: "darwin", gpu: [{ vendor: "apple", vramBytes: 0 }] }),
    hardware({ gpu: [] }),
    hardware({ platform: "win32", freeDiskBytes: 0 }),
    hardware({ totalRamBytes: GIB, freeRamBytes: GIB, gpu: [] }),
    hardware({
      gpu: [
        { vendor: "amd", vramBytes: 16 * GIB },
        { vendor: "intel", vramBytes: GIB },
      ],
    }),
  ];
  const catalog = loadCatalog();
  const first = catalog.models[0];
  assert.ok(first);
  const quant = { name: "Q4_K_M", diskBytes: 3 * GIB, minRamBytes: 0, minVramBytes: 0 };
  const synthetic: CatalogModel[] = [
    {
      ...first,
      id: "parity:ties",
      params: "4B",
      architecture: "dense",
      contextLength: 131072,
      kvBytesPerToken: 16384,
      quantizations: [quant, { ...quant, name: "Q5_K_M" }, { ...quant, name: "custom" }],
    },
    { ...first, id: "parity:empty", quantizations: [] },
    {
      ...first,
      id: "parity:unknown",
      params: "4B",
      architecture: "dense",
      kvBytesPerToken: undefined,
      quantizations: [{ ...quant, name: "custom" }],
    },
  ];
  const cases = [...catalog.models, ...synthetic].flatMap((model) =>
    profiles.flatMap((profile) =>
      [...new Set([undefined, 1, 4096, 65536, model.contextLength, model.contextLength + 1])].map(
        (context) => ({
          label: `${model.id}/${profile.platform}/${profile.gpu[0]?.vramBytes ?? 0}/${context ?? "default"}`,
          input: project(model, profile, context),
          output: expected(model, profile, context),
        }),
      ),
    ),
  );
  for (let offset = 0; offset < cases.length; offset += 128) {
    const batch = cases.slice(offset, offset + 128);
    const run = spawnSync(binary, [], {
      cwd: ROOT,
      input: JSON.stringify(batch.map((entry) => entry.input)),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const outputs = z.array(z.unknown()).parse(JSON.parse(run.stdout) as unknown);
    assert.equal(outputs.length, batch.length);
    for (const [index, entry] of batch.entries())
      assert.deepEqual(outputs[index], entry.output, entry.label);
  }
  for (const input of [
    "",
    "{}",
    "[{}]",
    "null",
    "[",
    JSON.stringify([project(synthetic[0]!, profiles[0]!, 0)]),
  ]) {
    const run = spawnSync(binary, [], { cwd: ROOT, input, encoding: "utf8", timeout: 30000 });
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.equal(
      z.object({ code: z.string(), message: z.string() }).parse(JSON.parse(run.stderr)).code,
      "VALIDATION_ERROR",
    );
  }
  const badArgs = spawnSync(binary, ["--unknown"], { encoding: "utf8", timeout: 30000 });
  assert.equal(badArgs.status, 2);
  process.stdout.write(
    `Rust fit parity passed: ${cases.length} cases across ${catalog.models.length} catalog models, ${synthetic.length} synthetic models, ${profiles.length} hardware profiles, plus native failure exits.\n`,
  );
}

runRustFitParity();
