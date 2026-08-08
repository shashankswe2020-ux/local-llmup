/**
 * Fuzzy model resolver shared by `up`/`down`/`switch`/`migrate`. Maps a
 * user-supplied name onto a single catalog entry (and, when a `-<quant>` suffix
 * is present, a specific quantization), or throws a typed error that lists
 * candidate ids on ambiguity.
 *
 * Resolution order (first non-empty wins): exact id → id + quant suffix →
 * exact family → fuzzy prefix on id/family. Ambiguity within a tier surfaces
 * every matching id so the caller can prompt the user.
 */
import { ModelResolutionError, ValidationError } from "./errors.js";
import { assertSafeModelId } from "./backend/net.js";
import { stripControl } from "./sanitize.js";
import type { Catalog, CatalogModel, Quantization } from "./types.js";

/** Characters permitted in a resolver input (uppercase allowed for quant tags). */
const RESOLVER_INPUT_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/** A model resolved from the catalog, with an explicit quant when requested. */
export interface ResolvedModel {
  readonly model: CatalogModel;
  /** The quantization named by a `-<quant>` suffix, or undefined if unspecified. */
  readonly quant?: Quantization | undefined;
}

/**
 * Resolve `input` to a single catalog model. Throws {@link ValidationError} for
 * malformed or path-traversal input and {@link ModelResolutionError} (with
 * candidate ids) when the name is unknown or ambiguous.
 */
export function resolveModel(catalog: Catalog, input: string): ResolvedModel {
  const query = normalizeInput(input);
  const models = catalog.models;

  // 1. Exact model id (ids are unique, so at most one match).
  const exact = models.find((model) => model.id.toLowerCase() === query);
  if (exact) {
    return finalize({ model: exact });
  }

  // 2. Model id + `-<quant>` suffix.
  const withQuant: ResolvedModel[] = [];
  for (const model of models) {
    for (const quant of model.quantizations) {
      if (`${model.id}-${quant.name}`.toLowerCase() === query) {
        withQuant.push({ model, quant });
      }
    }
  }
  if (withQuant.length === 1) {
    return finalize(withQuant[0] as ResolvedModel);
  }
  if (withQuant.length > 1) {
    throw ambiguous(
      query,
      withQuant.map((entry) => entry.model.id),
    );
  }

  // 3. Exact family.
  const family = models.filter((model) => model.family.toLowerCase() === query);
  if (family.length === 1) {
    return finalize({ model: family[0] as CatalogModel });
  }
  if (family.length > 1) {
    throw ambiguous(
      query,
      family.map((model) => model.id),
    );
  }

  // 4. Fuzzy prefix on id or family.
  const fuzzy = models.filter(
    (model) =>
      model.id.toLowerCase().startsWith(query) || model.family.toLowerCase().startsWith(query),
  );
  if (fuzzy.length === 1) {
    return finalize({ model: fuzzy[0] as CatalogModel });
  }
  if (fuzzy.length > 1) {
    throw ambiguous(
      query,
      fuzzy.map((model) => model.id),
    );
  }

  throw new ModelResolutionError(`no model matches "${query}"`, []);
}

function normalizeInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new ValidationError("model name is empty");
  }
  if (trimmed.includes("..")) {
    throw new ValidationError(`model name contains path traversal: "${stripControl(trimmed)}"`);
  }
  if (!RESOLVER_INPUT_PATTERN.test(trimmed)) {
    throw new ValidationError(`model name contains invalid characters: "${stripControl(trimmed)}"`);
  }
  return trimmed.toLowerCase();
}

function ambiguous(query: string, ids: readonly string[]): ModelResolutionError {
  const candidates = [...ids].sort((a, b) => a.localeCompare(b));
  return new ModelResolutionError(
    `"${query}" is ambiguous; candidates: ${candidates.join(", ")}`,
    candidates,
  );
}

/**
 * Validate every id the resolved model exposes onward (spec §3.2 step 1). Both
 * `model.id` (keys the per-model memory directory) and `source.ollama` (passed
 * to the backend) must be safe; a catalog id containing `..` is rejected as a
 * traversal attempt since the schema only checks non-emptiness.
 */
function finalize(resolved: ResolvedModel): ResolvedModel {
  const ids = [resolved.model.id, resolved.model.source.ollama];
  for (const id of ids) {
    if (id === undefined) continue;
    if (id.includes("..")) {
      throw new ValidationError(`catalog model id contains path traversal: "${stripControl(id)}"`);
    }
    assertSafeModelId(id);
  }
  return resolved;
}
