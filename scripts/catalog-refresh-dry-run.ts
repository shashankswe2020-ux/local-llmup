/**
 * Incremental enrichment dry-run used by CI workflows.
 *
 * This script never writes catalog files. It loads the committed catalog,
 * runs the incremental enrich pipeline over the recorded snapshot, prints a
 * diff summary to stderr, and fails if `data/models.json` changed on disk.
 */
import { readFileSync } from "node:fs";
import { enrichCatalog } from "../src/catalog/enrich.js";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "../src/catalog/load.js";
import { REGISTRY_SNAPSHOT } from "../src/catalog/registry-snapshot.js";

function main(): void {
  const before = readFileSync(DEFAULT_CATALOG_PATH, "utf8");
  const existing = loadCatalog();
  const { diff } = enrichCatalog({
    mode: "incremental",
    existing,
    candidates: REGISTRY_SNAPSHOT,
    now: new Date(),
  });
  const after = readFileSync(DEFAULT_CATALOG_PATH, "utf8");

  if (before !== after) {
    throw new Error("catalog-refresh dry-run changed data/models.json");
  }

  process.stderr.write(
    `catalog-refresh dry-run: added=${String(diff.added.length)} updated=${String(
      diff.updated.length,
    )} removed=${String(diff.removed.length)} skipped=${String(diff.skipped.length)} capped=${String(
      diff.capped.length,
    )}\n`,
  );
}

main();
