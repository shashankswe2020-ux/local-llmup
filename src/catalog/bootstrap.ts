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

/**
 * Curated pinned GGUF artifacts for llama.cpp-backed pulls (B15). These are
 * injected during bootstrap so reruns reproduce `data/models.json` exactly.
 */
const BOOTSTRAP_GGUF_SOURCES: Readonly<
  Record<string, { readonly repo: string; readonly revision: string; readonly file: string; readonly sha256: string }>
> = {
  "qwen3:14b": {
    repo: "Qwen/Qwen3-14B-GGUF",
    revision: "530227a7d994db8eca5ab5ced2fb692b614357fd",
    file: "Qwen3-14B-Q4_K_M.gguf",
    sha256: "500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0",
  },
  "qwen3:30b-a3b": {
    repo: "Qwen/Qwen3-30B-A3B-GGUF",
    revision: "e4d4bafdfb96a411a163846265362aceb0b9c63a",
    file: "Qwen3-30B-A3B-Q4_K_M.gguf",
    sha256: "0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5",
  },
  "qwen3:32b": {
    repo: "Qwen/Qwen3-32B-GGUF",
    revision: "938a7432affaec9157f883a87164e2646ae17555",
    file: "Qwen3-32B-Q4_K_M.gguf",
    sha256: "efd971561896866f0e910cce52761ca77b1b138090c7f15fe284676d57d1f689",
  },
};

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
 * Curated fp16 KV-cache bytes per token, keyed by model id (D6, D11). Each value
 * is the standard MHA/GQA formula `2 (K,V) × nLayers × nKvHeads × headDim × 2`
 * bytes, computed from the model's published attention geometry and folded into
 * the catalog at bootstrap so the runtime never re-derives geometry.
 *
 * Honesty gate: only standard-attention (MHA/GQA) models with confidently known
 * geometry are listed. A model **absent** here reports context sizing as
 * `unknown` rather than a fabricated number. Deliberately excluded:
 * - MLA models (DeepSeek-V2/V3 and its 671B R1) — a compressed latent KV; the
 *   generic formula over-counts ~5–10×.
 * - Sliding-window / hybrid-attention models (Gemma 2/3) — per-layer KV differs
 *   from the flat formula; deferred until curated correctly.
 * The R1 *distills* (Qwen/Llama backbones) are standard attention but left for a
 * later tranche to keep this first pass to high-confidence geometries.
 */
export const KV_BYTES_PER_TOKEN_FP16: Readonly<Record<string, number>> = {
  // Llama 3.x — GQA, 8 KV heads, head-dim 128 (3.2 1B uses head-dim 64).
  "llama3.1:8b": 131_072, //  32 L × 8 kv × 128 hd
  "llama3.1:70b": 327_680, // 80 L × 8 kv × 128 hd
  "llama3.3:70b": 327_680, // 80 L × 8 kv × 128 hd
  "llama3.2:1b": 32_768, //   16 L × 8 kv ×  64 hd
  "llama3.2:3b": 114_688, //  28 L × 8 kv × 128 hd
  // Qwen2.5 — GQA, head-dim 128 (0.5B uses head-dim 64).
  "qwen2.5:0.5b": 12_288, //  24 L × 2 kv ×  64 hd
  "qwen2.5:1.5b": 28_672, //  28 L × 2 kv × 128 hd
  "qwen2.5:3b": 36_864, //    36 L × 2 kv × 128 hd
  "qwen2.5:7b": 57_344, //    28 L × 4 kv × 128 hd
  "qwen2.5:14b": 196_608, //  48 L × 8 kv × 128 hd
  "qwen2.5:32b": 262_144, //  64 L × 8 kv × 128 hd
  "qwen2.5:72b": 327_680, //  80 L × 8 kv × 128 hd
  "qwen2.5-coder:7b": 57_344, //  same geometry as qwen2.5:7b
  "qwen2.5-coder:32b": 262_144, // same geometry as qwen2.5:32b
  // Mistral — GQA, 8 KV heads, explicit head-dim 128 (read explicitly, not
  // hidden_size/nHeads, per D11 — Nemo/Small publish head_dim independently).
  // Pinned upstream revisions: mistral:7b → v0.3 (32 L), mistral-small:24b →
  // the 2501 24B build (40 L); a future retag to a different arch must re-curate.
  "mistral:7b": 131_072, //       32 L × 8 kv × 128 hd
  "mistral-nemo:12b": 163_840, //  40 L × 8 kv × 128 hd
  "mistral-small:24b": 163_840, // 40 L × 8 kv × 128 hd
};

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
  const models = catalog.models.map((model) => {
    const kv = KV_BYTES_PER_TOKEN_FP16[model.id];
    const gguf = BOOTSTRAP_GGUF_SOURCES[model.id];
    return {
      ...model,
      source: {
        ...model.source,
        ...(gguf !== undefined ? { gguf } : {}),
      },
      ...(kv !== undefined ? { kvBytesPerToken: kv } : {}),
      benchmarkProxy: deriveBenchmarkProxy(model),
    };
  });
  const validated: Catalog = CatalogSchema.parse({
    schemaVersion: 2,
    generatedAt: catalog.generatedAt,
    models,
  });
  return validated;
}
