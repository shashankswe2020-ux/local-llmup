/**
 * The `recommend` command: detect hardware, rank the catalog against it, and
 * print a ranked table plus a "won't fit" section and the exact `up` command for
 * the top pick. Pure builders/formatters are separated from I/O so the ranking
 * and rendering can be tested with a fixture catalog and fake hardware.
 */
import { loadCatalog } from "../catalog/load.js";
import { detectHardware } from "../hardware/detect.js";
import {
  kvBytesPerToken,
  kvCacheBytes,
  maxContextTokens,
  usableMemoryBytes,
  usableMemoryKind,
  weightBytes,
} from "../hardware/memory-math.js";
import { loadPerf, type PerfDataset } from "../advisor/perf-data.js";
import { evaluateVerdict } from "../advisor/verdict.js";
import { DEFAULT_THROUGHPUT_BACKEND } from "../advisor/throughput.js";
import { backendsForModel } from "../catalog/backends.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { renderJson, renderTable, type Column } from "../output.js";
import {
  contextTokensForModel,
  rankModels,
  type RankOptions,
  type RankScores,
  type WontFitModel,
} from "../ranking/rank.js";
import { HEADROOM } from "../ranking/weights.js";
import { stripControl } from "../sanitize.js";
import { ValidationError } from "../errors.js";
import { immutableSnapshot } from "../immutable.js";
import { z } from "zod";
import { BACKEND_NAMES } from "../types.js";
import type {
  BackendName,
  Capability,
  Catalog,
  CatalogModel,
  HardwareProfile,
  Quantization,
  Runnable,
  ThroughputEstimate,
} from "../types.js";

const CLI_NAME = "local-llmup";

/**
 * Upper bound for `--context`, well above any current model's cap (largest
 * catalog `contextLength` is 262 144). It rejects absurd input before the KV
 * math runs; a guard test keeps it ≥ the largest catalog context length.
 */
export const CONTEXT_CEILING = 10_000_000;

const contextSchema = z.number().int().min(1).max(CONTEXT_CEILING);

/**
 * Parse and validate a `--context` token count. Throws {@link ValidationError}
 * for anything that is not an integer in `1..CONTEXT_CEILING` (zero, negative,
 * non-numeric, fractional, or over the ceiling).
 */
export function parseContextTokens(raw: string): number {
  const parsed = contextSchema.safeParse(Number(raw));
  if (!parsed.success) {
    throw new ValidationError(
      `--context must be an integer in 1..${String(CONTEXT_CEILING)}: ${raw}`,
    );
  }
  return parsed.data;
}

/**
 * `--context` and `--max-context` are mutually exclusive. Throws
 * {@link ValidationError} when both are requested.
 */
export function assertModesExclusive(
  context: number | undefined,
  maxContext: boolean | undefined,
): void {
  if (context !== undefined && maxContext === true) {
    throw new ValidationError("--context and --max-context are mutually exclusive");
  }
}

const backendSchema = z.enum(BACKEND_NAMES);

/**
 * Parse and validate a `--backend` name. Throws {@link ValidationError} for any
 * value outside the known backend set. The raw input is `stripControl`-cleaned
 * and length-bounded before it is echoed, so a hostile selector cannot inject
 * terminal escapes regardless of how the caller surfaces the message.
 */
export function parseBackendName(raw: string): BackendName {
  const parsed = backendSchema.safeParse(raw);
  if (!parsed.success) {
    const shown = stripControl(raw).slice(0, 80);
    throw new ValidationError(`--backend must be one of ${BACKEND_NAMES.join("|")}: ${shown}`);
  }
  return parsed.data;
}

export interface RecommendOptions {
  /** Boost models advertising this capability; omit to stay capability-neutral. */
  readonly task?: Capability | undefined;
  /** Emit machine-readable JSON instead of a human table. */
  readonly json?: boolean | undefined;
  /** Size the KV cache at this explicit context (tokens); re-ranks and re-verdicts. */
  readonly context?: number | undefined;
  /** Size each model at a percentage of its advertised context (GUI presets). */
  readonly contextPercent?: 25 | 50 | 75 | 100 | undefined;
  /** Report the largest context each model can hold on this hardware. */
  readonly maxContext?: boolean | undefined;
  /** Scope the throughput estimate to this runtime (default `ollama`). */
  readonly backend?: BackendName | undefined;
  /** Opt-in: drop models with no installed servable backend (never in default mode). */
  readonly availableBackends?: boolean | undefined;
}

