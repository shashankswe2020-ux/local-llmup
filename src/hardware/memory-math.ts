/**
 * Shared memory arithmetic used by both the runtime ranker and the catalog
 * enrichment pipeline. Keeping one module means the "does it fit?" answer a user
 * sees is derived from the exact same formula that wrote the catalog's
 * `minRamBytes`/`minVramBytes`, so recommendations can never drift from the data.
 */
import { ValidationError } from "../errors.js";
import type { CatalogModel, HardwareProfile, ModelArchitecture, Quantization } from "../types.js";

/** RAM the OS and other processes need; never handed to an inference process. */
const OS_RESERVE_BYTES = 2 * 1024 ** 3;

/**
 * Runtime overhead (KV cache, activations, allocator slack) as a fraction of
 * resident weight bytes. A single conservative margin keeps v1 simple; the
 * enrichment pipeline and ranker share it so their numbers agree.
 */
const RUNTIME_OVERHEAD_FRACTION = 0.15;

const PARAM_LABEL_RE = /^(\d+(?:\.\d+)?)([BMT])$/;
const PARAM_UNIT_MULTIPLIER: Readonly<Record<string, number>> = {
  M: 1e6,
  B: 1e9,
  T: 1e12,
};

/**
 * Approximate bits-per-parameter for a quantization, keyed off the leading
 * `Q<n>` / float tag in its name. Unknown tags return `undefined` so callers
 * fall back to the catalog's measured on-disk size rather than guessing.
 */
export function quantBitsPerParam(name: string): number | undefined {
  const normalized = name.toLowerCase();
  // Non-linear IK quants (`IQ*`) must be matched before the plain `Q*` rows,
  // otherwise an `IQ4_XS` name would fall through and disable the MoE floor.
  if (/^iq1/.test(normalized)) return 1.9;
  if (/^iq2/.test(normalized)) return 2.4;
  if (/^iq3/.test(normalized)) return 3.4;
  if (/^iq4/.test(normalized)) return 4.3;
  if (/^q2/.test(normalized)) return 2.8;
  if (/^q3/.test(normalized)) return 3.5;
  if (/^q4/.test(normalized)) return 4.7;
  if (/^q5/.test(normalized)) return 5.6;
  if (/^q6/.test(normalized)) return 6.6;
  if (/^q8/.test(normalized)) return 8.5;
  if (/^(f16|fp16|bf16)/.test(normalized)) return 16.5;
  if (/^(f32|fp32)/.test(normalized)) return 32.5;
  return undefined;
}

/** Parse a parameter-count label (e.g. "8B", "1T") into an absolute count. */
export function parseParamCount(label: string): number {
  const match = PARAM_LABEL_RE.exec(label);
  const multiplier = match ? PARAM_UNIT_MULTIPLIER[match[2] as string] : undefined;
  if (!match || multiplier === undefined) {
    throw new ValidationError(`invalid parameter label: ${JSON.stringify(label)}`);
  }
  const count = Number(match[1]) * multiplier;
  if (!Number.isFinite(count) || count <= 0) {
    throw new ValidationError(`parameter count must be positive: ${JSON.stringify(label)}`);
  }
  return count;
}

/**
 * Which pool bounds a single inference process on this machine: dedicated GPU
 * VRAM (discrete GPU) or system RAM (Apple unified, integrated, or CPU-only).
 * The ranker uses this to label a won't-fit reason as `vram-bound` vs
 * `ram-bound`, sharing one branch definition with {@link usableMemoryBytes}.
 */
export function usableMemoryKind(hw: HardwareProfile): "ram" | "vram" {
  const largestVram = hw.gpu.reduce((max, g) => Math.max(max, g.vramBytes), 0);
  const unified = hw.arch === "arm64" && hw.platform === "darwin";
  return !unified && largestVram > 0 ? "vram" : "ram";
}

