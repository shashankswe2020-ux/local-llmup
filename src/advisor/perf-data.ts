/**
 * Phase 2 — hardware performance dataset. Loads `data/perf.json`, a curated,
 * **price-free** table of memory bandwidth + roofline efficiency per hardware
 * class, and matches a detected {@link HardwareProfile} to at most one class.
 *
 * The dataset drives the throughput estimator (T36): decode is memory-bound, so
 * `tok/s ≈ (bandwidth / residentWeightBytes) × efficiency`. Because detection
 * only yields a vendor and a memory size — never an exact card or DRAM
 * generation — classes are coarse brackets and {@link matchPerf} returns
 * `undefined` for anything outside them (the honesty gate: no match → no
 * fabricated number, per spec §2). All figures are curated estimates from
 * published community benchmarks; each class cites its `source` (decision D2).
 *
 * Loading is I/O; matching is pure. Commands inject `loadPerf`; advisor modules
 * receive the parsed dataset as an argument.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import { BACKEND_NAMES, GPU_VENDORS, type HardwareProfile } from "../types.js";

/** The memory pool a hardware class describes weights live in. */
export const PERF_KINDS = ["discrete", "unified", "cpu"] as const;
export type PerfKind = (typeof PERF_KINDS)[number];

const ID_RE = /^[a-z0-9-]+$/;

/** Roofline efficiency: fraction of theoretical bandwidth realized in decode. */
const EFFICIENCY = z.number().gt(0).max(1);

/**
 * Optional per-backend absolute efficiency scalars keyed by {@link BackendName}.
 * A backend absent here resolves via the shared-class rule in `throughput.ts`
 * (`ollama`/`llamacpp` reuse the class `efficiency`; others → honesty-gate
 * `unknown`). Unknown backend keys and out-of-range values are rejected.
 */
const EfficiencyByBackendSchema = z.record(z.enum(BACKEND_NAMES), EFFICIENCY);

/**
 * Confidence tier for an encoded efficiency figure (spec §12). A
 * `low-confidence` figure is never encoded — it ships as `unknown`.
 */
