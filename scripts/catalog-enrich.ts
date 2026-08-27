/**
 * Live catalog enrichment.
 *
 * Refreshes quant disk sizes + content digests for every `ollama`-sourced model
 * from `registry.ollama.ai`, patching only the quants whose registry value
 * actually moved (curated fields untouched), then writes `data/models.json`.
 * Requires network access — this is CI tooling, never an advice path. Resilient
 * by design: a registry outage or per-model failure leaves that model intact, so
 * a total outage produces a byte-identical file (no diff, no noise PR).
 *
 * Usage: `npm run catalog:enrich` (or `tsx scripts/catalog-enrich.ts`).
 */
import { writeFileSync } from "node:fs";
import type { FetchLike } from "../src/catalog/enrich.js";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "../src/catalog/load.js";
import { refreshCatalogQuants } from "../src/catalog/registry-collector.js";

async function main(): Promise<void> {
  const existing = loadCatalog();
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  if (fetchImpl === undefined) {
    throw new Error("global fetch is unavailable");
  }

  const { catalog, updated } = await refreshCatalogQuants(existing, {
    fetch: fetchImpl,
    now: new Date(),
  });

  writeFileSync(DEFAULT_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  process.stderr.write(
    `catalog-enrich: updated=${String(updated.length)}${
      updated.length > 0 ? ` (${updated.join(", ")})` : ""
    }\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `catalog-enrich failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
