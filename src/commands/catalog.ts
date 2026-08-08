/**
 * The `catalog` command renders the shipped catalog in a stable table format.
 *
 * - Default view (`fits`) shows only models that fit detected hardware.
 * - `--all` shows the full catalog and includes typed fit status.
 * - `--refresh` runs incremental enrichment as a dry-run and reports the diff
 *   without mutating `data/models.json`.
 */
import {
  enrichCatalog,
  type EnrichDiff,
  type EnrichOptions,
  type RawRegistryModel,
} from "../catalog/enrich.js";
import { loadCatalog } from "../catalog/load.js";
import { backendsForModel } from "../catalog/backends.js";
import { REGISTRY_SNAPSHOT } from "../catalog/registry-snapshot.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { detectHardware } from "../hardware/detect.js";
import { requiredMemoryBytes } from "../hardware/memory-math.js";
import { renderTable, type Column } from "../output.js";
import { evaluateFit, type FitReason } from "../ranking/fit.js";
import { immutableSnapshot } from "../immutable.js";
import type { Catalog, CatalogModel, HardwareProfile, Quantization } from "../types.js";

/** Inputs for the `catalog` command. */
export interface CatalogOptions {
  /** Include non-fitting models. Default false (`fits` view). */
  readonly all?: boolean | undefined;
  /** Run incremental enrichment as a local dry-run and print its diff. */
  readonly refresh?: boolean | undefined;
}

/** Injectable side effects, so tests can drive the command deterministically. */
export interface CatalogDeps {
  readonly loadCatalog: () => Catalog;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly loadCandidates: () => readonly RawRegistryModel[];
  readonly enrichCatalog: (options: EnrichOptions) => {
    readonly catalog: Catalog;
    readonly diff: EnrichDiff;
  };
  readonly now: () => Date;
  readonly registry: BackendRegistry;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
}

export interface CatalogRow {
  readonly model: CatalogModel;
  readonly quant: Quantization;
  readonly requiredBytes: number;
  readonly fit: "fit" | FitReason;
  readonly supportedBackends: readonly string[];
}

export interface CatalogResult {
  readonly filter: "fits" | "all";
  readonly total: number;
  readonly hardware: HardwareProfile;
  readonly rows: readonly CatalogRow[];
  readonly refresh: EnrichDiff | null;
  readonly emptyReason: "catalog-empty" | "no-models-fit" | null;
}

const createDefaultDeps = (): CatalogDeps => ({
  loadCatalog: () => loadCatalog(),
  detectHardware: () => detectHardware(),
  loadCandidates: () => REGISTRY_SNAPSHOT,
  enrichCatalog: (options) => enrichCatalog(options),
  now: () => new Date(),
  registry: createDefaultRegistry(),
  write: (text) => process.stdout.write(text),
});

const TABLE_COLUMNS: readonly Column[] = [
  { header: "Model" },
  { header: "Params" },
  { header: "Arch" },
  { header: "Quant" },
  { header: "Need GiB", align: "right" },
  { header: "Fit" },
  { header: "Release" },
];

function byRecencyThenId(a: CatalogModel, b: CatalogModel): number {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate > b.releaseDate ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function formatGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function smallestQuant(model: CatalogModel): Quantization {
  const first = model.quantizations[0];
  if (first === undefined) {
    throw new Error(`catalog model ${JSON.stringify(model.id)} has no quantizations`);
  }
  let smallest = first;
  for (const quant of model.quantizations.slice(1)) {
    const required = requiredMemoryBytes(model, quant);
    const smallestRequired = requiredMemoryBytes(model, smallest);
    if (required < smallestRequired) {
      smallest = quant;
      continue;
    }
    if (required === smallestRequired && quant.name < smallest.name) {
      smallest = quant;
    }
  }
  return smallest;
}

function renderRefresh(diff: EnrichDiff): string {
  const lines: string[] = [
    "Refresh (dry-run):",
    `  added: ${String(diff.added.length)}`,
    `  updated: ${String(diff.updated.length)}`,
    `  removed: ${String(diff.removed.length)}`,
    `  skipped: ${String(diff.skipped.length)}`,
    `  capped: ${String(diff.capped.length)}`,
  ];

  const appendList = (label: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    lines.push(`  ${label}: ${sorted.join(", ")}`);
  };

  appendList("added ids", diff.added);
  appendList("updated ids", diff.updated);
  appendList("removed ids", diff.removed);
  lines.push("  No catalog file was written.");
  return `${lines.join("\n")}\n\n`;
}

/** Render the catalog table and optional refresh diff. */
export async function runCatalog(
  options: CatalogOptions,
  deps: CatalogDeps = createDefaultDeps(),
): Promise<CatalogResult> {
  let catalog = deps.loadCatalog();
  let refreshDiff: EnrichDiff | null = null;

  if (options.refresh === true) {
    const refreshed = deps.enrichCatalog({
      mode: "incremental",
      existing: catalog,
      candidates: deps.loadCandidates(),
      now: deps.now(),
    });
    catalog = refreshed.catalog;
    refreshDiff = refreshed.diff;
    deps.write(renderRefresh(refreshed.diff));
  }

  const hw = await deps.detectHardware();
  const showAll = options.all === true;
  const sorted = [...catalog.models].sort(byRecencyThenId);
  const resultRows: CatalogRow[] = [];

  for (const model of sorted) {
    const fit = evaluateFit(model, hw);
    if (!showAll && !fit.fits) continue;

    if (fit.fits) {
      resultRows.push({
        model,
        quant: fit.quant,
        requiredBytes: fit.requiredBytes,
        fit: "fit",
        supportedBackends: backendsForModel(model, deps.registry, hw).map(
          (adapter) => adapter.name,
        ),
      });
      continue;
    }

    const quant = smallestQuant(model);
    resultRows.push({
      model,
      quant,
      requiredBytes: fit.requiredBytes ?? requiredMemoryBytes(model, quant),
      fit: fit.reason,
      supportedBackends: backendsForModel(model, deps.registry, hw).map(
        (adapter) => adapter.name,
      ),
    });
  }

  const result: CatalogResult = immutableSnapshot({
    filter: showAll ? "all" : "fits",
    total: sorted.length,
    hardware: hw,
    rows: resultRows,
    refresh: refreshDiff,
    emptyReason: resultRows.length > 0 ? null : sorted.length === 0 ? "catalog-empty" : "no-models-fit",
  });
  const rows = result.rows.map((row) => [
    row.model.id,
    row.model.params,
    row.model.architecture,
    row.quant.name,
    formatGiB(row.requiredBytes),
    row.fit,
    row.model.releaseDate,
  ]);
  const header = `Catalog (Filter: ${result.filter}, shown: ${String(rows.length)}/${String(result.total)})`;
  deps.write(`${header}\n`);
  if (rows.length === 0) {
    deps.write("No models fit this hardware. Re-run with --all to see the full catalog.\n");
    return result;
  }
  deps.write(`${renderTable(TABLE_COLUMNS, rows)}\n`);
  return result;
}