export const TRUST_TIERS = ["session-verified", "spec-grade", "low-confidence"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/**
 * Provenance for one per-backend efficiency scalar: the value it attests, its
 * trust tier, the weight-bytes/token basis it was derived on (so figures stay
 * comparable across rows, spec §2.7), and a citing URL.
 */
const EfficiencyProvenanceSchema = z
  .object({
    value: EFFICIENCY,
    trustTier: z.enum(TRUST_TIERS),
    basisBytesPerToken: z.number().positive(),
    url: z.string().url(),
  })
  .strict();

/** Per-backend provenance, keyed by {@link BackendName}; unknown keys rejected. */
const EfficiencyProvenanceByBackendSchema = z.record(
  z.enum(BACKEND_NAMES),
  EfficiencyProvenanceSchema,
);

/**
 * Per-figure attribution: each measured number carries its own citation so a
 * reader can check the bandwidth against a vendor spec sheet and the efficiency
 * against the benchmark it was back-computed from (spec §2, decision D2).
 */
const PerfSourcesSchema = z
  .object({
    /** Where the `memBandwidthGBps` figure comes from (vendor spec sheet). */
    bandwidth: z.string().min(1),
    /** Where the `efficiency` figure comes from (the calibrating benchmark). */
    efficiency: z.string().min(1),
    /** Optional provenance for each per-backend scalar (spec §12; B9). */
    efficiencyByBackend: EfficiencyProvenanceByBackendSchema.optional(),
  })
  .strict();

const PerfClassSchema = z
  .object({
    /** Stable machine id (kebab-case); unique within the dataset. */
    id: z.string().regex(ID_RE),
    /** Human-readable label shown in citations. */
    label: z.string().min(1),
    vendor: z.enum(GPU_VENDORS),
    kind: z.enum(PERF_KINDS),
    /** Effective memory bandwidth in GB/s (roofline numerator). */
    memBandwidthGBps: z.number().positive(),
    /** Fraction of theoretical bandwidth realized during decode, in (0, 1]. */
    efficiency: EFFICIENCY,
    /** Optional absolute per-backend efficiency scalars (spec §12; B9). */
    efficiencyByBackend: EfficiencyByBackendSchema.optional(),
    /** Inclusive lower bound of the matching pool size, in bytes. */
    minBytes: z.number().int().nonnegative(),
    /** Exclusive upper bound of the matching pool size, in bytes. */
    maxBytes: z.number().int().positive(),
    /** Per-figure attribution for the numbers above (decision D2). */
    sources: PerfSourcesSchema,
  })
  .strict()
  .refine((c) => c.maxBytes > c.minBytes, {
    message: "maxBytes must be greater than minBytes",
    path: ["maxBytes"],
  })
  .superRefine((hardwareClass, context) => {
    for (const backend of BACKEND_NAMES) {
      const scalar = hardwareClass.efficiencyByBackend?.[backend];
      const provenance = hardwareClass.sources.efficiencyByBackend?.[backend];
      if (scalar !== undefined && provenance === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", "efficiencyByBackend", backend],
          message: `missing provenance for ${backend} efficiency`,
        });
      }
      if (scalar === undefined && provenance !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", "efficiencyByBackend", backend],
          message: `orphan provenance for absent ${backend} efficiency`,
        });
      }
      if (scalar !== undefined && provenance !== undefined) {
        if (provenance.value !== scalar) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sources", "efficiencyByBackend", backend, "value"],
            message: `provenance value must equal ${backend} efficiency scalar`,
          });
        }
        if (provenance.trustTier === "low-confidence") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sources", "efficiencyByBackend", backend, "trustTier"],
            message: "low-confidence efficiency must remain unknown",
          });
        }
      }
    }
  });

const PerfDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    classes: z.array(PerfClassSchema).min(1),
  })
  .strict();

/** One coarse hardware class: bandwidth + efficiency for a vendor/size bracket. */
export type PerfClass = z.infer<typeof PerfClassSchema>;
/** The validated performance dataset (`data/perf.json`). */
export type PerfDataset = z.infer<typeof PerfDatasetSchema>;

/** Default dataset location: `data/perf.json` at the package root. */
export const DEFAULT_PERF_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../data/perf.json",
);

/** Strip control/ANSI/BiDi bytes from every display string, flagging changes. */
function sanitizeDataset(dataset: PerfDataset): { dataset: PerfDataset; changed: boolean } {
  let changed = false;
  const clean = (value: string): string => {
    const out = stripControl(value);
    if (out !== value) changed = true;
    return out;
  };
  const cleanProvenance = (
    prov: NonNullable<PerfClass["sources"]["efficiencyByBackend"]>,
  ): NonNullable<PerfClass["sources"]["efficiencyByBackend"]> => {
    const out: Record<string, (typeof prov)[keyof typeof prov]> = {};
    for (const [backend, entry] of Object.entries(prov)) {
      out[backend] = { ...entry, url: clean(entry.url) };
    }
    return out;
  };
  const classes = dataset.classes.map((c) => ({
    ...c,
    label: clean(c.label),
    sources: {
      bandwidth: clean(c.sources.bandwidth),
      efficiency: clean(c.sources.efficiency),
      ...(c.sources.efficiencyByBackend !== undefined
        ? { efficiencyByBackend: cleanProvenance(c.sources.efficiencyByBackend) }
        : {}),
    },
  }));
  return { dataset: { ...dataset, classes }, changed };
}

/** Throw if two classes share an id (integrity check). */
function assertUniqueIds(dataset: PerfDataset): void {
  const seen = new Set<string>();
  for (const c of dataset.classes) {
    if (seen.has(c.id)) {
      throw new ValidationError(`Performance dataset contains duplicate class id: ${c.id}`);
    }
    seen.add(c.id);
  }
}