/** Weights and KV-cache footprint of a model at the requested `--context`. */
export interface ContextSizing {
  readonly tokens: number;
  readonly weightsBytes: number;
  /** KV cache bytes at `tokens`, or `null` when the model has no sourced geometry. */
  readonly kvCacheBytes: number | null;
}

/** Largest holdable context for a model on the detected hardware (`--max-context`). */
export interface MaxContextInfo {
  /** Reported ceiling in tokens, or `null` when the model has no sourced geometry. */
  readonly tokens: number | null;
  /** What binds the ceiling: the `model` cap, the `hardware` budget, or `unknown` geometry. */
  readonly boundBy: "model" | "hardware" | "unknown";
}

/** One ranked, fitting model with its selected quant and score. */
export interface RecommendationEntry {
  readonly rank: number;
  readonly model: CatalogModel;
  readonly quant: Quantization;
  readonly requiredBytes: number;
  readonly score: number;
  readonly scores: RankScores;
  readonly usableBytes: number;
  /** Runnability on this hardware — `yes` or `slow` (fitting models never `no`). */
  readonly verdict: Runnable;
  /** Estimated decode throughput; `known:false` when the hardware has no profile. */
  readonly throughput: ThroughputEstimate;
  readonly throughputEvidence: ThroughputEvidence;
  /** Registered backends that can serve this model, in registration order (may be empty). */
  readonly backends: readonly string[];
  /** Present in `--context` mode: weights + KV footprint at the requested context. */
  readonly contextSizing?: ContextSizing;
  /** Present in `--max-context` mode: the largest holdable context. */
  readonly maxContext?: MaxContextInfo;
}

export interface ThroughputEvidence {
  readonly backend: BackendName;
  readonly source: "offline-estimate";
  readonly unknownReason: "no-sourced-performance-profile" | null;
}

/** The full recommendation: what fits, what does not, and the top-pick command. */
export interface RecommendationResult {
  readonly task: Capability | null;
  readonly availableBackendsOnly: boolean;
  readonly hardware: HardwareProfile;
  readonly usableBytes: number;
  readonly memoryKind: "ram" | "vram";
  readonly entries: readonly RecommendationEntry[];
  readonly wontFit: readonly WontFitModel[];
  /** `local-llmup up <id>` for the top pick, or `null` when nothing fits. */
  readonly command: string | null;
  /** The runtime the throughput estimate is scoped to (deterministic default `ollama`). */
  readonly throughputBackend: BackendName;
  /** The requested `--context` (tokens), present only in context mode. */
  readonly context?: number;
  /** True when `--max-context` was requested. */
  readonly maxContextMode: boolean;
}

/** Weights + KV footprint of one model/quant at `tokens` (KV null when unknown). */
function buildContextSizing(
  model: CatalogModel,
  quant: Quantization,
  tokens: number,
): ContextSizing {
  const perToken = kvBytesPerToken(model);
  return {
    tokens,
    weightsBytes: weightBytes(model, quant),
    kvCacheBytes: perToken !== undefined ? kvCacheBytes(perToken, tokens) : null,
  };
}

/** Largest holdable context for one model/quant within the headroom-adjusted budget. */
function buildMaxContext(
  model: CatalogModel,
  quant: Quantization,
  usableBytes: number,
): MaxContextInfo {
  const budget = usableBytes * (1 - HEADROOM);
  const memoryMax = maxContextTokens(model, quant, budget);
  if (memoryMax === undefined) return { tokens: null, boundBy: "unknown" };
  const cap = model.contextLength;
  // min(memory ceiling, model cap): the model cap is a hard semantic limit that
  // more RAM cannot lift, so when memory allows more the cap binds ("model").
  return { tokens: Math.min(memoryMax, cap), boundBy: memoryMax < cap ? "hardware" : "model" };
}

