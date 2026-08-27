/**
 * Scoring and ranking. Survivors of {@link evaluateFit} are scored on five
 * deterministic dimensions (quality, fit, speed, recency, capability), combined
 * with the weights in `weights.ts`, and ordered by composite score with an
 * explicit, stable tie-break. Nothing here reads the wall clock: recency is
 * pinned to the catalog's `generatedAt`, so output cannot drift day-to-day.
 */
import { parseParamCount, quantBitsPerParam, usableMemoryKind } from "../hardware/memory-math.js";
import type { Capability, Catalog, CatalogModel, HardwareProfile, Quantization } from "../types.js";
import { evaluateFit, evaluateFitAtContext, type FitReason } from "./fit.js";
import {
  HEADROOM,
  RECENCY_WINDOW_DAYS,
  SPEED_REFERENCE_BITS_PER_PARAM,
  SPEED_REFERENCE_PARAMS,
  W_CAPABILITY,
  W_FIT,
  W_QUALITY,
  W_RECENCY,
  W_SPEED,
} from "./weights.js";

/** Per-dimension scores, each normalized to [0, 1]. */
export interface RankScores {
  readonly quality: number;
  readonly fit: number;
  readonly speed: number;
  readonly recency: number;
  readonly capability: number;
}

/** A model that fits, with its selected quant and composite score breakdown. */
export interface RankedModel {
  readonly model: CatalogModel;
  readonly quant: Quantization;
  readonly requiredBytes: number;
  readonly usableBytes: number;
  /** Weighted composite of {@link RankScores}, in [0, 1]. */
  readonly score: number;
  readonly scores: RankScores;
}

/** A model that cannot run, with the binding constraint. */
export interface WontFitModel {
  readonly model: CatalogModel;
  readonly reason: FitReason;
}

export interface RankResult {
  readonly ranked: readonly RankedModel[];
  readonly wontFit: readonly WontFitModel[];
}

export interface RankOptions {
  /** When set, models matching this capability are rewarded; others are not. */
  readonly task?: Capability | undefined;
  /**
   * When set, models are evaluated at this explicit context (in tokens) via
   * {@link evaluateFitAtContext}, so `requiredBytes` — and therefore the fit
   * score and ranking — reflect the KV-sized footprint. Unknown-geometry models
   * fall back to weights-based fit (honesty gate); over-cap models become
   * `context-bound`. Omitted → the calibrated default footprint.
   */
  readonly context?: number | undefined;
  /** Evaluate each model at this percentage of its advertised context length. */
  readonly contextPercent?: 25 | 50 | 75 | 100 | undefined;
}

/** Resolve a model-relative context percentage to an integer token count. */
export function contextTokensForModel(
  model: CatalogModel,
  percent: 25 | 50 | 75 | 100,
): number {
  return Math.max(1, Math.floor((model.contextLength * percent) / 100));
}

const MS_PER_DAY = 86_400_000;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Quality from param class blended with the catalog's benchmark proxy. Param
 * class is a log scale over [1B, 1T] (a 1B model → 0, a 1T model → 1). When a
 * benchmark proxy is present it contributes half the weight.
 */
function qualityScore(model: CatalogModel): number {
  const paramClass = clamp01((Math.log10(parseParamCount(model.params)) - 9) / 3);
  if (model.benchmarkProxy === undefined) return paramClass;
  return 0.5 * paramClass + 0.5 * model.benchmarkProxy;
}

/**
 * Reward using the hardware well without courting OOM. Utilization is the
 * required share of usable memory; the score peaks at a comfortable target and
 * falls off toward both an empty machine (wasted hardware) and the headroom edge
 * (near-OOM).
 */
function fitScore(requiredBytes: number, usableBytes: number): number {
  const utilization = requiredBytes / usableBytes;
  const target = 0.6;
  const edge = 1 - HEADROOM;
  const spread = Math.max(target, edge - target);
  return clamp01(1 - Math.abs(utilization - target) / spread);
}

/**
 * Deterministic estimated-throughput heuristic (no live benchmarking in v1).
 * Speed scales with hardware memory bandwidth and the selected quant's byte
 * width, and inversely with the parameters read per token — `activeParams` for
 * MoE, total params for dense.
 */
