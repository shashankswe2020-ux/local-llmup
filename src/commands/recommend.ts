/**
 * The `recommend` command: detect hardware, rank the catalog against it, and
 * print a ranked table plus a "won't fit" section and the exact `up` command for
 * the top pick. Pure builders/formatters are separated from I/O so the ranking
 * and rendering can be tested with a fixture catalog and fake hardware.
 */
import { loadCatalog } from "../catalog/load.js";
import { detectHardware } from "../hardware/detect.js";
import { usableMemoryBytes, usableMemoryKind } from "../hardware/memory-math.js";
import { renderJson, renderTable, type Column } from "../output.js";
import { rankModels, type WontFitModel } from "../ranking/rank.js";
import { stripControl } from "../sanitize.js";
import type { Capability, Catalog, CatalogModel, HardwareProfile, Quantization } from "../types.js";

const CLI_NAME = "local-llmup";

export interface RecommendOptions {
  /** Boost models advertising this capability; omit to stay capability-neutral. */
  readonly task?: Capability | undefined;
  /** Emit machine-readable JSON instead of a human table. */
  readonly json?: boolean | undefined;
}

/** One ranked, fitting model with its selected quant and score. */
export interface RecommendationEntry {
  readonly rank: number;
  readonly model: CatalogModel;
  readonly quant: Quantization;
  readonly requiredBytes: number;
  readonly score: number;
}

/** The full recommendation: what fits, what does not, and the top-pick command. */
export interface RecommendationResult {
  readonly hardware: HardwareProfile;
  readonly usableBytes: number;
  readonly memoryKind: "ram" | "vram";
  readonly entries: readonly RecommendationEntry[];
  readonly wontFit: readonly WontFitModel[];
  /** `local-llmup up <id>` for the top pick, or `null` when nothing fits. */
  readonly command: string | null;
}

/** Rank `catalog` against `hardware` into a renderable recommendation. */
export function buildRecommendation(
  catalog: Catalog,
  hardware: HardwareProfile,
  options: RecommendOptions = {},
): RecommendationResult {
  const ranking = rankModels(
    catalog,
    hardware,
    options.task !== undefined ? { task: options.task } : {},
  );

  const entries: RecommendationEntry[] = ranking.ranked.map((ranked, index) => ({
    rank: index + 1,
    model: ranked.model,
    quant: ranked.quant,
    requiredBytes: ranked.requiredBytes,
    score: ranked.score,
  }));

  const top = entries[0];
  return {
    hardware,
    usableBytes: usableMemoryBytes(hardware),
    memoryKind: usableMemoryKind(hardware),
    entries,
    wontFit: ranking.wontFit,
    command: top !== undefined ? `${CLI_NAME} up ${top.model.id}` : null,
  };
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

const TABLE_COLUMNS: readonly Column[] = [
  { header: "Rank", align: "right" },
  { header: "Model" },
  { header: "Params", align: "right" },
  { header: "Quant" },
  { header: "Est. Mem", align: "right" },
  { header: "License" },
  { header: "Score", align: "right" },
];

function wontFitSection(wontFit: readonly WontFitModel[]): string {
  // Sanitize ids here too: unlike the table/JSON renderers, this plain-text
  // section interpolates catalog strings directly, so it must strip escapes.
  const rows = wontFit.map((entry) => `  ${stripControl(entry.model.id)}  (${entry.reason})`);
  return [`Won't fit (${wontFit.length}):`, ...rows].join("\n");
}

/** Render the human-readable report: header, table, top-pick command, misfits. */
export function formatRecommendationText(result: RecommendationResult): string {
  if (result.entries.length === 0 && result.wontFit.length === 0) {
    return "No models in the catalog.";
  }

  const header = `Ranked local LLMs for ${result.hardware.arch}/${result.hardware.platform} (${formatGiB(
    result.usableBytes,
  )} ${result.memoryKind} usable):`;
  const sections: string[] = [header];

  if (result.entries.length === 0) {
    sections.push("No models fit this hardware.");
  } else {
    const rows = result.entries.map((entry) => [
      String(entry.rank),
      entry.model.id,
      entry.model.params,
      entry.quant.name,
      formatGiB(entry.requiredBytes),
      entry.model.license,
      entry.score.toFixed(2),
    ]);
    sections.push(renderTable(TABLE_COLUMNS, rows));
    if (result.command !== null) {
      sections.push(`Run the top pick:  ${stripControl(result.command)}`);
    }
  }

  if (result.wontFit.length > 0) {
    sections.push(wontFitSection(result.wontFit));
  }

  return sections.join("\n\n");
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
    })),
    wontFit: result.wontFit.map((entry) => ({ id: entry.model.id, reason: entry.reason })),
    command: result.command,
  });
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface RecommendDeps {
  readonly loadCatalog: () => Catalog;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly write: (text: string) => void;
}

const defaultDeps: RecommendDeps = {
  loadCatalog: () => loadCatalog(),
  detectHardware: () => detectHardware(),
  write: (text) => process.stdout.write(text),
};

/** Load the catalog, detect hardware, and write the recommendation report. */
export async function runRecommend(
  options: RecommendOptions = {},
  deps: RecommendDeps = defaultDeps,
): Promise<void> {
  const catalog = deps.loadCatalog();
  const hardware = await deps.detectHardware();
  const result = buildRecommendation(catalog, hardware, options);
  const report = options.json
    ? formatRecommendationJson(result)
    : formatRecommendationText(result);
  deps.write(`${report}\n`);
}
