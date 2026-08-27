/**
 * Incremental catalog refresh (write mode) — the production counterpart of the
 * dry-run. Regenerates `data/models.json` from the committed registry snapshot
 * via the shared enrich pipeline and writes it with the same 2-space + trailing
 * newline serialization as the bootstrap. Idempotent: enrich preserves
 * `generatedAt` on a no-op run, so an unchanged catalog is byte-identical and
 * produces no diff (no noise PRs). Prints the change summary to stderr.
 *
 * Usage: `npm run catalog:refresh` (or `tsx scripts/catalog-refresh.ts`).
 */
import { writeFileSync } from "node:fs";
import { enrichCatalog } from "../src/catalog/enrich.js";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "../src/catalog/load.js";
import { REGISTRY_SNAPSHOT } from "../src/catalog/registry-snapshot.js";

function main(): void {
  const existing = loadCatalog();
  const { catalog, diff } = enrichCatalog({
    mode: "incremental",
    existing,
    candidates: REGISTRY_SNAPSHOT,
    now: new Date(),
  });

  writeFileSync(DEFAULT_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  process.stderr.write(
    `catalog-refresh: added=${String(diff.added.length)} updated=${String(
      diff.updated.length,
    )} removed=${String(diff.removed.length)} skipped=${String(diff.skipped.length)} capped=${String(
      diff.capped.length,
    )}\n`,
  );
}

main();