/**
 * Memory the machine can realistically give a single inference process.
 *
 * - Apple unified memory: total RAM shared with the GPU, minus an OS reserve.
 * - Discrete GPU: the single largest VRAM pool (v1 does not split across GPUs,
 *   and never adds VRAM to RAM — that would double-count).
 * - CPU-only: free RAM minus an OS reserve.
 */
export function usableMemoryBytes(hw: HardwareProfile): number {
  const largestVram = hw.gpu.reduce((max, g) => Math.max(max, g.vramBytes), 0);
  if (usableMemoryKind(hw) === "vram") return largestVram;
  const unified = hw.arch === "arm64" && hw.platform === "darwin";
  const pool = unified ? hw.totalRamBytes : hw.freeRamBytes;
  return Math.max(0, pool - OS_RESERVE_BYTES);
}

/**
 * Memory required to load and run one quantization of a model.
 *
 * MoE models keep **all** experts resident, so the footprint is driven by the
 * model's **total** parameter count — `activeParams` affects speed, never
 * memory, and is deliberately ignored here. The formula floor also guards
 * against a catalog whose `diskBytes` was mistakenly sized by the active set.
 */
export function requiredMemoryBytes(model: CatalogModel, quant: Quantization): number {
  return quantMemoryBytes({
    params: model.params,
    architecture: model.architecture,
    quantName: quant.name,
    diskBytes: quant.diskBytes,
    modelId: model.id,
  });
}

/** Inputs the shared sizing formula needs, independent of a full catalog entry. */
export interface QuantSizingInput {
  /** Total parameter-count label, e.g. "8B", "1T". */
  readonly params: string;
  readonly architecture: ModelArchitecture;
  /** Quantization tag, e.g. "Q4_K_M"; drives bits-per-parameter. */
  readonly quantName: string;
  /** Measured on-disk size of the weights for this quant. */
  readonly diskBytes: number;
  /** Optional id, purely for clearer error messages. */
  readonly modelId?: string | undefined;
}

/**
 * Resident + runtime-overhead bytes for one quantization, computed from the
 * model's **total** parameters and the quant tag. This is the single source of
 * truth shared by the runtime ranker ({@link requiredMemoryBytes}) and the
 * catalog-enrichment pipeline (which writes `minRamBytes`/`minVramBytes`), so a
 * user's "does it fit?" answer can never drift from the numbers in the catalog.
 */
export function quantMemoryBytes(input: QuantSizingInput): number {
  const { params, architecture, quantName, diskBytes } = input;
  const label = input.modelId !== undefined ? JSON.stringify(input.modelId) : "model";
  if (!Number.isFinite(diskBytes) || diskBytes <= 0) {
    throw new ValidationError(
      `quantization ${JSON.stringify(quantName)} has invalid diskBytes: ${String(diskBytes)}`,
    );
  }

  // Total parameters drive footprint for BOTH architectures. For MoE this is
  // load-bearing: every expert must be resident, so we size by total `params`
  // and never by `activeParams`, which only affects tokens/sec. The formula
  // floor below then rescues a catalog whose `diskBytes` was mistakenly sized by
  // the active subset.
  const footprintParams = parseParamCount(params);

  const bitsPerParam = quantBitsPerParam(quantName);
  // An unrecognized quant disables the formula floor. That is safe for a dense
  // model (fall back to the measured disk size) but NOT for MoE, whose whole
  // reason to exist here is the total-param rescue — refuse rather than risk
  // silently under-sizing all experts.
  if (bitsPerParam === undefined && architecture === "moe") {
    throw new ValidationError(
      `cannot size MoE ${label}: unrecognized quantization ${JSON.stringify(quantName)}`,
    );
  }
  const formulaFloor =
    bitsPerParam === undefined ? 0 : Math.ceil((footprintParams * bitsPerParam) / 8);

  const residentBytes = Math.max(diskBytes, formulaFloor);
  return residentBytes + Math.ceil(residentBytes * RUNTIME_OVERHEAD_FRACTION);
}
