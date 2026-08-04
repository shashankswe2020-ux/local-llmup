import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { Catalog } from "../types.js";
import { CatalogSchema } from "./schema.js";

/** Default catalog location: `data/models.json` at the package root. */
export const DEFAULT_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../data/models.json",
);

/** Sanitize every model-sourced display string, reporting whether anything changed. */
function sanitizeCatalog(catalog: Catalog): { catalog: Catalog; changed: boolean } {
  let changed = false;
  const clean = (value: string): string => {
    const out = stripControl(value);
    if (out !== value) changed = true;
    return out;
  };

  const models = catalog.models.map((model) => ({
    ...model,
    id: clean(model.id),
    family: clean(model.family),
    params: clean(model.params),
    ...(model.activeParams !== undefined ? { activeParams: clean(model.activeParams) } : {}),
    source: {
      ...(model.source.ollama !== undefined ? { ollama: clean(model.source.ollama) } : {}),
      ...(model.source.hf !== undefined ? { hf: clean(model.source.hf) } : {}),
    },
    quantizations: model.quantizations.map((quant) => ({ ...quant, name: clean(quant.name) })),
  }));

  return { catalog: { ...catalog, models }, changed };
}

/** Throw if two models share an id (integrity check, run on sanitized ids). */
function assertUniqueIds(catalog: Catalog): void {
  const seen = new Set<string>();
  for (const model of catalog.models) {
    if (seen.has(model.id)) {
      throw new CatalogError(`Catalog contains duplicate model id: ${model.id}`);
    }
    seen.add(model.id);
  }
}

/**
 * Parse and validate raw catalog JSON. Distinguishes malformed JSON from
 * schema-invalid content; both surface as {@link CatalogError}. Model-sourced
 * display strings are stripped of ANSI/control/BiDi sequences before return.
 * When `rejectOnSanitize` is set (trusted seed), any such characters are treated
 * as an integrity failure rather than silently stripped.
 */
export function parseCatalog(raw: string, options?: { rejectOnSanitize?: boolean }): Catalog {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new CatalogError("Catalog is not valid JSON", { cause });
  }

  const result = CatalogSchema.safeParse(json);
  if (!result.success) {
    // The Zod message can echo untrusted keys/values; strip before surfacing.
    throw new CatalogError(
      `Catalog failed schema validation: ${stripControl(result.error.message)}`,
      { cause: result.error },
    );
  }

  const { catalog, changed } = sanitizeCatalog(result.data);
  if (options?.rejectOnSanitize && changed) {
    throw new CatalogError(
      "Catalog contains control or formatting characters that are not allowed in a trusted catalog",
    );
  }

  assertUniqueIds(catalog);
  return catalog;
}

/** Read, parse, and validate the catalog from disk. */
export function loadCatalog(filePath: string = DEFAULT_CATALOG_PATH): Catalog {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new CatalogError(`Cannot read catalog at ${filePath}`, { cause });
  }
  return parseCatalog(raw, { rejectOnSanitize: filePath === DEFAULT_CATALOG_PATH });
}