/** Rank `catalog` against `hardware` into a renderable recommendation. */
export function buildRecommendation(
  catalog: Catalog,
  hardware: HardwareProfile,
  perf: PerfDataset,
  options: RecommendOptions = {},
  registry: BackendRegistry = createDefaultRegistry(),
  availableBackendNames?: readonly string[],
): RecommendationResult {
  const sizingModes = [
    options.context !== undefined,
    options.contextPercent !== undefined,
    options.maxContext === true,
  ].filter(Boolean).length;
  if (sizingModes > 1) {
    throw new ValidationError("context, contextPercent, and maxContext are mutually exclusive");
  }
  const rankOptions: RankOptions = {
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.contextPercent !== undefined ? { contextPercent: options.contextPercent } : {}),
  };
  const ranking = rankModels(catalog, hardware, rankOptions);
  const usableBytes = usableMemoryBytes(hardware);
  const throughputBackend = options.backend ?? DEFAULT_THROUGHPUT_BACKEND;

  let entries: RecommendationEntry[] = ranking.ranked.map((ranked, index) => {
    const contextTokens =
      options.contextPercent !== undefined
        ? contextTokensForModel(ranked.model, options.contextPercent)
        : options.context;
    const verdict = evaluateVerdict(
      ranked.model,
      hardware,
      perf,
      contextTokens,
      throughputBackend,
    );
    const contextSizing =
      contextTokens !== undefined
        ? buildContextSizing(ranked.model, ranked.quant, contextTokens)
        : undefined;
    const maxContext =
      options.maxContext === true
        ? buildMaxContext(ranked.model, ranked.quant, usableBytes)
        : undefined;
    return {
      rank: index + 1,
      model: ranked.model,
      quant: ranked.quant,
      requiredBytes: ranked.requiredBytes,
      score: ranked.score,
      scores: ranked.scores,
      usableBytes: ranked.usableBytes,
      verdict: verdict.runnable,
      throughput: verdict.throughput,
      throughputEvidence: {
        backend: throughputBackend,
        source: "offline-estimate",
        unknownReason: verdict.throughput.known ? null : "no-sourced-performance-profile",
      },
      backends: backendsForModel(ranked.model, registry, hardware).map((adapter) => adapter.name),
      ...(contextSizing !== undefined ? { contextSizing } : {}),
      ...(maxContext !== undefined ? { maxContext } : {}),
    };
  });
  let wontFit = ranking.wontFit;

  // `--available-backends` (opt-in only): drop models no installed backend can
  // serve, then renumber the surviving ranks contiguously. Default mode leaves
  // `availableBackendNames` undefined and never drops a model.
  if (availableBackendNames !== undefined) {
    const installed = new Set(availableBackendNames);
    entries = entries
      .filter((entry) => entry.backends.some((name) => installed.has(name)))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    wontFit = wontFit.filter((entry) =>
      backendsForModel(entry.model, registry, hardware).some((adapter) =>
        installed.has(adapter.name),
      ),
    );
  }

  const top = entries[0];
  return immutableSnapshot({
    task: options.task ?? null,
    availableBackendsOnly: options.availableBackends === true,
    hardware,
    usableBytes,
    memoryKind: usableMemoryKind(hardware),
    entries,
    wontFit,
    command: top !== undefined ? `${CLI_NAME} up ${top.model.id}` : null,
    throughputBackend,
    ...(options.context !== undefined ? { context: options.context } : {}),
    maxContextMode: options.maxContext === true,
  });
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Human-facing symbol for each verdict. */
const VERDICT_SYMBOL: Readonly<Record<Runnable, string>> = {
  yes: "✓",
  slow: "⚠️",
  no: "❌",
};

/** "<symbol> <word>" verdict label for the table cell. */
function verdictLabel(verdict: Runnable): string {
  return `${VERDICT_SYMBOL[verdict]} ${verdict}`;
}

