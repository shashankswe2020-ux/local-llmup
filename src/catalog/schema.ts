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

/** True when `s` is a real calendar date (rejects e.g. 2024-02-30, 2024-13-01). */
function isRealCalendarDate(s: string): boolean {
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

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
  })
  .strict()
  .refine((s) => s.ollama !== undefined || s.hf !== undefined, {
    message: "source must specify at least one of `ollama` or `hf`",
  });

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
