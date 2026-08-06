/**
 * Phase 2 — decode throughput estimator. Predicts interactive tokens/sec as a
 * **range**, never a point value, using a memory-bandwidth roofline: decode is
 * memory-bound, so each generated token reads the resident weights once and
 *
 *   tok/s ≈ (effectiveBandwidth × efficiency) / weightBytesPerToken.
 *
 * The bandwidth and efficiency come from the matched {@link PerfClass}
 * ({@link matchPerf}); `weightBytesPerToken` is derived from the quant's
 * bits-per-parameter and the **decode** parameter count. For MoE models that is
 * the **active** parameter set (only the routed experts are read per token),
 * even though the memory *footprint* — computed elsewhere by
 * {@link requiredMemoryBytes} — sizes by the **total** parameters because every
 * expert stays resident. Dense models use their total parameters for both.
 *
 * Everything is a pure function of the inputs. When the detected hardware has no
 * performance profile, the estimate is `{ known: false }` with zeroed bounds:
 * the honesty gate (spec §2) — no match means no number, never a guess.
 */
import { matchPerf, type PerfClass, type PerfDataset } from "./perf-data.js";
import { parseParamCount, quantBitsPerParam } from "../hardware/memory-math.js";
import type {
  BackendName,
  CatalogModel,
  HardwareProfile,
  Quantization,
  ThroughputEstimate,
} from "../types.js";

/** Default half-width of the reported range around the point estimate (±30%). */
export const DEFAULT_BAND_FRACTION = 0.3;

/** GB (as used by vendor bandwidth specs) in bytes: decimal, 10⁹. */
const BYTES_PER_GB = 1e9;

/** Advice-path default backend: deterministic, never `isInstalled()`-derived. */
const DEFAULT_THROUGHPUT_BACKEND: BackendName = "ollama";

/**
 * Backends that reuse a class's shared `efficiency` when they have no explicit
 * `efficiencyByBackend` scalar. Ollama and llama.cpp share the roofline with no
 * invented delta (spec §2.7); any other backend without a scalar is `unknown`.
 */
const SHARED_CLASS_EFFICIENCY_BACKENDS: readonly BackendName[] = ["ollama", "llamacpp"];

/** An estimate carrying no usable number (honesty gate). */
const UNKNOWN: ThroughputEstimate = { lowTokPerSec: 0, highTokPerSec: 0, known: false };

/**
 * Resolve the decode efficiency for `backend` on `perfClass`: an explicit
 * per-backend scalar wins; otherwise `ollama`/`llamacpp` reuse the class
 * `efficiency`; every other backend without a scalar is `undefined` (honesty
 * gate → `unknown`).
 */
function resolveEfficiency(perfClass: PerfClass, backend: BackendName): number | undefined {
  const explicit = perfClass.efficiencyByBackend?.[backend];
  if (explicit !== undefined) return explicit;
  return SHARED_CLASS_EFFICIENCY_BACKENDS.includes(backend) ? perfClass.efficiency : undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Bytes of weights read per decoded token: the decode parameter set scaled by
 * the quant's bits-per-parameter. Returns `undefined` when the quant tag is
 * unrecognized for a model whose decode set cannot otherwise be sized (MoE),
 * so the caller falls back to the honesty gate rather than guessing.
 */
function weightBytesPerToken(model: CatalogModel, quant: Quantization): number | undefined {
  // MoE reads only its active experts per token; dense reads all its weights.
  const decodeLabel = model.architecture === "moe" ? model.activeParams : model.params;
  if (decodeLabel === undefined) return undefined; // MoE without activeParams (schema forbids)

  const bitsPerParam = quantBitsPerParam(quant.name);
  if (bitsPerParam === undefined) {
    // Unrecognized quant: a dense model reads its whole file, so on-disk size is
    // a fair proxy. For MoE the file is the *total* experts, which would badly
    // over-count the active read — refuse and let the honesty gate fire.
    return model.architecture === "moe" ? undefined : quant.diskBytes;
  }
  return Math.ceil((parseParamCount(decodeLabel) * bitsPerParam) / 8);
}

/**
 * Estimate decode throughput for `model`/`quant` on `hw`, using the performance
 * `dataset` to look up the machine's memory bandwidth and efficiency. The result
 * is a ±`bandFraction` range (default ±30%); `known` is false when the hardware
 * has no profile, the decode size cannot be determined, or the requested
 * `backend` has no efficiency figure for the matched class (honesty gate).
 *
 * `backend` defaults to `ollama` — the deterministic advice-path backend — so
 * existing call sites are byte-identical.
 */
export function estimateTokPerSec(
  model: CatalogModel,
  quant: Quantization,
  hw: HardwareProfile,
  dataset: PerfDataset,
  options: { bandFraction?: number; backend?: BackendName | undefined } = {},
): ThroughputEstimate {
  const perfClass = matchPerf(hw, dataset);
  if (perfClass === undefined) return UNKNOWN;

  const efficiency = resolveEfficiency(perfClass, options.backend ?? DEFAULT_THROUGHPUT_BACKEND);
  if (efficiency === undefined) return UNKNOWN;

  const bytesPerToken = weightBytesPerToken(model, quant);
  if (bytesPerToken === undefined || bytesPerToken <= 0) return UNKNOWN;

  const band = options.bandFraction ?? DEFAULT_BAND_FRACTION;
  const point = (perfClass.memBandwidthGBps * BYTES_PER_GB * efficiency) / bytesPerToken;

  return {
    lowTokPerSec: round1(point * (1 - band)),
    highTokPerSec: round1(point * (1 + band)),
    known: true,
  };
}