/**
 * Throw if two classes with the same vendor+kind have overlapping `[min, max)`
 * ranges. Matching returns the first range that contains the pool size, so any
 * overlap would make the estimate depend on array order — reject it up front.
 */
function assertNoOverlap(dataset: PerfDataset): void {
  for (let i = 0; i < dataset.classes.length; i += 1) {
    const a = dataset.classes[i]!;
    for (let j = i + 1; j < dataset.classes.length; j += 1) {
      const b = dataset.classes[j]!;
      if (a.vendor !== b.vendor || a.kind !== b.kind) continue;
      if (a.minBytes < b.maxBytes && b.minBytes < a.maxBytes) {
        throw new ValidationError(
          `Performance dataset has overlapping ranges for ${a.vendor}/${a.kind}: ${a.id} and ${b.id}`,
        );
      }
    }
  }
}

/**
 * Parse and validate raw performance-dataset JSON. Malformed JSON and
 * schema-invalid content both surface as {@link ValidationError}. Display
 * strings are stripped of ANSI/control/BiDi sequences; when `rejectOnSanitize`
 * is set (the trusted bundled dataset) any such character is an integrity
 * failure rather than a silent strip.
 */
export function parsePerf(raw: string, options?: { rejectOnSanitize?: boolean }): PerfDataset {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError("Performance dataset is not valid JSON", { cause });
  }

  const result = PerfDatasetSchema.safeParse(json);
  if (!result.success) {
    throw new ValidationError(
      `Performance dataset failed schema validation: ${stripControl(result.error.message)}`,
      { cause: result.error },
    );
  }

  const { dataset, changed } = sanitizeDataset(result.data);
  if (options?.rejectOnSanitize && changed) {
    throw new ValidationError(
      "Performance dataset contains control or formatting characters that are not allowed",
    );
  }

  assertUniqueIds(dataset);
  assertNoOverlap(dataset);
  return dataset;
}

/** Read, parse, and validate the performance dataset from disk. */
export function loadPerf(filePath: string = DEFAULT_PERF_PATH): PerfDataset {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new ValidationError(`Cannot read performance dataset at ${filePath}`, { cause });
  }
  return parsePerf(raw, { rejectOnSanitize: filePath === DEFAULT_PERF_PATH });
}

/** The vendor + pool kind + pool size that weights would occupy on this machine. */
interface Pool {
  readonly vendor: (typeof GPU_VENDORS)[number];
  readonly kind: PerfKind;
  readonly bytes: number;
}

/**
 * Where model weights live on this machine, and how large that pool is: dedicated
 * VRAM on the largest recognized discrete GPU, unified memory on Apple silicon,
 * or system RAM on a CPU-only box.
 */
function poolOf(hw: HardwareProfile): Pool {
  const discrete = hw.gpu
    .filter((g) => (g.vendor === "nvidia" || g.vendor === "amd") && g.vramBytes > 0)
    .sort((a, b) => b.vramBytes - a.vramBytes)[0];
  if (discrete) {
    return { vendor: discrete.vendor, kind: "discrete", bytes: discrete.vramBytes };
  }
  if (hw.arch === "arm64" && hw.platform === "darwin") {
    return { vendor: "apple", kind: "unified", bytes: hw.totalRamBytes };
  }
  return { vendor: "none", kind: "cpu", bytes: hw.totalRamBytes };
}

/**
 * Match a detected machine to at most one performance class, or `undefined` when
 * no seeded bracket covers it. An `undefined` result is the honesty gate: the
 * throughput estimator must then report no number rather than guess.
 */
export function matchPerf(hw: HardwareProfile, dataset: PerfDataset): PerfClass | undefined {
  const pool = poolOf(hw);
  return dataset.classes.find(
    (c) =>
      c.vendor === pool.vendor &&
      c.kind === pool.kind &&
      pool.bytes >= c.minBytes &&
      pool.bytes < c.maxBytes,
  );
}
