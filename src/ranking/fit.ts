/**
 * Fit evaluation: decides whether a model fits the detected hardware and, if so,
 * at which quantization. A model is ranked at its **best-fitting quant** (the
 * highest-quality quant whose required memory clears the headroom); if none fit,
 * it is excluded with a typed reason so the caller can explain *why*.
 */
import {
  requiredMemoryAtContext,
  requiredMemoryBytes,
  usableMemoryBytes,
  usableMemoryKind,
} from "../hardware/memory-math.js";
import type { CatalogModel, HardwareProfile, Quantization } from "../types.js";
import { HEADROOM } from "./weights.js";

/** Why a model was excluded from the ranked list. */
export type FitReason = "ram-bound" | "vram-bound" | "disk-bound" | "context-bound";

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
  readonly usableBytes: number;
  readonly requiredBytes: number | null;
}

export type FitResult = FitOk | FitFail;

/**
 * Evaluate whether `model` fits `hw`. Memory is bounded by
 * `usableMemory * (1 - HEADROOM)`; disk is bounded exactly by free disk (a
 * shortfall means the weights cannot even be downloaded).
 */
export function evaluateFit(model: CatalogModel, hw: HardwareProfile): FitResult {
  return evaluateFitWith(model, hw, (quant) => requiredMemoryBytes(model, quant));
}

/**
 * Evaluate whether `model` fits `hw` at an explicit context of `tokens`, sizing
 * the KV cache from the model's sourced attention geometry.
 *
 * - `tokens > model.contextLength` → `context-bound` (a pure model-cap check,
 *   independent of memory or geometry; the boundary is inclusive, so
 *   `tokens == contextLength` passes through to the memory check).
 * - Unknown KV geometry → the honesty gate: we cannot size the cache, so we fall
 *   back to the legacy weights-based {@link evaluateFit}. The model still ranks,
 *   by weights; we neither reward nor penalize an unmeasurable context cost.
 * - Otherwise the same budget rule as {@link evaluateFit}, but each quant's
 *   footprint is {@link requiredMemoryAtContext} (floored at the legacy
 *   footprint), so a KV cache that overflows memory reports a memory reason,
 *   never `context-bound`.
 */
export function evaluateFitAtContext(
  model: CatalogModel,
  hw: HardwareProfile,
  tokens: number,
): FitResult {
  if (tokens > model.contextLength) {
    return {
      fits: false,
      reason: "context-bound",
      usableBytes: usableMemoryBytes(hw),
      requiredBytes: null,
    };
  }
  if (model.kvBytesPerToken === undefined) {
    return evaluateFit(model, hw);
  }
  return evaluateFitWith(model, hw, (quant) => {
    const bytes = requiredMemoryAtContext(model, quant, tokens);
    // Guaranteed defined: `kvBytesPerToken` was checked above. Assert rather
    // than silently fall back to the KV-less legacy footprint — that would be
    // the exact "claims fit, then OOMs" footgun this path exists to prevent.
    if (bytes === undefined) {
      throw new Error(`invariant: known KV geometry for ${model.id} sized to undefined`);
    }
    return bytes;
  });
}

/**
 * Shared budget rule for {@link evaluateFit} and {@link evaluateFitAtContext}.
 * `requiredBytesFor` supplies each quant's footprint; everything else — the
 * headroom-adjusted memory budget, disk check, best-quant selection, and
 * miss-reason logic — is identical across both paths.
 */
function evaluateFitWith(
  model: CatalogModel,
  hw: HardwareProfile,
  requiredBytesFor: (quant: Quantization) => number,
): FitResult {
  const usableBytes = usableMemoryBytes(hw);
  const memoryBudget = usableBytes * (1 - HEADROOM);
  const memoryReason: FitReason = usableMemoryKind(hw) === "vram" ? "vram-bound" : "ram-bound";

  let best: FitOk | undefined;
  let mostForgiving: { requiredBytes: number; memoryFits: boolean; diskFits: boolean } | undefined;

  for (const quant of model.quantizations) {
    const requiredBytes = requiredBytesFor(quant);
    const memoryFits = requiredBytes <= memoryBudget;
    const diskFits = quant.diskBytes <= hw.freeDiskBytes;

    if (memoryFits && diskFits) {
      // Best-fitting quant = highest quality that fits. For a single model,
      // required memory grows monotonically with quant quality (constant param
      // count → higher bits-per-param, and catalog `diskBytes` is non-decreasing
      // with quality; at a fixed context the KV term is quant-independent), so
      // the largest fitting `requiredBytes` is the highest-quality fitting quant.
      // Ties keep the first quant encountered.
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
  return { fits: false, reason, usableBytes, requiredBytes: mostForgiving?.requiredBytes ?? null };
}
