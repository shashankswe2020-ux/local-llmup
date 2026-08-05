/**
 * One-time catalog bootstrap (T28b). Runs the shared enrichment pipeline
 * ({@link enrichCatalog}) in **backfill** mode over a recorded registry snapshot
 * to produce the exhaustive v1 `data/models.json`, then stamps each model with a
 * deterministic `benchmarkProxy` derived from param-class plus a pinned quality
 * table (§3.4 / open-question 5: the proxy is frozen at enrich time, never
 * fetched at runtime, so ranking is reproducible in CI).
 *
 * The whole pipeline is pure and deterministic: given the same snapshot and the
 * same frozen clock it always yields a byte-identical catalog, so a re-run
 * reproduces the committed file exactly.
 */
import { parseParamCount } from "../hardware/memory-math.js";
import type { Catalog, CatalogModel } from "../types.js";
import { enrichCatalog, type RawRegistryModel } from "./enrich.js";
import { CatalogSchema } from "./schema.js";

/** Frozen clock for the v1 bootstrap; also caps the future-date guard. */
export const BOOTSTRAP_CLOCK = new Date("2026-08-04T00:00:00.000Z");

/**
 * Pinned per-family quality offset applied on top of the param-class base
 * score. This is the "pinned public-leaderboard snapshot" from the spec,
 * captured as a small static table so the proxy never depends on a live fetch.
 * Families punch above/below their raw parameter count (e.g. Phi-4 and the
 * reasoning-tuned DeepSeek-R1 line score higher than size alone implies).
 */
export const FAMILY_QUALITY_OFFSET: Readonly<Record<string, number>> = {
  "kimi-k2": 0.12,
  "kimi-k2-thinking": 0.14,
  "kimi-vl": 0.06,
  "kimi-dev": 0.08,
  "kimi-linear": 0.08,
  "llama3.3": 0.08,
  "llama3.1": 0.04,
  "llama3.2": 0.0,
  qwen3: 0.1,
  "qwen2.5": 0.06,
  "qwen2.5-coder": 0.08,
  "deepseek-v3": 0.1,
  "deepseek-r1": 0.12,
  mixtral: 0.05,
  "mistral-small": 0.05,
  "mistral-nemo": 0.03,
  mistral: 0.02,
  gemma3: 0.06,
  gemma2: 0.04,
  phi4: 0.12,
  "phi3.5": 0.08,
  phi3: 0.06,
  glm4: 0.05,
  yi: 0.03,
  olmo2: 0.02,
  "granite3.1": 0.03,
  "granite3-moe": 0.02,
  smollm2: 0.0,
};

function clampNum(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Param-class base score as a discrete `[exclusiveCeilingInBillions, score]`
 * ladder. A step table (rather than a `Math.log10` curve) keeps the derived
 * proxy bit-exact across V8/Node versions — transcendental functions are only
 * implementation-approximated in ECMA-262, which could otherwise flip a value
 * across a rounding boundary and make a CI regeneration diverge from the
 * committed `data/models.json`.
 */
const PARAM_CLASS_BASE: readonly (readonly [number, number])[] = [
  [0.5, 0.05],
  [1, 0.12],
  [2, 0.2],
  [4, 0.28],
  [7, 0.36],
  [10, 0.44],
  [15, 0.52],
  [25, 0.58],
  [40, 0.64],
  [80, 0.7],
  [200, 0.78],
  [Number.POSITIVE_INFINITY, 0.85],
];

function paramClassBase(totalBillions: number): number {
  for (const [ceiling, score] of PARAM_CLASS_BASE) {
    if (totalBillions < ceiling) return score;
  }
  return 0.85;
}

/**
 * Deterministic 0..1 quality proxy from total-parameter class plus the pinned
 * family offset. The score grows with model size but is clamped away from the
 * extremes so the ranker's quality dimension stays well-conditioned; the inner
 * clamp also guarantees the schema's `[0,1]` bound structurally regardless of
 * how the offset table is later edited.
 */
export function deriveBenchmarkProxy(model: Pick<CatalogModel, "family" | "params">): number {
  const offset = FAMILY_QUALITY_OFFSET[model.family] ?? 0;
  const totalBillions = parseParamCount(model.params) / 1e9;
  return round2(clampNum(paramClassBase(totalBillions) + offset, 0.05, 0.99));
}

// A zero-model seed for a full backfill. Intentionally NOT a shippable catalog
// (it would fail `CatalogSchema`'s `models.min(1)`); it is only ever the
// `existing` argument to `enrichCatalog`, which validates `existing` solely by
// `schemaVersion`, not by the full schema.
function emptySeed(now: Date): Catalog {
  return { schemaVersion: 2, generatedAt: now.toISOString(), models: [] };
}

/**
 * Build the complete v1 catalog from a recorded registry `snapshot` by running
 * enrichment in backfill mode and folding in the derived `benchmarkProxy`. The
 * result is re-validated against {@link CatalogSchema} so the shipped file is
 * guaranteed loadable and the injected proxy is in range.
 */
export function buildBootstrapCatalog(
  snapshot: readonly RawRegistryModel[],
  now: Date,
): Catalog {
  const { catalog } = enrichCatalog({
    mode: "backfill",
    existing: emptySeed(now),
    candidates: snapshot,
    now,
  });
  const models = catalog.models.map((model) => ({
    ...model,
    benchmarkProxy: deriveBenchmarkProxy(model),
  }));
  const validated: Catalog = CatalogSchema.parse({
    schemaVersion: 2,
    generatedAt: catalog.generatedAt,
    models,
  });
  return validated;
}