/** Throughput range for a table cell, honouring the honesty gate. */
function tokRange(t: ThroughputEstimate): string {
  if (!t.known) return "unknown";
  return `${String(t.lowTokPerSec)}–${String(t.highTokPerSec)}`;
}

/** A byte cell that renders `unknown` for an absent (honesty-gated) figure. */
function bytesOrUnknown(bytes: number | null): string {
  return bytes === null ? "unknown" : formatGiB(bytes);
}

/** A token count grouped for readability, or `unknown` when absent. */
function tokensOrUnknown(tokens: number | null): string {
  return tokens === null ? "unknown" : tokens.toLocaleString("en-US");
}

const BASE_COLUMNS: readonly Column[] = [
  { header: "Rank", align: "right" },
  { header: "Model" },
  { header: "Params", align: "right" },
  { header: "Quant" },
];

const TAIL_COLUMNS: readonly Column[] = [
  { header: "Verdict" },
  { header: "Est. tok/s", align: "right" },
  { header: "Backends" },
  { header: "License" },
  { header: "Score", align: "right" },
];

/** Columns for the current mode: base + mode-specific footprint columns + tail. */
function tableColumns(result: RecommendationResult): readonly Column[] {
  const middle: readonly Column[] =
    result.context !== undefined
      ? [
          { header: "Weights", align: "right" },
          { header: "KV Cache", align: "right" },
          { header: "Est. Mem", align: "right" },
        ]
      : result.maxContextMode
        ? [
            { header: "Est. Mem", align: "right" },
            { header: "Max Context", align: "right" },
            { header: "Bound-By" },
          ]
        : [{ header: "Est. Mem", align: "right" }];
  return [...BASE_COLUMNS, ...middle, ...TAIL_COLUMNS];
}

/** One table row for `entry`, matching the columns for the current mode. */
function tableRow(entry: RecommendationEntry, result: RecommendationResult): readonly string[] {
  const head = [String(entry.rank), entry.model.id, entry.model.params, entry.quant.name];
  const tail = [
    verdictLabel(entry.verdict),
    tokRange(entry.throughput),
    entry.backends.length > 0 ? entry.backends.join(", ") : "—",
    entry.model.license,
    entry.score.toFixed(2),
  ];
  let middle: string[];
  if (result.context !== undefined) {
    const cs = entry.contextSizing;
    middle = [
      cs !== undefined ? formatGiB(cs.weightsBytes) : "",
      cs !== undefined ? bytesOrUnknown(cs.kvCacheBytes) : "",
      formatGiB(entry.requiredBytes),
    ];
  } else if (result.maxContextMode) {
    const mc = entry.maxContext;
    middle = [
      formatGiB(entry.requiredBytes),
      mc !== undefined ? tokensOrUnknown(mc.tokens) : "",
      mc !== undefined ? mc.boundBy : "",
    ];
  } else {
    middle = [formatGiB(entry.requiredBytes)];
  }
  return [...head, ...middle, ...tail];
}

/** A one-line note describing the active sizing mode, appended to the header. */
function modeNote(result: RecommendationResult): string {
  if (result.context !== undefined) {
    return ` — sized at ${String(result.context)}-token context (KV fp16)`;
  }
  if (result.maxContextMode) return " — largest holdable context per model (KV fp16)";
  return "";
}

function wontFitSection(wontFit: readonly WontFitModel[]): string {
  // Sanitize ids here too: unlike the table/JSON renderers, this plain-text
  // section interpolates catalog strings directly, so it must strip escapes.
  const rows = wontFit.map(
    (entry) => `  ${VERDICT_SYMBOL.no} ${stripControl(entry.model.id)}  (${entry.reason})`,
  );
  return [`Won't fit (${wontFit.length}):`, ...rows].join("\n");
}

