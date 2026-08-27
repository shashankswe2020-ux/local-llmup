/**
 * Live Ollama-registry collector.
 *
 * Refreshes the *registry-sourced* facts — a quant's on-disk size and content
 * digest — for catalog models that carry an `ollama` source, while preserving
 * every hand-curated field (params, architecture, context length, capabilities,
 * benchmarkProxy, …). It never invents data: a quant whose manifest can't be
 * resolved keeps its committed size, and a model with no `ollama` source or a
 * fully-failed lookup is returned unchanged. The emitted records are fed to the
 * shared enrich pipeline (backfill) so a real weight update surfaces as an
 * `updated` diff and a reviewed PR.
 *
 * All requests go through the anti-SSRF `assertSafeFetchUrl` allow-list; only
 * `registry.ollama.ai` is contacted. This runs in CI tooling, never on an advice
 * path (advice stays offline and deterministic).
 */
import { assertSafeFetchUrl } from "../backend/net.js";
import { CatalogError } from "../errors.js";
import { quantMemoryBytes } from "../hardware/memory-math.js";
import { stripControl } from "../sanitize.js";
import type { FetchLike } from "./enrich.js";
import type { Catalog, CatalogModel } from "../types.js";
import { z } from "zod";

const REGISTRY_HOST = "registry.ollama.ai";
const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";
const MODEL_LAYER_MEDIA_TYPE = "application/vnd.ollama.image.model";
const SHA256_PREFIX = "sha256:";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Options for {@link refreshCatalogQuants}. */
export interface OllamaRefreshOptions {
  readonly fetch: FetchLike;
  /** Override for tests; defaults to the public Ollama registry. */
  readonly registryBase?: string;
  readonly timeoutMs?: number;
  /** Clock stamped into `generatedAt` when something changed. */
  readonly now?: Date;
}

const ManifestSchema = z.object({
  layers: z
    .array(
      z.object({
        mediaType: z.string(),
        digest: z.string(),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

/** Split an `ollama` source ("name" or "name:tag") into its repo path and tag. */
export function parseOllamaRef(ref: string): { readonly path: string; readonly tag: string } {
  const trimmed = ref.trim();
  const colon = trimmed.lastIndexOf(":");
  // A ":" only separates a tag when it isn't part of a registry host:port.
  if (colon > 0 && !trimmed.slice(colon + 1).includes("/")) {
    return { path: trimmed.slice(0, colon), tag: trimmed.slice(colon + 1) };
  }
  return { path: trimmed, tag: "latest" };
}

/** A bare `name` maps to `library/name`; an explicit `ns/name` is kept as-is. */
function toLibraryPath(path: string): string {
  return path.includes("/") ? path : `library/${path}`;
}

/**
 * The catalog quant name a registry tag refreshes: the quant token in the tag
 * (e.g. `8b-instruct-q4_K_M` → `Q4_K_M`), or `undefined` when the tag carries no
 * quant suffix (so the caller refreshes the model's primary quant).
 */
export function quantFromTag(tag: string): string | undefined {
  const match = /(?:^|[-_])(q\d[a-z0-9_]*|bf16|f16|f32)$/iu.exec(tag);
  if (match === null) return undefined;
  const token = match[1];
  if (token === undefined) return undefined;
  if (/^bf/iu.test(token)) return "BF16";
  if (/^f/iu.test(token)) return token.toUpperCase();
  // Ollama writes the quant as `q4_K_M`; the catalog capitalizes only the `q`.
  return `Q${token.slice(1)}`;
}

interface ModelLayer {
  readonly diskBytes: number;
  readonly sha256: string;
}

/** Fetch one manifest and return its model-layer size + digest, or undefined. */
async function fetchModelLayer(
  base: string,
  libraryPath: string,
  tag: string,
  options: OllamaRefreshOptions,
): Promise<ModelLayer | undefined> {
  const url = assertSafeFetchUrl(`${base}/v2/${libraryPath}/manifests/${tag}`, {
    allowedHosts: [REGISTRY_HOST],
  });
  const response = await options.fetch(url.toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { accept: MANIFEST_ACCEPT },
  });
  if (!response.ok) return undefined;

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DEFAULT_MAX_BYTES) {
    throw new CatalogError(`ollama manifest for ${stripControl(libraryPath)} is oversized`);
  }

  const parsed = ManifestSchema.safeParse(await response.json());
  if (!parsed.success) return undefined;

  const layer = parsed.data.layers.find((l) => l.mediaType === MODEL_LAYER_MEDIA_TYPE);
  if (layer === undefined || layer.size <= 0) return undefined;
  if (!layer.digest.startsWith(SHA256_PREFIX)) return undefined;
  const sha256 = layer.digest.slice(SHA256_PREFIX.length);
  if (!/^[0-9a-f]{64}$/iu.test(sha256)) return undefined;
  return { diskBytes: layer.size, sha256 };
}

/**
 * Refresh quant disk sizes + digests for every `ollama`-sourced model from the
 * live registry, patching **only** the quants whose registry value actually
 * differs (recomputing that quant's memory floor when the size changed) and
 * leaving every other quant, model, and curated field byte-identical. Returns
 * the new catalog and the ids that changed. `generatedAt` bumps only when
 * something changed, so a no-op (or a full registry outage — per-model failures
 * are isolated) leaves the file byte-identical.
 */
export async function refreshCatalogQuants(
  catalog: Catalog,
  options: OllamaRefreshOptions,
): Promise<{ catalog: Catalog; updated: string[] }> {
  const base = (options.registryBase ?? `https://${REGISTRY_HOST}`).replace(/\/+$/u, "");
  const updated: string[] = [];
  const models: CatalogModel[] = [];

  for (const model of catalog.models) {
    const ollama = model.source.ollama;
    if (ollama === undefined) {
      models.push(model);
      continue;
    }

    const { path, tag } = parseOllamaRef(ollama);
    let layer: ModelLayer | undefined;
    try {
      layer = await fetchModelLayer(base, toLibraryPath(path), tag, options);
    } catch {
      // Network/parse failure for this model → keep its committed quant data.
      layer = undefined;
    }
    if (layer === undefined) {
      models.push(model);
      continue;
    }

    const tagQuant = quantFromTag(tag);
    let changed = false;
    const quantizations = model.quantizations.map((quant, index) => {
      const isTarget = tagQuant !== undefined ? quant.name === tagQuant : index === 0;
      if (!isTarget || (quant.diskBytes === layer.diskBytes && quant.sha256 === layer.sha256)) {
        return quant;
      }
      changed = true;
      // Recompute the memory floor only when the on-disk size actually moved.
      const memoryBytes =
        quant.diskBytes === layer.diskBytes
          ? undefined
          : quantMemoryBytes({
              params: model.params,
              architecture: model.architecture,
              quantName: quant.name,
              diskBytes: layer.diskBytes,
              modelId: model.id,
            });
      return {
        ...quant,
        diskBytes: layer.diskBytes,
        ...(memoryBytes !== undefined ? { minRamBytes: memoryBytes, minVramBytes: memoryBytes } : {}),
        sha256: layer.sha256,
      };
    });

    if (changed) {
      updated.push(model.id);
      models.push({ ...model, quantizations });
    } else {
      models.push(model);
    }
  }

  const now = options.now ?? new Date();
  return {
    catalog: {
      schemaVersion: catalog.schemaVersion,
      generatedAt: updated.length > 0 ? now.toISOString() : catalog.generatedAt,
      models,
    },
    updated,
  };
}
