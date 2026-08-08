/**
 * The `can-run <model>` command: a single, scriptable yes/slow/no answer for
 * "will this machine run this model?". It resolves the requested name against
 * the catalog (reusing the shared resolver), detects hardware, loads the
 * performance dataset, and asks the pure {@link evaluateVerdict} engine.
 *
 * The command is a thin wrapper: all judgement lives in the advisor engines.
 * Its one command-layer responsibility is the exit contract — a `no` verdict is
 * the only outcome that flips a non-zero exit, so `local-llmup can-run <model>`
 * can gate a script (`if can-run foo; then up foo; fi`). `yes` and `slow` both
 * exit zero (the model runs; `slow` is a comfort warning, not a failure).
 *
 * Side effects are injected via {@link CanRunDeps} so the flow can be driven
 * with fakes in tests.
 */
import { loadCatalog } from "../catalog/load.js";
import { detectHardware } from "../hardware/detect.js";
import { loadPerf, type PerfDataset } from "../advisor/perf-data.js";
import { evaluateVerdict } from "../advisor/verdict.js";
import { DEFAULT_THROUGHPUT_BACKEND } from "../advisor/throughput.js";
import { backendsForModel } from "../catalog/backends.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { renderJson } from "../output.js";
import { resolveModel } from "../resolver.js";
import { stripControl } from "../sanitize.js";
import type { FitReason } from "../ranking/fit.js";
import type {
  BackendName,
  Catalog,
  CatalogModel,
  HardwareProfile,
  Runnable,
  ThroughputEstimate,
} from "../types.js";

/** Inputs for `can-run`. */
export interface CanRunOptions {
  readonly model: string;
  /** Emit machine-readable JSON instead of a human line. */
  readonly json?: boolean | undefined;
  /** Scope the throughput estimate to this runtime (default `ollama`). */
  readonly backend?: BackendName | undefined;
}

/** The verdict plus the evidence, flattened for rendering and JSON. */
export interface CanRunResult {
  readonly modelId: string;
  readonly runnable: Runnable;
  readonly throughput: ThroughputEstimate;
  /** The fitting quant name, or `null` when the model does not fit. */
  readonly quant: string | null;
  /** Why the model does not fit, or `null` for `yes`/`slow`. */
  readonly reason: FitReason | null;
  /** Registered backends that can serve this model (may be empty). */
  readonly backends: readonly string[];
  /** The runtime the throughput estimate is scoped to (deterministic default `ollama`). */
  readonly throughputBackend: BackendName;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface CanRunDeps {
  readonly loadCatalog: () => Catalog;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly loadPerf: () => PerfDataset;
  readonly registry: BackendRegistry;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
}

const defaultDeps: CanRunDeps = {
  loadCatalog: () => loadCatalog(),
  detectHardware: () => detectHardware(),
  loadPerf: () => loadPerf(),
  registry: createDefaultRegistry(),
  write: (text) => process.stdout.write(text),
};

/** Human-facing symbol for each verdict. */
const SYMBOL: Readonly<Record<Runnable, string>> = {
  yes: "✓",
  slow: "⚠️",
  no: "❌",
};

/** Human label for each fit reason. */
const REASON_LABEL: Readonly<Record<FitReason, string>> = {
  "vram-bound": "not enough VRAM",
  "ram-bound": "not enough RAM",
  "disk-bound": "not enough free disk",
  "context-bound": "context exceeds the model's limit",
};

/** Central estimate of a known range, rounded to one decimal. */
function midpoint(t: ThroughputEstimate): number {
  return Math.round(((t.lowTokPerSec + t.highTokPerSec) / 2) * 10) / 10;
}

/** Run the verdict engine and flatten the result for rendering. */
export function buildCanRunResult(
  model: CatalogModel,
  hardware: HardwareProfile,
  perf: PerfDataset,
  backend: BackendName = DEFAULT_THROUGHPUT_BACKEND,
  registry: BackendRegistry = createDefaultRegistry(),
): CanRunResult {
  const verdict = evaluateVerdict(model, hardware, perf, undefined, backend);
  return {
    modelId: model.id,
    runnable: verdict.runnable,
    throughput: verdict.throughput,
    quant: verdict.quant?.name ?? null,
    reason: verdict.reason ?? null,
    backends: backendsForModel(model, registry, hardware).map((adapter) => adapter.name),
    throughputBackend: backend,
  };
}

/** Format the estimated throughput, honouring the honesty gate. */
function throughputLine(t: ThroughputEstimate): string {
  if (!t.known) {
    return "Estimated throughput: unknown (no performance profile for this hardware)";
  }
  return `Estimated throughput: ${String(t.lowTokPerSec)}–${String(t.highTokPerSec)} tok/s`;
}

/** Render the one-line-plus-detail human report. */
export function formatCanRunText(result: CanRunResult): string {
  const id = stripControl(result.modelId);
  const lines: string[] = [];

  if (result.runnable === "no") {
    const reason = result.reason ?? "vram-bound";
    lines.push(`${SYMBOL.no} ${id}: no — does not fit (${reason}: ${REASON_LABEL[reason]})`);
    return lines.join("\n");
  }

  const detail =
    result.runnable === "yes"
      ? "runs comfortably"
      : result.throughput.known
        ? `fits, but ~${String(midpoint(result.throughput))} tok/s is below the comfort floor`
        : "fits, but throughput can't be estimated for this hardware";
  lines.push(`${SYMBOL[result.runnable]} ${id}: ${result.runnable} — ${detail}`);
  if (result.quant !== null) lines.push(`Quant: ${stripControl(result.quant)}`);
  lines.push(throughputLine(result.throughput));
  lines.push(
    `Backends: ${result.backends.length > 0 ? result.backends.join(", ") : "none"} (throughput scoped to ${result.throughputBackend})`,
  );
  return lines.join("\n");
}

/** Render the stable machine-readable report for `--json`. */
export function formatCanRunJson(result: CanRunResult): string {
  return renderJson({
    model: result.modelId,
    verdict: result.runnable,
    quant: result.quant,
    reason: result.reason,
    throughput: {
      known: result.throughput.known,
      lowTokPerSec: result.throughput.lowTokPerSec,
      highTokPerSec: result.throughput.highTokPerSec,
    },
    backends: [...result.backends],
    throughputBackend: result.throughputBackend,
  });
}

/**
 * Resolve, detect, and answer whether `options.model` runs on this machine.
 * Returns the {@link CanRunResult} so the CLI can gate its exit code (non-zero
 * only for `no`).
 */
export async function runCanRun(
  options: CanRunOptions,
  deps: CanRunDeps = defaultDeps,
): Promise<CanRunResult> {
  const catalog = deps.loadCatalog();
  const resolved = resolveModel(catalog, options.model);
  const model =
    resolved.quant !== undefined
      ? { ...resolved.model, quantizations: [resolved.quant] }
      : resolved.model;
  const hardware = await deps.detectHardware();
  const perf = deps.loadPerf();

  const result = buildCanRunResult(
    model,
    hardware,
    perf,
    options.backend ?? DEFAULT_THROUGHPUT_BACKEND,
    deps.registry,
  );
  deps.write(`${options.json === true ? formatCanRunJson(result) : formatCanRunText(result)}\n`);
  return result;
}
