/**
 * Catalog enrichment pipeline. One code path serves two modes:
 *
 *  - **backfill** — sweep the full candidate set (used once by the T28b bootstrap
 *    to build the exhaustive v1 catalog).
 *  - **incremental** — the weekly default: consider only releases newer than the
 *    catalog's newest known entry, add them, and never re-seed existing models.
 *
 * Enrichment is a pure transform over an injected list of raw registry records
 * plus the current catalog; the only I/O boundary is {@link fetchRegistryJson},
 * which enforces the anti-SSRF host allow-list before any request leaves the
 * process. Registry data updates only derived/technical fields — hand-curated
 * fields (e.g. `benchmarkProxy`) are preserved across runs. The merge is
 * idempotent, drops half-formed new entries without wiping prior data, removes
 * entries whose license transitions away from the open-weight allow-list, and
 * bounds the catalog with an optional size cap.
 */
import { assertSafeFetchUrl } from "../backend/net.js";
import { CatalogError, ValidationError } from "../errors.js";
import { quantMemoryBytes } from "../hardware/memory-math.js";
import { stripControl } from "../sanitize.js";
import { LICENSE_ALLOWLIST, MODEL_ARCHITECTURES } from "../types.js";
import type { Catalog, CatalogModel, ModelArchitecture } from "../types.js";
import { z } from "zod";
import { CatalogModelSchema } from "./schema.js";

/** Minimal response shape used by {@link fetchRegistryJson} (mockable in tests). */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** The request options {@link fetchRegistryJson} passes to its `fetch` seam. */
export interface FetchInit {
  readonly redirect?: "follow" | "manual" | "error";
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The subset of the `fetch` contract the pipeline depends on. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

/** Options for {@link fetchRegistryJson}. */
export interface RegistryFetchOptions {
  readonly fetch?: FetchLike | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxRedirects?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch and JSON-parse a registry URL under the full anti-SSRF policy. Redirects
 * are followed **manually** so every hop's target is re-validated against the
 * host allow-list and private/loopback/downgrade rules (an open-redirect on an
 * allow-listed host cannot be used to reach a cloud metadata endpoint). A
 * per-request timeout and a `Content-Length` cap bound hang/OOM risk. Any
 * non-2xx response, oversized body, or malformed JSON surfaces as a
 * {@link CatalogError}; a disallowed URL surfaces as a `ValidationError` before
 * `fetch` is ever called.
 */
export async function fetchRegistryJson(
  rawUrl: string,
  options: RegistryFetchOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (fetchImpl === undefined) {
    throw new CatalogError("no fetch implementation available for registry request");
  }
  const allowedHosts = options.allowedHosts;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertSafeFetchUrl(currentUrl, allowedHosts !== undefined ? { allowedHosts } : {});

    let response: FetchResponseLike;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new CatalogError(`registry fetch failed for ${stripControl(url.hostname)}`, { cause });
    }

    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location === "") {
        throw new CatalogError(
          `registry redirect without a Location from ${stripControl(url.hostname)}`,
        );
      }
      // Resolve relative redirects against the current URL; the next loop pass
      // re-runs the full SSRF policy on the resolved target before following it.
      currentUrl = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new CatalogError(
        `registry responded ${response.status} for ${stripControl(url.hostname)}`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new CatalogError(
        `registry response from ${stripControl(url.hostname)} exceeds ${maxBytes} bytes`,
      );
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new CatalogError(`registry returned invalid JSON from ${stripControl(url.hostname)}`, {
        cause,
      });
    }
  }
  throw new CatalogError(`registry exceeded ${maxRedirects} redirects`);
}

/** One raw quantization record as reported by a registry (pre-sizing). */
export interface RawRegistryQuant {
  readonly name: string;
  readonly diskBytes: number;
  readonly sha256?: string | undefined;
}

/**
 * A normalized, still-untrusted model record emitted by the HF/Ollama
 * collectors. Enrichment sizes, license-gates, validates, and merges it into a
 * {@link CatalogModel}. Callers must obtain these through
 * {@link parseRawRegistryModels} so the `unknown` fetch payload is structurally
 * validated before any field is read.
 */
export interface RawRegistryModel {
  readonly id: string;
  readonly family: string;
  readonly params: string;
  readonly architecture: ModelArchitecture;
  readonly activeParams?: string | undefined;
  readonly license: string;
  /** Registry-reported open-weight signal (gated/closed repos report false). */
  readonly openWeight: boolean;
  readonly contextLength: number;
  readonly capabilities: readonly string[];
  readonly releaseDate: string;
  readonly source: { readonly ollama?: string | undefined; readonly hf?: string | undefined };
  readonly quantizations: readonly RawRegistryQuant[];
}

const RawRegistryQuantSchema = z
  .object({
    name: z.string().min(1),
    diskBytes: z.number().int().positive(),
    sha256: z.string().min(1).optional(),
  })
  .strict();

