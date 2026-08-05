/**
 * Advisor constants: the single source of truth for the AI Hardware Score
 * sub-weights and the throughput comfort floor. Mirrors `ranking/weights.ts` so
 * `score.ts` (Phase 1) and `verdict.ts` (Phase 2) can never diverge from these
 * values, and so the weight-sum invariant is asserted in exactly one place.
 */
import type { Bottleneck } from "../types.js";

/** Weight on dedicated GPU VRAM — the dominant constraint for local LLMs. */
export const W_VRAM = 0.4;
/** Weight on system RAM headroom (CPU/unified inference, larger contexts). */
export const W_RAM = 0.25;
/** Weight on compute class (CPU/GPU generation and throughput potential). */
export const W_COMPUTE = 0.25;
/** Weight on free-storage headroom for downloading model weights. */
export const W_STORAGE = 0.1;

/**
 * The four AI-Hardware-Score sub-weights, keyed by the axis they score. They
 * MUST sum to 1 (asserted by a test) so that each sub-score in [0, 1] yields a
 * composite in [0, 1] before scaling to the 0–100 headline number.
 */
export const SCORE_WEIGHTS: Readonly<Record<Bottleneck, number>> = {
  vram: W_VRAM,
  ram: W_RAM,
  compute: W_COMPUTE,
  storage: W_STORAGE,
} as const;

/**
 * Estimated decode throughput (tokens/sec) at or above which a model that fits
 * is called `yes` rather than `slow`. A deliberately conservative interactive
 * floor: below it, generation feels sluggish for chat use. (Decision D1.)
 */
export const COMFORT_FLOOR = 10;