function speedScore(model: CatalogModel, quant: Quantization, hw: HardwareProfile): number {
  const activeLabel =
    model.architecture === "moe" && model.activeParams !== undefined
      ? model.activeParams
      : model.params;
  const activeCount = parseParamCount(activeLabel);
  const bitsPerParam = quantBitsPerParam(quant.name) ?? SPEED_REFERENCE_BITS_PER_PARAM;
  const quantSpeed = clamp01(SPEED_REFERENCE_BITS_PER_PARAM / bitsPerParam);

  const unified = hw.arch === "arm64" && hw.platform === "darwin";
  const bandwidth = usableMemoryKind(hw) === "vram" ? 1 : unified ? 0.5 : 0.2;

  return clamp01(bandwidth * quantSpeed * (SPEED_REFERENCE_PARAMS / activeCount));
}

/**
 * Recency relative to a fixed reference (`catalog.generatedAt`), never the wall
 * clock. A release on the reference date scores 1, one `RECENCY_WINDOW_DAYS`
 * earlier scores 0, older clamps to 0, and a future release clamps to 1.
 */
export function recencyScore(releaseDate: string, referenceIso: string): number {
  const released = Date.parse(releaseDate);
  const reference = Date.parse(referenceIso);
  if (Number.isNaN(released) || Number.isNaN(reference)) return 0;
  const ageDays = (reference - released) / MS_PER_DAY;
  return clamp01(1 - ageDays / RECENCY_WINDOW_DAYS);
}

/**
 * Capability match against the requested task. Neutral (1 for every model, so
 * ordering is unaffected) when no task is requested; otherwise 1 for a match and
 * 0 for a miss.
 */
function capabilityScore(model: CatalogModel, task: Capability | undefined): number {
  if (task === undefined) return 1;
  return model.capabilities.includes(task) ? 1 : 0;
}

/**
 * Stable, explicit tie-break for equal composite scores: `benchmarkProxy`
 * descending (missing sorts last), then `releaseDate` descending, then `id`
 * ascending. A total order, so sort output is fully deterministic.
 */
export function compareRankedModels(a: RankedModel, b: RankedModel): number {
  if (a.score !== b.score) return b.score - a.score;

  const aProxy = a.model.benchmarkProxy ?? -1;
  const bProxy = b.model.benchmarkProxy ?? -1;
  if (aProxy !== bProxy) return bProxy - aProxy;

  const releaseDelta = Date.parse(b.model.releaseDate) - Date.parse(a.model.releaseDate);
  if (releaseDelta !== 0) return releaseDelta;

  if (a.model.id < b.model.id) return -1;
  if (a.model.id > b.model.id) return 1;
  return 0;
}

/**
 * Rank every model in `catalog` against `hw`. Fitting models are scored and
 * sorted; the rest are returned under `wontFit` with a typed reason. An empty
 * catalog and an all-too-big catalog are therefore distinct results: both have
 * an empty `ranked`, but only the latter has a populated `wontFit`.
 */
export function rankModels(
  catalog: Catalog,
  hw: HardwareProfile,
  options: RankOptions = {},
): RankResult {
  const ranked: RankedModel[] = [];
  const wontFit: WontFitModel[] = [];

  for (const model of catalog.models) {
    const contextTokens =
      options.contextPercent !== undefined
        ? contextTokensForModel(model, options.contextPercent)
        : options.context;
    const fit =
      contextTokens !== undefined
        ? evaluateFitAtContext(model, hw, contextTokens)
        : evaluateFit(model, hw);
    if (!fit.fits) {
      wontFit.push({ model, reason: fit.reason });
      continue;
    }

    const scores: RankScores = {
      quality: qualityScore(model),
      fit: fitScore(fit.requiredBytes, fit.usableBytes),
      speed: speedScore(model, fit.quant, hw),
      recency: recencyScore(model.releaseDate, catalog.generatedAt),
      capability: capabilityScore(model, options.task),
    };
    const score =
      W_QUALITY * scores.quality +
      W_FIT * scores.fit +
      W_SPEED * scores.speed +
      W_RECENCY * scores.recency +
      W_CAPABILITY * scores.capability;
    // Clamp once: each component is in [0, 1] and the weights sum to 1, but
    // IEEE-754 rounding of the weighted sum can land a hair above 1, so we pin
    // the documented [0, 1] invariant here.
    const clampedScore = clamp01(score);

    ranked.push({
      model,
      quant: fit.quant,
      requiredBytes: fit.requiredBytes,
      usableBytes: fit.usableBytes,
      score: clampedScore,
      scores,
    });
  }

  ranked.sort(compareRankedModels);
  return { ranked, wontFit };
}