const RawRegistryModelSchema = z
  .object({
    id: z.string().min(1),
    family: z.string().min(1),
    params: z.string().min(1),
    architecture: z.enum(MODEL_ARCHITECTURES),
    activeParams: z.string().min(1).optional(),
    license: z.string().min(1),
    openWeight: z.boolean(),
    contextLength: z.number().int().positive(),
    capabilities: z.array(z.string().min(1)).min(1),
    releaseDate: z.string().min(1),
    source: z
      .object({ ollama: z.string().min(1).optional(), hf: z.string().min(1).optional() })
      .strict(),
    quantizations: z.array(RawRegistryQuantSchema).min(1),
  })
  .strict();

/**
 * Structurally validate an untrusted registry payload (`unknown`, typically the
 * result of {@link fetchRegistryJson}) into typed {@link RawRegistryModel}s.
 * Throws {@link CatalogError} on a shape mismatch so a malformed batch fails
 * closed rather than crashing mid-enrichment with a `TypeError`.
 */
export function parseRawRegistryModels(value: unknown): RawRegistryModel[] {
  const parsed = z.array(RawRegistryModelSchema).safeParse(value);
  if (!parsed.success) {
    throw new CatalogError(`invalid registry payload: ${stripControl(parsed.error.message)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data as RawRegistryModel[];
}

/** Enrichment mode: full sweep (`backfill`) vs. new-releases-only (`incremental`). */
export type EnrichMode = "backfill" | "incremental";

/** Inputs to {@link enrichCatalog}. */
export interface EnrichOptions {
  readonly mode: EnrichMode;
  /** The current catalog to reconcile against. */
  readonly existing: Catalog;
  /** Raw candidate records (from the injected registry collectors). */
  readonly candidates: readonly RawRegistryModel[];
  /** Frozen clock; stamped into `generatedAt` so runs are reproducible. */
  readonly now: Date;
  /** Optional hard cap on total models to keep `models.json` bounded. */
  readonly maxModels?: number | undefined;
}

/** Per-id classification of what a run changed, for the PR summary. */
export interface EnrichDiff {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  /** License-gated or half-formed candidates that were not applied. */
  readonly skipped: readonly string[];
  /** Entries dropped to satisfy the size cap. */
  readonly capped: readonly string[];
}

/** Result of an enrichment run: the reconciled catalog plus its change summary. */
export interface EnrichResult {
  readonly catalog: Catalog;
  readonly diff: EnrichDiff;
}

/** Recursively key-sorted JSON, so model equality ignores property order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function modelsEqual(a: CatalogModel, b: CatalogModel): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** True when `license` is one of the open-weight licenses admitted into the catalog. */
function isAllowedLicense(license: string): boolean {
  return (LICENSE_ALLOWLIST as readonly string[]).includes(license);
}

/**
 * Build a validated {@link CatalogModel} from a raw record, sizing each quant
 * via the shared {@link quantMemoryBytes} formula and preserving the prior
 * entry's curated fields. Throws on any half-formed input (invalid params,
 * unrecognized MoE quant, schema violation) so the caller can drop a new entry
 * while retaining a valid prior one.
 */
function buildModel(raw: RawRegistryModel, prior: CatalogModel | undefined): CatalogModel {
  // Strip ANSI/control/BiDi sequences from every registry-sourced display or
  // identifier string at ingest, so the produced catalog can never carry a
  // terminal-escape payload (and always passes the loader's strict integrity
  // check on the shipped file).
  const quantizations = raw.quantizations.map((quant) => {
    const bytes = quantMemoryBytes({
      params: raw.params,
      architecture: raw.architecture,
      quantName: quant.name,
      diskBytes: quant.diskBytes,
      modelId: raw.id,
    });
    return {
      name: stripControl(quant.name),
      diskBytes: quant.diskBytes,
      minRamBytes: bytes,
      minVramBytes: bytes,
      ...(quant.sha256 !== undefined ? { sha256: stripControl(quant.sha256) } : {}),
    };
  });

  const candidate = {
    id: stripControl(raw.id),
    family: stripControl(raw.family),
    params: stripControl(raw.params),
    architecture: raw.architecture,
    ...(raw.activeParams !== undefined ? { activeParams: stripControl(raw.activeParams) } : {}),
    license: raw.license,
    openWeight: raw.openWeight,
    contextLength: raw.contextLength,
    capabilities: raw.capabilities,
    releaseDate: raw.releaseDate,
    source: {
      ...(raw.source.ollama !== undefined ? { ollama: stripControl(raw.source.ollama) } : {}),
      ...(raw.source.hf !== undefined ? { hf: stripControl(raw.source.hf) } : {}),
    },
    quantizations,
    ...(prior?.kvBytesPerToken !== undefined ? { kvBytesPerToken: prior.kvBytesPerToken } : {}),
    ...(prior?.benchmarkProxy !== undefined ? { benchmarkProxy: prior.benchmarkProxy } : {}),
  };

  const parsed = CatalogModelSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CatalogError(
      `enriched model ${JSON.stringify(raw.id)} failed validation: ${stripControl(
        parsed.error.message,
      )}`,
      { cause: parsed.error },
    );
  }
  return parsed.data as CatalogModel;
}

/** Newest release date across the existing catalog ("" when empty). */
function newestReleaseDate(catalog: Catalog): string {
  return catalog.models.reduce(
    (max, model) => (model.releaseDate > max ? model.releaseDate : max),
    "",
  );
}

/** Stable order: newest release first, ties broken by ascending id. */
function byRecencyThenId(a: CatalogModel, b: CatalogModel): number {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate > b.releaseDate ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Reconcile `candidates` into `existing` under merge-by-id semantics. Pure and
 * deterministic: the same inputs (with the same frozen `now`) always produce the
 * same output, so a re-run yields an empty diff.
 */
export function enrichCatalog(options: EnrichOptions): EnrichResult {
  const { mode, existing, candidates, now } = options;
  if (existing.schemaVersion !== 2) {
    throw new CatalogError(
      `enrichment expects catalog schemaVersion 2, got ${String(existing.schemaVersion)}`,
    );
  }
  if (
    options.maxModels !== undefined &&
    (!Number.isInteger(options.maxModels) || options.maxModels < 1)
  ) {
    throw new ValidationError(
      `maxModels must be a positive integer, got ${String(options.maxModels)}`,
    );
  }

  const result = new Map<string, CatalogModel>();
  for (const model of existing.models) result.set(model.id, model);
  const newestDate = newestReleaseDate(existing);

  // Collapse duplicate ids within one candidate batch (last occurrence wins) so
  // a repeated id can never land in two diff channels or corrupt `result` by
  // being reprocessed against its own just-written value.
  const deduped = new Map<string, RawRegistryModel>();
  for (const raw of candidates) deduped.set(raw.id, raw);

  const todayIso = now.toISOString().slice(0, 10);

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const raw of deduped.values()) {
    const prior = result.get(raw.id);

    // Admission gate (BOTH modes): only open-weight-licensed, registry-confirmed
    // open-weight models. A permissive license string is not sufficient — a
    // gated/closed repo can carry one — so `openWeight` must also hold. An
    // existing entry that loses either property is removed, not just skipped.
    if (!isAllowedLicense(raw.license) || !raw.openWeight) {
      if (prior !== undefined) {
        result.delete(raw.id);
        removed.push(raw.id);
      } else if (mode === "backfill") {
        skipped.push(raw.id);
      }
      continue;
    }

    // Incremental never re-seeds existing entries.
    if (mode === "incremental" && prior !== undefined) continue;

    // Reject future-dated releases: a `releaseDate` past the frozen clock is
    // either bad data or an attempt to poison the incremental freshness window
    // (a far-future date would suppress every real subsequent release).
    if (raw.releaseDate > todayIso) {
      if (prior === undefined) skipped.push(raw.id);
      continue;
    }

    // Incremental admits only genuinely newer new ids.
    if (mode === "incremental" && raw.releaseDate <= newestDate) continue;

    try {
      const built = buildModel(raw, prior);
      if (prior === undefined) {
        result.set(raw.id, built);
        added.push(raw.id);
      } else if (!modelsEqual(built, prior)) {
        result.set(raw.id, built);
        updated.push(raw.id);
      }
      // Identical rebuild → idempotent no-op.
    } catch (error) {
      // Expected data problems (bad params, unrecognized MoE quant, schema
      // failure) drop a half-formed new entry while keeping a valid prior one.
      // A genuine programmer error must NOT be silently reclassified as skipped.
      if (!(error instanceof CatalogError || error instanceof ValidationError)) throw error;
      skipped.push(raw.id);
    }
  }

  let models = [...result.values()].sort(byRecencyThenId);

  const capped: string[] = [];
  if (options.maxModels !== undefined && models.length > options.maxModels) {
    for (const model of models.slice(options.maxModels)) capped.push(model.id);
    models = models.slice(0, options.maxModels);
  }
  const cappedSet = new Set(capped);

  const changed = added.length > 0 || updated.length > 0 || removed.length > 0 || capped.length > 0;
  const catalog: Catalog = {
    schemaVersion: 2,
    // Preserve the prior timestamp on a fully no-op run so the persisted file is
    // byte-identical across runs (real on-disk idempotency, not just an empty diff).
    generatedAt: changed ? now.toISOString() : existing.generatedAt,
    models,
  };
  const diff: EnrichDiff = {
    added: added.filter((id) => !cappedSet.has(id)),
    updated: updated.filter((id) => !cappedSet.has(id)),
    removed,
    skipped,
    capped,
  };
  return { catalog, diff };
}
