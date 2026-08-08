import { z } from "zod";
import { ValidationError } from "../errors.js";
import { isSafeModelId } from "../backend/net.js";
import type { CommandViewModelMap } from "./types.js";

const MAX_ITEMS = 1_000;
const text = z.string();
const finite = z.number().finite();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const items = <T extends z.ZodTypeAny>(schema: T): z.ZodArray<T> => schema.array().max(MAX_ITEMS);

const displayIdentifierSchema = z.discriminatedUnion("actionable", [
  z.object({ actionable: z.literal(true), canonical: text, display: text }).strict(),
  z.object({ actionable: z.literal(false), display: text }).strict(),
]);

const throughputSchema = z.discriminatedUnion("known", [
  z
    .object({
      known: z.literal(true),
      lowTokPerSec: finite.nonnegative(),
      highTokPerSec: finite.nonnegative(),
      label: text,
    })
    .strict(),
  z
    .object({
      known: z.literal(false),
      label: text,
      reason: z.enum([
        "no-sourced-performance-profile",
        "not-evaluated-model-does-not-fit",
      ]),
    })
    .strict(),
]);

const gpuSchema = z.object({ vendor: text, vramBytes: count }).strict();
const hardwareSchema = z
  .object({
    arch: text,
    platform: text,
    totalRamBytes: count,
    freeRamBytes: count,
    usableBytes: count,
    memoryKind: z.enum(["ram", "vram"]),
    freeDiskBytes: count,
    gpu: items(gpuSchema),
  })
  .strict();

const scoreSchema = z
  .object({
    quality: finite,
    fit: finite,
    speed: finite,
    recency: finite,
    capability: finite,
  })
  .strict();

const recommendRowSchema = z
  .object({
    rank: count,
    model: displayIdentifierSchema,
    params: text,
    quant: text,
    requiredBytes: count,
    verdict: z.enum(["yes", "slow"]),
    throughput: throughputSchema,
    backends: items(text),
    license: text,
    score: finite,
    scores: scoreSchema,
    capabilities: items(text),
    contextLength: count,
    contextEvidence: text,
    throughputBackend: text,
    throughputEvidence: text,
  })
  .strict();

const commandModelId = text
  .max(8 * 1024)
  .refine((value) => isSafeModelId(value) && !value.split("/").includes(".."));
const commandHandoffSchema = z
  .object({
    argv: z.tuple([z.literal("local-llmup"), z.literal("up"), commandModelId]),
    display: text,
  })
  .strict();

const recommendSchema = z
  .object({
    hardware: hardwareSchema,
    rows: items(recommendRowSchema),
    wontFit: items(
      z.object({ model: displayIdentifierSchema, reason: text }).strict(),
    ),
    command: commandHandoffSchema.nullable(),
  })
  .strict();

const canRunSchema = z
  .object({
    model: displayIdentifierSchema,
    verdict: z.enum(["yes", "slow", "no"]),
    quant: text.nullable(),
    reason: text.nullable(),
    throughput: throughputSchema,
    backends: items(text),
    throughputBackend: text,
    requiredBytes: count.nullable(),
    usableBytes: count.nullable(),
    fitEvidence: text,
    throughputEvidence: text,
  })
  .strict();

const scoreSubSchema = z
  .object({ vram: finite, ram: finite, compute: finite, storage: finite })
  .strict();

const doctorSchema = z
  .object({
    ok: z.boolean(),
    checks: items(
      z.object({ name: text, status: z.enum(["ok", "warn", "fail"]), detail: text }).strict(),
    ),
    backends: items(
      z
        .object({
          name: text,
          installed: z.boolean(),
          version: text.nullable(),
          isDefault: z.boolean(),
          installHint: text,
        })
        .strict(),
    ),
    score: finite.nullable(),
    scoreSub: scoreSubSchema.nullable(),
    bottleneck: text.nullable(),
  })
  .strict();

const catalogSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ollama"), id: text }).strict(),
  z.object({ type: z.literal("hf"), repo: text }).strict(),
  z
    .object({
      type: z.literal("gguf"),
      repo: text,
      revision: text,
      file: text,
      sha256: text,
    })
    .strict(),
  z
    .object({
      type: z.literal("mlx"),
      repo: text,
      revision: text,
      files: items(z.object({ file: text, sha256: text, bytes: count }).strict()),
    })
    .strict(),
]);

const catalogQuantSchema = z
  .object({
    name: text,
    diskBytes: count,
    minRamBytes: count,
    minVramBytes: count,
    sha256: text.nullable(),
    digestVerified: z.boolean().nullable(),
  })
  .strict();

const catalogRowSchema = z
  .object({
    model: displayIdentifierSchema,
    params: text,
    architecture: text,
    quant: text,
    requiredBytes: count,
    fit: z.enum(["fit", "ram-bound", "vram-bound", "disk-bound", "context-bound"]),
    releaseDate: text,
    family: text,
    activeParams: text.nullable(),
    openWeight: z.boolean(),
    capabilities: items(text),
    license: text,
    contextLength: count,
    kvBytesPerToken: count.nullable(),
    benchmarkProxy: finite.nullable(),
    sources: items(catalogSourceSchema),
    supportedBackends: items(text),
    quantizations: items(catalogQuantSchema),
  })
  .strict();

const catalogSchema = z
  .object({
    hardware: hardwareSchema,
    filter: z.enum(["fits", "all"]),
    total: count,
    rows: items(catalogRowSchema),
    refresh: z
      .object({
        added: items(text),
        updated: items(text),
        removed: items(text),
        skipped: items(text),
        capped: items(text),
      })
      .strict()
      .nullable(),
    emptyReason: text.nullable(),
  })
  .strict();

const lsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty"), nextCommand: text }).strict(),
  z
    .object({
      type: z.literal("active"),
      model: displayIdentifierSchema,
      backend: text,
      endpoint: text,
      port: z.number().int().min(1).max(65_535),
      ownership: z.enum(["owned", "attached"]),
    })
    .strict(),
]);

const schemas = {
  recommend: recommendSchema,
  canRun: canRunSchema,
  doctor: doctorSchema,
  catalog: catalogSchema,
  ls: lsSchema,
} as const;

/** Strictly validate a command-specific final DTO and reject every unknown field. */
export function parseCommandViewModel<K extends keyof CommandViewModelMap>(
  screen: K,
  value: unknown,
): CommandViewModelMap[K] {
  const parsed = schemas[screen].safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`invalid ${screen} completion view model`);
  }
  return parsed.data as CommandViewModelMap[K];
}