/** Render the human-readable report: header, table, top-pick command, misfits. */
export function formatRecommendationText(result: RecommendationResult): string {
  if (result.entries.length === 0 && result.wontFit.length === 0) {
    return "No models in the catalog.";
  }

  const header = `Ranked local LLMs for ${result.hardware.arch}/${result.hardware.platform} (${formatGiB(
    result.usableBytes,
  )} ${result.memoryKind} usable):${modeNote(result)}`;
  const sections: string[] = [header];

  if (result.entries.length === 0) {
    sections.push("No models fit this hardware.");
  } else {
    const columns = tableColumns(result);
    const rows = result.entries.map((entry) => tableRow(entry, result));
    sections.push(renderTable(columns, rows));
    if (result.command !== null) {
      sections.push(`Run the top pick:  ${stripControl(result.command)}`);
    }
  }

  if (result.wontFit.length > 0) {
    sections.push(wontFitSection(result.wontFit));
  }

  return sections.join("\n\n");
}

/** Additive `--context` / `--max-context` JSON fields for one ranked entry. */
function sizingJsonFields(entry: RecommendationEntry): Record<string, unknown> {
  if (entry.contextSizing !== undefined) {
    return {
      context: entry.contextSizing.tokens,
      weightsBytes: entry.contextSizing.weightsBytes,
      kvCacheBytes: entry.contextSizing.kvCacheBytes,
      kvPrecision: "fp16",
    };
  }
  if (entry.maxContext !== undefined) {
    return {
      maxContextTokens: entry.maxContext.tokens,
      boundBy: entry.maxContext.boundBy,
      kvPrecision: "fp16",
    };
  }
  return {};
}

/** Render the stable machine-readable report for `--json`. */
export function formatRecommendationJson(result: RecommendationResult): string {
  return renderJson({
    hardware: {
      arch: result.hardware.arch,
      platform: result.hardware.platform,
      usableMemoryBytes: result.usableBytes,
      memoryKind: result.memoryKind,
    },
    ranked: result.entries.map((entry) => ({
      rank: entry.rank,
      id: entry.model.id,
      family: entry.model.family,
      params: entry.model.params,
      quant: entry.quant.name,
      requiredBytes: entry.requiredBytes,
      license: entry.model.license,
      capabilities: [...entry.model.capabilities],
      score: entry.score,
      verdict: entry.verdict,
      estTokPerSec: entry.throughput.known
        ? {
            lowTokPerSec: entry.throughput.lowTokPerSec,
            highTokPerSec: entry.throughput.highTokPerSec,
          }
        : null,
      backends: [...entry.backends],
      throughputBackend: result.throughputBackend,
      ...sizingJsonFields(entry),
    })),
    wontFit: result.wontFit.map((entry) => ({ id: entry.model.id, reason: entry.reason })),
    command: result.command,
  });
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface RecommendDeps {
  readonly loadCatalog: () => Catalog;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly loadPerf: () => PerfDataset;
  readonly registry: BackendRegistry;
  readonly write: (text: string) => void;
}

const defaultDeps: RecommendDeps = {
  loadCatalog: () => loadCatalog(),
  detectHardware: () => detectHardware(),
  loadPerf: () => loadPerf(),
  registry: createDefaultRegistry(),
  write: (text) => process.stdout.write(text),
};

/** Execute recommendation domain work once without selecting a presentation. */
export async function collectRecommendation(
  options: RecommendOptions = {},
  deps: RecommendDeps = defaultDeps,
): Promise<RecommendationResult> {
  const catalog = deps.loadCatalog();
  const hardware = await deps.detectHardware();
  const perf = deps.loadPerf();
  // `--available-backends` is the only branch that probes installation; the
  // default advice path never calls `isInstalled()`, so output is deterministic.
  const availableBackendNames =
    options.availableBackends === true
      ? (await deps.registry.available()).map((adapter) => adapter.name)
      : undefined;
  const result = buildRecommendation(
    catalog,
    hardware,
    perf,
    options,
    deps.registry,
    availableBackendNames,
  );
  return result;
}

/** Load the catalog, detect hardware, and write the recommendation report. */
export async function runRecommend(
  options: RecommendOptions = {},
  deps: RecommendDeps = defaultDeps,
): Promise<RecommendationResult> {
  const result = await collectRecommendation(options, deps);
  const report = options.json ? formatRecommendationJson(result) : formatRecommendationText(result);
  deps.write(`${report}\n`);
  return result;
}
