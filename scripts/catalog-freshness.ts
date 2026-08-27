/**
 * Weekly catalog freshness check.
 *
 * Loads the committed catalog, runs the incremental enrich over the offline
 * registry snapshot to measure drift, and reports the catalog's age plus whether
 * a maintainer should refresh it. It never writes catalog files and makes no
 * network call (the snapshot is committed) — it only reports.
 *
 * Output: a human-readable report on stderr, a machine-readable JSON report at
 * `catalog-freshness.json` (or `--out <path>`), and the same JSON on stdout when
 * `--json` is passed. When `$GITHUB_STEP_SUMMARY` is set, the human report is
 * appended there too. Always exits 0; consumers act on `needsAttention`.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { enrichCatalog } from "../src/catalog/enrich.js";
import {
  evaluateCatalogFreshness,
  formatFreshnessReport,
} from "../src/catalog/freshness.js";
import { loadCatalog } from "../src/catalog/load.js";
import { REGISTRY_SNAPSHOT } from "../src/catalog/registry-snapshot.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const now = new Date();
  const catalog = loadCatalog();
  const { diff } = enrichCatalog({
    mode: "incremental",
    existing: catalog,
    candidates: REGISTRY_SNAPSHOT,
    now,
  });
  const report = evaluateCatalogFreshness({ catalog, diff, now });

  const human = formatFreshnessReport(report);
  process.stderr.write(`${human}\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath.length > 0) {
    appendFileSync(summaryPath, `### Catalog freshness\n\n\`\`\`\n${human}\n\`\`\`\n`);
  }

  const json = JSON.stringify(report);
  writeFileSync(argValue("--out") ?? "catalog-freshness.json", `${json}\n`);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${json}\n`);
  }
}

main();
