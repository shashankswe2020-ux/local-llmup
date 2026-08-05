/**
 * T28b one-time catalog bootstrap runner. Regenerates the exhaustive v1
 * `data/models.json` by running the shared enrichment pipeline in backfill mode
 * over the recorded registry snapshot. Deterministic: given the frozen
 * {@link BOOTSTRAP_CLOCK} and snapshot, re-running reproduces the committed file
 * byte-for-byte.
 *
 * Usage: `npm run bootstrap` (or `tsx scripts/bootstrap-catalog.ts`).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_CLOCK, buildBootstrapCatalog } from "../src/catalog/bootstrap.js";
import { REGISTRY_SNAPSHOT } from "../src/catalog/registry-snapshot.js";

const catalog = buildBootstrapCatalog(REGISTRY_SNAPSHOT, BOOTSTRAP_CLOCK);
const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "data", "models.json");
writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

// Diagnostics go to stderr; stdout stays reserved for machine-readable data.
console.error(`bootstrap: wrote ${catalog.models.length} models to ${outPath}`);
