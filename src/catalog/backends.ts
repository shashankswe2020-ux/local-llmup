/**
 * Maps a catalog model's `source` keys to the servable {@link ModelFormat}s and
 * resolves which registered backends can serve it. A backend serves a model when
 * its {@link BackendCapabilities.formats} intersect the model's mapped formats.
 *
 * The `hf` source key is **advisory only** — a bare Hugging Face repo is not a
 * runnable weight package, so it maps to no format and never matches a backend
 * on its own. Models with only advisory sources are still catalog-valid and are
 * never dropped from ranking; they simply report no servable backend here.
 */
import type { BackendAdapter } from "../backend/adapter.js";
import type { BackendRegistry } from "../backend/registry.js";
import type { CatalogModel, ModelFormat, ModelSource } from "../types.js";

/**
 * Source-key → format pairs in canonical output order. `hf` is intentionally
 * absent (advisory only). `safetensors` has no source key today.
 */
const SOURCE_KEY_FORMATS: readonly (readonly [keyof ModelSource, ModelFormat])[] = [
  ["ollama", "ollama"],
  ["gguf", "gguf"],
  ["mlx", "mlx"],
];

/**
 * The servable weight formats a model advertises, derived from its `source`
 * keys. Deterministic order; advisory-only (`hf`) sources yield an empty list.
 */
export function formatsForModel(model: CatalogModel): readonly ModelFormat[] {
  const formats: ModelFormat[] = [];
  for (const [key, format] of SOURCE_KEY_FORMATS) {
    if (model.source[key] !== undefined && !formats.includes(format)) {
      formats.push(format);
    }
  }
  return formats;
}

/**
 * The registered backends that can serve `model`, in registration order. Empty
 * when the model has only advisory sources or no registered backend matches.
 */
export function backendsForModel(
  model: CatalogModel,
  registry: BackendRegistry,
): readonly BackendAdapter[] {
  const formats = formatsForModel(model);
  if (formats.length === 0) {
    return [];
  }
  return registry.all().filter((adapter) =>
    adapter.capabilities.formats.some((format) => formats.includes(format)),
  );
}
