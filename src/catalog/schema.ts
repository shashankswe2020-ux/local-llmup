import { z } from "zod";
import { CAPABILITIES, LICENSE_ALLOWLIST, MODEL_ARCHITECTURES, type Catalog } from "../types.js";

/** Compile-time drift guard: `T` must be assignable to `U`. */
type AssertAssignable<T extends U, U> = T;

const SHA256_RE = /^[0-9a-f]{64}$/i;
const PARAM_LABEL_RE = /^\d+(\.\d+)?[BMT]$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 40-char lowercase-or-upper hex — a pinned git commit SHA (never a tag/branch). */
const REVISION_RE = /^[0-9a-f]{40}$/i;
/** Hugging Face repo id: exactly one `owner/name`, each segment starting alphanumeric. */
const HF_REPO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MLX_EXECUTABLE_FILE_RE = /\.(?:py|pyc|pyo|so|dylib|dll|bundle)$/i;

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
    file: z.string().min(1).max(255).refine(isSafeModelFile, {
      message: "file must be a safe repo-relative path (no globs, `..`, or absolute paths)",
    }),
    sha256: z.string().regex(SHA256_RE),
  })
  .strict();

const MlxSourceSchema = z
  .object({
    repo: HfRepoIdSchema,
    revision: z.string().regex(REVISION_RE, { message: "revision must be a 40-hex commit SHA" }),
    files: z
      .array(
        z
          .object({
            file: z
              .string()
              .min(1)
              .max(512)
              .refine(isSafeModelFile, {
                message:
                  "file must be a safe repo-relative path (no globs, `..`, or absolute paths)",
              })
              .refine((file) => !MLX_EXECUTABLE_FILE_RE.test(file), {
                message: "MLX manifest must not contain executable Python or native-module files",
              }),
            sha256: z.string().regex(SHA256_RE),
            bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(3)
      .max(256),
  })
  .strict()
  .superRefine((source, ctx) => {
    const paths = new Set<string>();
    for (const [index, entry] of source.files.entries()) {
      if (paths.has(entry.file)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "file"],
          message: `duplicate MLX file path: ${entry.file}`,
        });
      }
      paths.add(entry.file);
    }
    if (!paths.has("config.json")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "MLX manifest requires config.json",
      });
    }
    if (!paths.has("tokenizer_config.json")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "MLX manifest requires tokenizer_config.json",
      });
    }
    if (![...paths].some((path) => path.endsWith(".safetensors"))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "MLX manifest requires safetensors weights or index",
      });
    }
  });

const QuantizationSchema = z
  .object({
    name: z.string().min(1),
    diskBytes: z.number().int().positive().safe(),
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
      s.ollama !== undefined || s.hf !== undefined || s.gguf !== undefined || s.mlx !== undefined,
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
    if (model.source.mlx !== undefined) {
      if (model.quantizations.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["quantizations"],
          message: "a model-level MLX manifest requires exactly one quantization",
        });
      }
      let manifestBytes = 0;
      for (const file of model.source.mlx.files) {
        manifestBytes += file.bytes;
        if (!Number.isSafeInteger(manifestBytes)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source", "mlx", "files"],
            message: "MLX manifest byte total exceeds the safe integer range",
          });
          break;
        }
      }
      const quantization = model.quantizations[0];
      if (
        Number.isSafeInteger(manifestBytes) &&
        quantization !== undefined &&
        quantization.diskBytes !== manifestBytes
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["quantizations", 0, "diskBytes"],
          message: "MLX manifest bytes must equal the quantization diskBytes",
        });
      }
    }
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
