/**
 * Fit evaluation: decides whether a model fits the detected hardware and, if so,
 * at which quantization. A model is ranked at its **best-fitting quant** (the
 * highest-quality quant whose required memory clears the headroom); if none fit,
 * it is excluded with a typed reason so the caller can explain *why*.
 */
import { requiredMemoryBytes, usableMemoryBytes, usableMemoryKind } from "../hardware/memory-math.js";
import type { CatalogModel, HardwareProfile, Quantization } from "../types.js";
import { HEADROOM } from "./weights.js";

/** Why a model was excluded from the ranked list. */
export type FitReason = "ram-bound" | "vram-bound" | "disk-bound";

export interface FitOk {
  readonly fits: true;
  /** The highest-quality quantization that fits within headroom + disk. */
  readonly quant: Quantization;
  readonly requiredBytes: number;
  readonly usableBytes: number;
}

export interface FitFail {
  readonly fits: false;
  readonly reason: FitReason;
}

export type FitResult = FitOk | FitFail;

/**
 * Evaluate whether `model` fits `hw`. Memory is bounded by
 * `usableMemory * (1 - HEADROOM)`; disk is bounded exactly by free disk (a
 * shortfall means the weights cannot even be downloaded).
 */
export function evaluateFit(model: CatalogModel, hw: HardwareProfile): FitResult {
  const usableBytes = usableMemoryBytes(hw);
  const memoryBudget = usableBytes * (1 - HEADROOM);
  const memoryReason: FitReason = usableMemoryKind(hw) === "vram" ? "vram-bound" : "ram-bound";

  let best: FitOk | undefined;
  let mostForgiving: { requiredBytes: number; memoryFits: boolean; diskFits: boolean } | undefined;

  for (const quant of model.quantizations) {
    const requiredBytes = requiredMemoryBytes(model, quant);
    const memoryFits = requiredBytes <= memoryBudget;
    const diskFits = quant.diskBytes <= hw.freeDiskBytes;

    if (memoryFits && diskFits) {
      // Best-fitting quant = highest quality that fits. For a single model,
      // required memory grows monotonically with quant quality (constant param
      // count → higher bits-per-param, and catalog `diskBytes` is non-decreasing
      // with quality), so the largest fitting `requiredBytes` is the highest-
      // quality fitting quant. Ties keep the first quant encountered.
      if (best === undefined || requiredBytes > best.requiredBytes) {
        best = { fits: true, quant, requiredBytes, usableBytes };
      }
    }

    // Track the quant most likely to fit (smallest footprint) to explain a miss.
    if (mostForgiving === undefined || requiredBytes < mostForgiving.requiredBytes) {
      mostForgiving = { requiredBytes, memoryFits, diskFits };
    }
  }

  if (best !== undefined) return best;

  // Nothing fit. Memory pressure is the primary OOM risk, so it wins over disk
  // when the most-forgiving quant fails both.
  const reason: FitReason =
    mostForgiving === undefined || !mostForgiving.memoryFits ? memoryReason : "disk-bound";
  return { fits: false, reason };
}
