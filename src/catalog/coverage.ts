import { CatalogError } from "../errors.js";
import type { Catalog } from "../types.js";
import { assertSafeFetchUrl } from "../backend/net.js";
import { parseOllamaRef } from "./registry-collector.js";

const INVENTORY_DECLARATION = "var libraryModels = []string{";
const OFFICIAL_MODEL_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const INVENTORY_HOST = "raw.githubusercontent.com";
const MAX_INVENTORY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export const OLLAMA_LIBRARY_INVENTORY_URL =
  "https://raw.githubusercontent.com/ollama/ollama/main/integration/reg_library_test.go";

export interface CoverageFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly text: () => Promise<string>;
}

export type CoverageFetchLike = (
  url: string,
  init?: { readonly redirect?: "error"; readonly signal?: AbortSignal },
) => Promise<CoverageFetchResponse>;

export interface CoverageFetchOptions {
  readonly fetch: CoverageFetchLike;
  readonly timeoutMs?: number;
}

export interface CatalogCoverage {
  readonly upstreamCount: number;
  readonly coveredCount: number;
  readonly missing: readonly string[];
}

/** Parse active model repositories from Ollama's public-library integration inventory. */
export function parseOllamaLibraryInventory(source: string): string[] {
  const declaration = source.indexOf(INVENTORY_DECLARATION);
  if (declaration < 0) {
    throw new CatalogError("Ollama library inventory declaration is missing");
  }
  const bodyStart = declaration + INVENTORY_DECLARATION.length;
  const bodyEnd = source.indexOf("\n}", bodyStart);
  if (bodyEnd < 0) {
    throw new CatalogError("Ollama library inventory terminator is missing");
  }

  const body = source
    .slice(bodyStart, bodyEnd)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
  const models = [...body.matchAll(/^\s*"([a-z0-9][a-z0-9._-]*)",\s*$/gmu)].map(
    (match) => match[1]!,
  );
  if (models.length === 0) {
    throw new CatalogError("Ollama library inventory contains no active models");
  }
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

/** Fetch Ollama's bounded public-library inventory for coverage alerting only. */
export async function fetchOllamaLibraryInventory(
  options: CoverageFetchOptions,
): Promise<string[]> {
  const url = assertSafeFetchUrl(OLLAMA_LIBRARY_INVENTORY_URL, {
    allowedHosts: [INVENTORY_HOST],
  });
  const response = await options.fetch(url.toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new CatalogError(`Ollama library inventory returned status ${String(response.status)}`);
  }

  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_INVENTORY_BYTES) {
    throw new CatalogError("Ollama library inventory response is oversized");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_INVENTORY_BYTES) {
    throw new CatalogError("Ollama library inventory response is oversized");
  }
  return parseOllamaLibraryInventory(body);
}

function officialOllamaRepository(ref: string): string | undefined {
  const { path } = parseOllamaRef(ref);
  if (path.startsWith("library/")) return path.slice("library/".length);
  return path.includes("/") ? undefined : path;
}

function vendorLineage(repository: string): string {
  return /^[a-z]+/u.exec(repository)?.[0] ?? repository;
}

/** Limit discovery to vendor lineages already admitted by the curated catalog. */
export function selectMonitoredOllamaModels(
  catalog: Catalog,
  upstreamModels: readonly string[],
): string[] {
  const monitoredVendors = new Set(
    catalog.models.flatMap((model) => {
      const ref = model.source.ollama;
      if (ref === undefined) return [];
      const repository = officialOllamaRepository(ref);
      return repository === undefined ? [] : [vendorLineage(repository)];
    }),
  );
  return [...new Set(upstreamModels)]
    .filter((model) => monitoredVendors.has(vendorLineage(model)))
    .sort((left, right) => left.localeCompare(right));
}

/** Compare official upstream repositories with exact Ollama sources in the catalog. */
export function evaluateCatalogCoverage(
  catalog: Catalog,
  upstreamModels: readonly string[],
): CatalogCoverage {
  const upstream = [...new Set(upstreamModels)].sort((left, right) => left.localeCompare(right));
  if (upstream.some((model) => !OFFICIAL_MODEL_RE.test(model))) {
    throw new CatalogError("Ollama library inventory contains an invalid model name");
  }

  const covered = new Set(
    catalog.models.flatMap((model) => {
      const ref = model.source.ollama;
      if (ref === undefined) return [];
      const repository = officialOllamaRepository(ref);
      return repository === undefined ? [] : [repository];
    }),
  );
  const missing = upstream.filter((model) => !covered.has(model));
  return {
    upstreamCount: upstream.length,
    coveredCount: upstream.length - missing.length,
    missing,
  };
}