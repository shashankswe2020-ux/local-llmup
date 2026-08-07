import { z } from "zod";
import {
  CAPABILITIES,
  LICENSE_ALLOWLIST,
  MODEL_ARCHITECTURES,
  type Catalog,
} from "../types.js";

/** Compile-time drift guard: `T` must be assignable to `U`. */
type AssertAssignable<T extends U, U> = T;

const SHA256_RE = /^[0-9a-f]{64}$/i;
const PARAM_LABEL_RE = /^\d+(\.\d+)?[BMT]$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 40-char lowercase-or-upper hex — a pinned git commit SHA (never a tag/branch). */
const REVISION_RE = /^[0-9a-f]{40}$/i;
/** Hugging Face repo id: exactly one `owner/name`, each segment starting alphanumeric. */
const HF_REPO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** True when `s` is a real calendar date (rejects e.g. 2024-02-30, 2024-13-01). */
function isRealCalendarDate(s: string): boolean {
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/**
 * True when `f` is a safe repo-relative file path: non-empty, no glob
 * metacharacters, no backslashes, no percent-encoding, no control characters,
 * not absolute, and no `.`/`..` segments (blocks path traversal — including
 * percent-encoded `%2e%2e` — when composing local cache paths).
 */
function isSafeModelFile(f: string): boolean {
  if (f.length === 0) return false;
  if (/[*?[\]{}]/.test(f)) return false;
  if (f.includes("\\")) return false;
  if (f.includes("%")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(f)) return false;
  if (f.startsWith("/")) return false;
  return f.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

const HfRepoIdSchema = z.string().min(1).max(200).regex(HF_REPO_ID_RE, {
  message: "repo must be a Hugging Face `owner/name` id",
});

const GgufSourceSchema = z
  .object({
    repo: HfRepoIdSchema,
    revision: z.string().regex(REVISION_RE, { message: "revision must be a 40-hex commit SHA" }),
    file: z
      .string()
      .min(1)
      .max(255)
      .refine(isSafeModelFile, {
        message: "file must be a safe repo-relative path (no globs, `..`, or absolute paths)",
      }),
    sha256: z.string().regex(SHA256_RE),
  })
  .strict();

const MlxSourceSchema = z
  .object({
    repo: HfRepoIdSchema,
    revision: z.string().regex(REVISION_RE, { message: "revision must be a 40-hex commit SHA" }),
  })
  .strict();

const QuantizationSchema = z
  .object({
    name: z.string().min(1),
    diskBytes: z.number().int().positive(),
    minRamBytes: z.number().int().positive(),
    minVramBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_RE).optional(),
    digestVerified: z.boolean().optional(),
  })
  .strict();

const ModelSourceSchema = z
  .object({
    ollama: z.string().min(1).optional(),
    hf: z.string().min(1).optional(),
    gguf: GgufSourceSchema.optional(),
    mlx: MlxSourceSchema.optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.ollama !== undefined ||
      s.hf !== undefined ||
      s.gguf !== undefined ||
      s.mlx !== undefined,
    {
      message: "source must specify at least one of `ollama`, `hf`, `gguf`, or `mlx`",
    },
  );

export const CatalogModelSchema = z
  .object({
    id: z.string().min(1),
    family: z.string().min(1),
    params: z.string().regex(PARAM_LABEL_RE),
    architecture: z.enum(MODEL_ARCHITECTURES),
    activeParams: z.string().regex(PARAM_LABEL_RE).optional(),
    license: z.enum(LICENSE_ALLOWLIST),
    openWeight: z.boolean(),
    contextLength: z.number().int().positive(),
    capabilities: z.array(z.enum(CAPABILITIES)).min(1),
    releaseDate: z
      .string()
      .regex(ISO_DATE_RE)
      .refine(isRealCalendarDate, { message: "releaseDate must be a real calendar date" }),
    source: ModelSourceSchema,
    quantizations: z.array(QuantizationSchema).min(1),
    kvBytesPerToken: z.number().int().positive().optional(),
    benchmarkProxy: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((model, ctx) => {
    if (model.architecture === "moe" && model.activeParams === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeParams"],
        message: "MoE models must declare `activeParams`",
      });
    }
    if (model.architecture === "dense" && model.activeParams !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeParams"],
        message: "dense models must not declare `activeParams`",
      });
    }
    if (!model.openWeight) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openWeight"],
        message: "catalog admits only open-weight licenses; openWeight must be true",
      });
    }
  });

export const CatalogSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatedAt: z.string().datetime(),
    models: z.array(CatalogModelSchema).min(1),
  })
  .strict();

// Validated output must conform to the shared domain `Catalog` type. (Forward
// direction only: it catches a loosened schema widening the inferred type — the
// security-critical case — without forcing the domain types to drop `readonly`.)
type _CatalogConforms = AssertAssignable<z.infer<typeof CatalogSchema>, Catalog>;
