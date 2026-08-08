import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const PRE_TUI_COMMIT = "3984ae63faf2349eac9e73ba048e7a92ce5d77a6";
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 20;
const MEDIAN_REGRESSION_LIMIT_MS = 10;
const P90_REGRESSION_LIMIT_MS = 20;
const TUI_MODULE_LOAD_P90_LIMIT_MS = 150;

interface Distribution {
  readonly median: number;
  readonly p90: number;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function quantile(sorted: readonly number[], percentile: number): number {
  const value = sorted[Math.ceil(percentile * sorted.length) - 1];
  if (value === undefined) throw new Error("cannot take a quantile of an empty sample");
  return value;
}

function distribution(samples: readonly number[]): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
}

function measureProcess(entry: string): number {
  const started = performance.now();
  const result = spawnSync(process.execPath, [entry, "--version"], { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`cold-start probe failed for ${entry}`);
  return performance.now() - started;
}

function measureImport(modulePath: string): number {
  const source =
    'import{performance}from"node:perf_hooks";' +
    `const t=performance.now();await import(${JSON.stringify(pathToFileURL(modulePath).href)});` +
    'process.stdout.write(String(performance.now()-t));';
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`module-load probe failed: ${result.stderr}`);
  const duration = Number(result.stdout);
  if (!Number.isFinite(duration)) throw new Error("module-load probe returned a non-number");
  return duration;
}

export function runTuiRuntimeBudget(root = process.cwd()): void {
  const baseline = mkdtempSync(join(tmpdir(), "local-llmup-pre-tui-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", baseline, PRE_TUI_COMMIT], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync(npmCommand(), ["ci", "--ignore-scripts"], { cwd: baseline, stdio: "ignore" });
    execFileSync(npmCommand(), ["run", "build"], { cwd: baseline, stdio: "ignore" });

    const baselineEntry = join(baseline, "dist", "bin.js");
    const candidateEntry = join(root, "dist", "bin.js");
    for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
      measureProcess(baselineEntry);
      measureProcess(candidateEntry);
    }
    const baselineSamples: number[] = [];
    const candidateSamples: number[] = [];
    for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
      baselineSamples.push(measureProcess(baselineEntry));
      candidateSamples.push(measureProcess(candidateEntry));
    }
    const baselineStats = distribution(baselineSamples);
    const candidateStats = distribution(candidateSamples);
    if (candidateStats.median > baselineStats.median + MEDIAN_REGRESSION_LIMIT_MS) {
      throw new Error(
        `plain cold-start median regression ${String(candidateStats.median - baselineStats.median)}ms exceeds ${String(MEDIAN_REGRESSION_LIMIT_MS)}ms`,
      );
    }
    if (candidateStats.p90 > baselineStats.p90 + P90_REGRESSION_LIMIT_MS) {
      throw new Error(
        `plain cold-start p90 regression ${String(candidateStats.p90 - baselineStats.p90)}ms exceeds ${String(P90_REGRESSION_LIMIT_MS)}ms`,
      );
    }

    const rendererModule = join(root, "dist", "tui", "renderer-proof.js");
    const moduleSamples = Array.from({ length: MEASURED_SAMPLES }, () =>
      measureImport(rendererModule),
    );
    const moduleP90 = distribution(moduleSamples).p90;
    if (moduleP90 > TUI_MODULE_LOAD_P90_LIMIT_MS) {
      throw new Error(
        `TUI module-load p90 ${String(moduleP90)}ms exceeds ${String(TUI_MODULE_LOAD_P90_LIMIT_MS)}ms`,
      );
    }
    process.stdout.write(
      `TUI runtime budget passed (plain median ${candidateStats.median.toFixed(1)}ms vs ${baselineStats.median.toFixed(1)}ms; p90 ${candidateStats.p90.toFixed(1)}ms vs ${baselineStats.p90.toFixed(1)}ms; module p90 ${moduleP90.toFixed(1)}ms).\n`,
    );
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", baseline], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      rmSync(baseline, { recursive: true, force: true });
    }
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) runTuiRuntimeBudget();
