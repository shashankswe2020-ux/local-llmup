import { buildEndpoint, DEFAULT_BIND_HOST } from "../backend/adapter.js";
import { createDefaultRegistry } from "../backend/registry.js";
import type { InstalledModel, InstalledModelSupport } from "../backend/installed.js";
import { detectHardware } from "../hardware/detect.js";
import { usableMemoryBytes, usableMemoryKind } from "../hardware/memory-math.js";
import { HEADROOM } from "../ranking/weights.js";
import { ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { HardwareProfile } from "../types.js";
import { parseContextTokens } from "./recommend.js";

export interface InstalledModelSizing extends InstalledModel {
  readonly context: number | null;
  readonly fit: "yes" | "no" | "unknown";
  readonly weightsFit: boolean;
  readonly requiredBytes: number | null;
  readonly usableBytes: number;
  readonly memoryKind: "ram" | "vram";
  readonly evidence: "local-runtime-metadata";
  readonly throughput: "unknown";
}

export function sizeInstalledModel(
  model: InstalledModel,
  hardware: HardwareProfile,
  context?: number,
): InstalledModelSizing {
  if (context !== undefined) parseContextTokens(String(context));
  const usableBytes = usableMemoryBytes(hardware) * (1 - HEADROOM);
  const weightsFit = model.sizeBytes <= usableBytes;
  const requiredBytes =
    context !== undefined && model.kvBytesPerToken !== null
      ? model.sizeBytes + model.kvBytesPerToken * context
      : null;
  const overCap =
    context !== undefined && model.contextLength !== null && context > model.contextLength;
  return {
    ...model,
    context: context ?? null,
    weightsFit,
    requiredBytes,
    usableBytes,
    memoryKind: usableMemoryKind(hardware),
    evidence: "local-runtime-metadata",
    throughput: "unknown",
    fit:
      overCap || !weightsFit || (requiredBytes !== null && requiredBytes > usableBytes)
        ? "no"
        : requiredBytes === null
          ? "unknown"
          : "yes",
  };
}

export interface InstalledModelsOptions {
  readonly model?: string | undefined;
  readonly context?: number | undefined;
  readonly port?: number | undefined;
  readonly fitsOnly?: boolean | undefined;
  readonly json?: boolean | undefined;
}

export interface InstalledModelsDeps {
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly support: InstalledModelSupport;
}

export async function collectInstalledModels(
  options: InstalledModelsOptions = {},
  deps?: InstalledModelsDeps,
): Promise<readonly InstalledModelSizing[]> {
  if (options.context !== undefined) parseContextTokens(String(options.context));
  const endpoint = buildEndpoint(DEFAULT_BIND_HOST, options.port ?? 11434);
  const support = deps?.support ?? createDefaultRegistry().get("ollama").installedModels;
  if (support === undefined)
    throw new ValidationError("installed model discovery is not supported");
  const hardware = await (deps?.detectHardware ?? detectHardware)();
  const models =
    options.model !== undefined
      ? [await support.inspect(endpoint, options.model)]
      : await support.list(endpoint);
  const result: InstalledModelSizing[] = [];
  for (const entry of models) {
    const model = options.model !== undefined ? entry : await support.inspect(endpoint, entry.id);
    const sized = sizeInstalledModel(model, hardware, options.context);
    if (options.fitsOnly !== true || sized.fit === "yes") result.push(sized);
  }
  return result;
}

export async function runInstalledModels(
  options: InstalledModelsOptions,
): Promise<readonly InstalledModelSizing[]> {
  const result = await collectInstalledModels(options);
  const text =
    options.json === true
      ? JSON.stringify({ source: "local-runtime-metadata", models: result }, null, 2)
      : result
          .map(
            (model) =>
              `${stripControl(model.id)}: context ${model.context ?? "default"}; estimated ${model.memoryKind} fit ${model.fit}; weights ${(model.sizeBytes / 1024 ** 3).toFixed(2)} GiB (${model.weightsFit ? "fit" : "over budget"}); throughput unknown`,
          )
          .join("\n") || "No installed models match.";
  process.stdout.write(`${text}\n`);
  return result;
}
