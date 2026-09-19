import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCatalog } from "../src/catalog/load.js";
import { loadPerf } from "../src/advisor/perf-data.js";
import { createDefaultRegistry } from "../src/backend/registry.js";
import { buildRecommendation } from "../src/commands/recommend.js";
import { createModelManager, type RecommendedOptions } from "../src/gui/management.js";
import type { HardwareProfile } from "../src/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync("cargo", ["build", "--locked", "-p", "llmup-gui", "--example", "parity"], { cwd: root, stdio: "inherit" });
const binary = join(root, "target", "debug", "examples", process.platform === "win32" ? "parity.exe" : "parity");
const catalog = loadCatalog();
const perf = loadPerf();
const registry = createDefaultRegistry();
const gib = 1024 ** 3;
const profiles: HardwareProfile[] = [
  { arch: "arm64", platform: "darwin", totalRamBytes: 32 * gib, freeRamBytes: 24 * gib, freeDiskBytes: 500 * gib, gpu: [{ vendor: "apple", vramBytes: 0 }] },
  { arch: "x64", platform: "linux", totalRamBytes: 32 * gib, freeRamBytes: 24 * gib, freeDiskBytes: 500 * gib, gpu: [{ vendor: "nvidia", vramBytes: 8 * gib }] },
  { arch: "x64", platform: "win32", totalRamBytes: 16 * gib, freeRamBytes: 8 * gib, freeDiskBytes: 100 * gib, gpu: [] },
];
const modes: RecommendedOptions[] = [{}, { contextPreset: "low" }, { contextPreset: "mid" }, { contextPreset: "high" }, { contextPreset: "max" }, { context: 65536 }, { runtime: "mlx" }, { runtime: "llamacpp" }];
const requests: unknown[] = [];
const expected: unknown[] = [];
for (const hardware of profiles) {
  const manager = createModelManager({ collectRecommendation: async (options) => buildRecommendation(catalog, hardware, perf, options ?? {}, registry), collectLs: () => ({ type: "empty" }), runUp: async () => { throw new Error("no runtime operations in parity"); } });
  for (const mode of modes) {
    const percentages = { low: 25, mid: 50, high: 75, max: 100 };
    requests.push({ hardware, options: { backend: mode.runtime, context: mode.context, contextPercent: mode.contextPreset === undefined ? undefined : percentages[mode.contextPreset] } });
    expected.push(await manager.recommended(mode));
  }
}
const actual = z.array(z.unknown()).parse(JSON.parse(execFileSync(binary, [], { input: JSON.stringify(requests), encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 })));
function compare(actual: unknown, expected: unknown): void {
  if (typeof expected === "number" && typeof actual === "number") { assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected))); return; }
  if (Array.isArray(expected)) { assert.ok(Array.isArray(actual)); assert.equal(actual.length, expected.length); expected.forEach((value: unknown, index) => compare(actual[index], value)); return; }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object");
    const wanted = expected as Record<string, unknown>; const got = actual as Record<string, unknown>;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(wanted).filter((key) => wanted[key] !== undefined).sort());
    for (const [key, value] of Object.entries(wanted)) if (value !== undefined) compare(got[key], value);
    return;
  }
  assert.equal(actual, expected);
}
compare(actual, expected);
console.log(`Native GUI recommendation parity passed: ${requests.length} complete model-list contracts.`);