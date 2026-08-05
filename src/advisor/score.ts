/**
 * Phase 1 — AI Hardware Score. A **model-independent**, deterministic rating of
 * how well a machine can serve local LLMs, plus the axis that most limits it.
 *
 * The score composes four sub-scores — VRAM, RAM, compute, storage — each
 * normalized to `[0, 1]` against a fixed reference anchor, then combined with the
 * shared {@link SCORE_WEIGHTS} into a `0..100` headline number. Because the
 * detected {@link HardwareProfile} carries no CPU model or core count, the
 * `compute` axis is a documented **proxy** derived from the GPU tier (VRAM as a
 * stand-in for card class) and architecture, not a fabricated CPU lookup.
 *
 * Everything here is a pure function of the profile — no I/O, no clock — so the
 * `doctor` command can render a stable score and the same inputs always produce
 * the same output.
 */
import { SCORE_WEIGHTS } from "./weights.js";
import { BOTTLENECKS } from "../types.js";
import type { Bottleneck, HardwareProfile, HardwareScore } from "../types.js";

const GIB = 1024 ** 3;

/** VRAM at which the VRAM axis saturates (runs most ~32B Q4 models well). */
const VRAM_REFERENCE_BYTES = 24 * GIB;
/** System RAM at which the RAM axis saturates (comfortable CPU/large-context). */
const RAM_REFERENCE_BYTES = 64 * GIB;
/** Discrete-GPU VRAM at which the compute proxy reaches its ceiling. */
const COMPUTE_VRAM_REFERENCE_BYTES = 24 * GIB;
/** Free disk at which the storage axis saturates (room for several models). */
const STORAGE_REFERENCE_BYTES = 200 * GIB;

/** A discrete GPU always beats CPU inference: its compute proxy starts here. */
const DISCRETE_GPU_COMPUTE_FLOOR = 0.5;
/** Apple-silicon unified GPU: capable, below a high-end discrete card. */
const APPLE_UNIFIED_COMPUTE = 0.65;
/** No GPU at all — CPU-only inference. */
const CPU_ONLY_COMPUTE = 0.25;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** Apple-silicon machines share one unified memory pool between CPU and GPU. */
function isUnified(hw: HardwareProfile): boolean {
  return hw.arch === "arm64" && hw.platform === "darwin";
}

/** Largest single dedicated VRAM pool (0 when no recognized discrete GPU). */
function largestVramBytes(hw: HardwareProfile): number {
  return hw.gpu.reduce((max, g) => Math.max(max, g.vramBytes), 0);
}

/**
 * The GPU-accessible memory pool for model weights: dedicated VRAM on a discrete
 * GPU, unified RAM on Apple silicon, or 0 on a CPU-only box (where a low VRAM
 * axis correctly reads as "add a GPU").
 */
function gpuPoolBytes(hw: HardwareProfile): number {
  const vram = largestVramBytes(hw);
  if (vram > 0) return vram;
  if (isUnified(hw)) return hw.totalRamBytes;
  return 0;
}

/** Compute proxy in `[0, 1]` from GPU tier + architecture (see module docs). */
function computeScore(hw: HardwareProfile): number {
  const vram = largestVramBytes(hw);
  if (vram > 0) {
    const tier = clamp01(vram / COMPUTE_VRAM_REFERENCE_BYTES);
    return DISCRETE_GPU_COMPUTE_FLOOR + (1 - DISCRETE_GPU_COMPUTE_FLOOR) * tier;
  }
  if (isUnified(hw)) return APPLE_UNIFIED_COMPUTE;
  return CPU_ONLY_COMPUTE;
}

/** The four normalized sub-scores; shared by score + bottleneck selection. */
function subScores(hw: HardwareProfile): Record<Bottleneck, number> {
  return {
    vram: clamp01(gpuPoolBytes(hw) / VRAM_REFERENCE_BYTES),
    ram: clamp01(hw.totalRamBytes / RAM_REFERENCE_BYTES),
    compute: computeScore(hw),
    storage: clamp01(hw.freeDiskBytes / STORAGE_REFERENCE_BYTES),
  };
}

/**
 * Pick the primary bottleneck: the axis with the largest **weighted deficit**
 * `weight × (1 − subScore)` — the weakness that costs the score the most, so a
 * highly-weighted axis (VRAM) surfaces as the first upgrade rather than a
 * low-weight axis (storage) that a raw minimum would over-flag. Iterating in
 * {@link BOTTLENECKS} order with a strict `>` makes ties resolve to the
 * higher-weight axis first, so the result is deterministic.
 */
function pickBottleneck(sub: Record<Bottleneck, number>): Bottleneck {
  let best: Bottleneck = BOTTLENECKS[0];
  let bestDeficit = -Infinity;
  for (const axis of BOTTLENECKS) {
    const deficit = SCORE_WEIGHTS[axis] * (1 - sub[axis]);
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = axis;
    }
  }
  return best;
}

/** The axis that most limits this machine's local-LLM capability. */
export function identifyBottleneck(hw: HardwareProfile): Bottleneck {
  return pickBottleneck(subScores(hw));
}

/**
 * Compute the AI Hardware Score for a machine: a `0..100` headline, the four
 * sub-scores it was composed from, and the primary {@link Bottleneck}.
 */
export function computeHardwareScore(hw: HardwareProfile): HardwareScore {
  const sub = subScores(hw);
  const weighted = BOTTLENECKS.reduce((acc, axis) => acc + SCORE_WEIGHTS[axis] * sub[axis], 0);
  return {
    total: Math.round(weighted * 100),
    sub,
    bottleneck: pickBottleneck(sub),
  };
}
