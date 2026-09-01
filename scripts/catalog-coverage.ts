/**
 * Compare the curated catalog with Ollama's own local-library integration
 * inventory. This is an alerting signal only: missing repositories are never
 * auto-admitted without curated license, architecture, context, and sizing data.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import {
  evaluateCatalogCoverage,
  fetchOllamaLibraryInventory,
  OLLAMA_LIBRARY_INVENTORY_URL,
  selectMonitoredOllamaModels,
  type CoverageFetchLike,
} from "../src/catalog/coverage.js";
import { loadCatalog } from "../src/catalog/load.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const fetchImpl = (globalThis as { fetch?: CoverageFetchLike }).fetch;
  if (fetchImpl === undefined) throw new Error("global fetch is unavailable");

  const upstream = await fetchOllamaLibraryInventory({ fetch: fetchImpl });
  const catalog = loadCatalog();
  const monitored = selectMonitoredOllamaModels(catalog, upstream);
  const coverage = evaluateCatalogCoverage(catalog, monitored);
  const report = {
    source: OLLAMA_LIBRARY_INVENTORY_URL,
    checkedAt: new Date().toISOString(),
    inventoryCount: upstream.length,
    ...coverage,
  };
  const human = [
    "Catalog coverage",
    `  upstream: ${String(report.upstreamCount)}`,
    `  covered:  ${String(report.coveredCount)}`,
    `  missing:  ${String(report.missing.length)}`,
  ].join("\n");
  process.stderr.write(`${human}\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath.length > 0) {
    appendFileSync(summaryPath, `### Catalog coverage\n\n\`\`\`\n${human}\n\`\`\`\n`);
  }

  const json = `${JSON.stringify(report)}\n`;
  writeFileSync(argValue("--out") ?? "catalog-coverage.json", json, "utf8");
  if (process.argv.includes("--json")) process.stdout.write(json);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `catalog-coverage failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});