/**
 * Shared domain types for local-llmup. This module is dependency-free (no
 * imports from feature modules) so that hardware, ranking, catalog, and enrich
 * can all depend on it without cross-coupling. Runtime enums are declared as
 * `as const` arrays so both the derived types and later Zod schemas share one
 * source of truth.
 */

/** CPU architectures local-llmup recognizes. */
export const ARCHS = ["x64", "arm64"] as const;
export type Arch = (typeof ARCHS)[number];

/** Operating-system platforms local-llmup runs on. */
export const PLATFORMS = ["darwin", "linux", "win32"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** GPU vendors recognized for VRAM accounting. */
export const GPU_VENDORS = ["apple", "nvidia", "amd", "none"] as const;
export type GpuVendor = (typeof GPU_VENDORS)[number];

/** Model architectures; drives memory sizing (MoE keeps all experts resident). */
export const MODEL_ARCHITECTURES = ["dense", "moe"] as const;
export type ModelArchitecture = (typeof MODEL_ARCHITECTURES)[number];

/** Capabilities a model advertises; used by the ranker's capability dimension. */
export const CAPABILITIES = [
  "chat",
  "code",
  "vision",
  "reasoning",
  "tools",
  "embedding",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Open-weight licenses admitted into the catalog. Non-open (closed API) models
 * are out of scope; the catalog schema rejects anything not listed here.
 */
export const LICENSE_ALLOWLIST = [
  "apache-2.0",
  "mit",
  "modified-mit",
  "bsd-3-clause",
  "llama-2-community",
  "llama-3-community",
  "llama-3.1-community",
  "llama-3.2-community",
  "llama-3.3-community",
  "gemma",
  "qwen",
  "qwen-research",
  "tongyi-qianwen",
  "deepseek",
  "yi-license",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "openrail",
] as const;
export type License = (typeof LICENSE_ALLOWLIST)[number];

/** A single GPU and its dedicated VRAM (0 for integrated/unified). */
export interface GpuInfo {
  readonly vendor: GpuVendor;
  readonly vramBytes: number;
}

/** Detected hardware the ranker sizes models against. */
export interface HardwareProfile {
  readonly arch: Arch;
  readonly platform: Platform;
  readonly totalRamBytes: number;
  readonly freeRamBytes: number;
  readonly gpu: readonly GpuInfo[];
  readonly freeDiskBytes: number;
}

/** One quantization of a model with its on-disk and in-memory footprint. */
export interface Quantization {
  readonly name: string;
  readonly diskBytes: number;
  readonly minRamBytes: number;
  readonly minVramBytes: number;
  /** Weight digest when the registry publishes one; absent → size-only verify. */
  readonly sha256?: string | undefined;
  /** Whether the published digest was verified; absent until pull-time. */
  readonly digestVerified?: boolean | undefined;
}

/** Upstream registry coordinates for a model. */
export interface ModelSource {
  readonly ollama?: string | undefined;
  readonly hf?: string | undefined;
}

/** A model entry in the catalog. */
export interface CatalogModel {
  readonly id: string;
  readonly family: string;
  /** Total parameter count label, e.g. "8B", "1T". */
  readonly params: string;
  readonly architecture: ModelArchitecture;
  /** MoE only: parameters active per token; drives speed, not footprint. */
  readonly activeParams?: string | undefined;
  readonly license: License;
  readonly openWeight: boolean;
  readonly contextLength: number;
  readonly capabilities: readonly Capability[];
  /** ISO-8601 date (YYYY-MM-DD). */
  readonly releaseDate: string;
  readonly source: ModelSource;
  readonly quantizations: readonly Quantization[];
  /** Normalized quality proxy in [0, 1]. */
  readonly benchmarkProxy?: number | undefined;
}

/** The versioned model catalog (`data/models.json`). */
export interface Catalog {
  readonly schemaVersion: number;
  /** ISO-8601 timestamp; recency scoring pins to this, never the wall clock. */
  readonly generatedAt: string;
  readonly models: readonly CatalogModel[];
}

// ---------------------------------------------------------------------------
// Hardware Advisor domain types
//
// The advisor layer (score, throughput, verdict, plan, build) reasons about the
// same `HardwareProfile` the ranker uses, plus these shared shapes. Kept here,
// dependency-free, so every advisor module and its Zod schemas share one source
// of truth (mirrors the `as const` enum pattern above).
// ---------------------------------------------------------------------------

/**
 * The four capability axes scored by the AI Hardware Score. The weakest axis is
 * surfaced as the machine's primary {@link Bottleneck}.
 */
export const BOTTLENECKS = ["vram", "ram", "compute", "storage"] as const;
export type Bottleneck = (typeof BOTTLENECKS)[number];

/**
 * Runnability verdict for a model on the detected hardware: `yes` (fits and
 * comfortable), `slow` (fits but under the throughput comfort floor), or `no`
 * (does not fit).
 */
export const RUNNABLE_STATES = ["yes", "slow", "no"] as const;
export type Runnable = (typeof RUNNABLE_STATES)[number];

/**
 * Estimated decode throughput as a range, never a point value. `known` is false
 * when the detected hardware has no performance profile; callers must then treat
 * the bounds as meaningless and must not present a number (honesty gate).
 */
export interface ThroughputEstimate {
  readonly lowTokPerSec: number;
  readonly highTokPerSec: number;
  readonly known: boolean;
}

/**
 * AI Hardware Score: an overall 0–100 rating plus the per-axis sub-scores it was
 * composed from and the weakest axis (the primary bottleneck).
 */
export interface HardwareScore {
  readonly total: number;
  readonly sub: Readonly<Record<Bottleneck, number>>;
  readonly bottleneck: Bottleneck;
}

/**
 * A dated price range in USD. Prices are curated estimates, never live quotes,
 * so every value carries the date it was valid as of.
 */
export interface ComponentPrice {
  readonly lowUsd: number;
  readonly highUsd: number;
  /** ISO-8601 date (YYYY-MM-DD) the estimate is valid as of. */
  readonly asOf: string;
}
