/**
 * Ranking constants. This is the single source of truth for the scoring weights
 * and the memory-fit headroom so `fit.ts` and `rank.ts` can never diverge.
 */

/**
 * Fraction of usable memory kept in reserve when deciding whether a model fits.
 * A model fits only if `requiredMemory <= usableMemory * (1 - HEADROOM)`, so the
 * ranker never recommends a model that would run at the razor's edge of OOM.
 */
export const HEADROOM = 0.15;

/** Weight on model quality (param class + benchmark proxy). */
export const W_QUALITY = 0.3;
/** Weight on how well the model uses available memory without nearing OOM. */
export const W_FIT = 0.2;
/** Weight on the deterministic estimated-throughput heuristic. */
export const W_SPEED = 0.2;
/** Weight on recency of the open-weight release. */
export const W_RECENCY = 0.15;
/** Weight on capability match against a requested `--task`. */
export const W_CAPABILITY = 0.15;

/**
 * The five composite-score weights. They MUST sum to 1 (asserted by a test) so
 * that each component score in [0, 1] yields a composite score in [0, 1].
 */
export const RANKING_WEIGHTS = {
  quality: W_QUALITY,
  fit: W_FIT,
  speed: W_SPEED,
  recency: W_RECENCY,
  capability: W_CAPABILITY,
} as const;

/**
 * Recency horizon in days. A model released on the catalog's `generatedAt`
 * scores 1; one released `RECENCY_WINDOW_DAYS` earlier scores 0. Older still
 * clamps to 0; a future release clamps to 1.
 */
export const RECENCY_WINDOW_DAYS = 730;

/**
 * Active-parameter count (absolute) at which a Q4 model on a discrete GPU
 * reaches the top speed score. Smaller active sets clamp to 1; larger sets scale
 * down inversely. A heuristic anchor — no live benchmarking in v1.
 */
export const SPEED_REFERENCE_PARAMS = 7e9;

/**
 * Reference quant width (bits per parameter) treated as "neutral" for speed:
 * matches Q4, the most common serving quant. A narrower quant scores faster, a
 * wider one slower, and an unrecognized quant assumes this width (neutral 1.0×).
 */
export const SPEED_REFERENCE_BITS_PER_PARAM = 4.7;
