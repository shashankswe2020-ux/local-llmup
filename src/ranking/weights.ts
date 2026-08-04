/**
 * Ranking constants. This is the single source of truth for the scoring weights
 * and the memory-fit headroom so `fit.ts` and the scorer can never diverge.
 * (Scoring weights are added in the scoring task; T8 only needs `HEADROOM`.)
 */

/**
 * Fraction of usable memory kept in reserve when deciding whether a model fits.
 * A model fits only if `requiredMemory <= usableMemory * (1 - HEADROOM)`, so the
 * ranker never recommends a model that would run at the razor's edge of OOM.
 */
export const HEADROOM = 0.15;
