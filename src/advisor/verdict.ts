/**
 * Phase 2 — runnability verdict. Answers "can this machine run this model, and
 * how well?" as a single {@link Runnable} value — `yes`, `slow`, or `no` — by
 * combining two existing engines:
 *
 * - {@link evaluateFit} decides whether the model fits at all (and at which
 *   quant), or fails with a typed `ram|vram|disk-bound` reason; and
 * - {@link estimateTokPerSec} predicts decode throughput for the fitting quant.
 *
 * The mapping is deliberately conservative:
 * - does not fit → `no` (carries the fit reason);
 * - fits and the estimated throughput clears {@link COMFORT_FLOOR} → `yes`;
 * - fits but under the floor → `slow`;
 * - fits but throughput is **unknown** (hardware has no perf profile) → `slow`,
 *   never `yes` — the honesty gate: we won't claim comfort we can't estimate.
 *
 * Pure: a function of the model, hardware, and performance dataset only.
 */
import { estimateTokPerSec } from "./throughput.js";
import { COMFORT_FLOOR } from "./weights.js";
import type { PerfDataset } from "./perf-data.js";
import { evaluateFit, type FitReason } from "../ranking/fit.js";
import type {
  CatalogModel,
  HardwareProfile,
  Quantization,
  Runnable,
  ThroughputEstimate,
} from "../types.js";

/** A throughput estimate carrying no usable number (no fit, or no perf profile). */
const UNKNOWN_THROUGHPUT: ThroughputEstimate = {
  lowTokPerSec: 0,
  highTokPerSec: 0,
  known: false,
};

/** The runnability verdict plus the evidence it was derived from. */
export interface VerdictResult {
  readonly runnable: Runnable;
  /** Estimated decode throughput; `known:false` when it does not fit or the
   * hardware has no performance profile. */
  readonly throughput: ThroughputEstimate;
  /** The fitting quantization; present only when the model fits. */
  readonly quant?: Quantization;
  /** Why the model does not fit; present only when `runnable` is `no`. */
  readonly reason?: FitReason;
}

/**
 * Decide whether `model` runs on `hw`, using the performance `dataset` to
 * estimate throughput for the fitting quant. See the module docs for the
 * yes/slow/no mapping.
 */
export function evaluateVerdict(
  model: CatalogModel,
  hw: HardwareProfile,
  dataset: PerfDataset,
): VerdictResult {
  const fit = evaluateFit(model, hw);
  if (!fit.fits) {
    return { runnable: "no", throughput: UNKNOWN_THROUGHPUT, reason: fit.reason };
  }

  const throughput = estimateTokPerSec(model, fit.quant, hw, dataset);
  // Unknown throughput can never earn a `yes`; the midpoint of the known range
  // is the central estimate compared against the comfort floor.
  const midpoint = (throughput.lowTokPerSec + throughput.highTokPerSec) / 2;
  const runnable: Runnable =
    throughput.known && midpoint >= COMFORT_FLOOR ? "yes" : "slow";

  return { runnable, throughput, quant: fit.quant };
}
