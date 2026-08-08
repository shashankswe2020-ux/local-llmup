import { isSafeModelId } from "../backend/net.js";
import { ValidationError } from "../errors.js";
import { usableMemoryBytes, usableMemoryKind } from "../hardware/memory-math.js";
import { freezeDeep } from "../immutable.js";
import type { CanRunResult } from "../commands/can-run.js";
import type { CatalogResult } from "../commands/catalog.js";
import type { DoctorReport } from "../commands/doctor.js";
import type { LsResult } from "../commands/ls.js";
import type { RecommendationResult } from "../commands/recommend.js";
import {
  sanitizeActionIdentifier,
  sanitizeTerminalText,
  type TerminalText,
} from "./sanitize.js";
import type {
  CanRunViewModel,
  CatalogViewModel,
  DisplayIdentifier,
  DoctorViewModel,
  LsViewModel,
  RecommendViewModel,
  SafeActionId,
  ThroughputViewModel,
  CatalogSourceViewModel,
} from "./types.js";
import type { Bottleneck, ThroughputEstimate } from "../types.js";

const MAX_VIEW_MODEL_ITEMS = 1_000;
const MAX_VIEW_MODEL_INPUT_NODES = 100_000;

function assertCollectionLimit(value: readonly unknown[], label: string): void {
  if (value.length > MAX_VIEW_MODEL_ITEMS) {
    throw new ValidationError(`${label} limit exceeded`);
  }
}

function assertBoundedInput(value: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown): void => {
    nodes += 1;
    if (nodes > MAX_VIEW_MODEL_INPUT_NODES) {
      throw new ValidationError("view-model input node limit exceeded");
    }
    if (typeof current !== "object" || current === null) return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      assertCollectionLimit(current, "view-model collection");
      for (const child of current) visit(child);
      return;
    }
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
}

function line(value: string): TerminalText {
  return sanitizeTerminalText(value, "single_line");
}

function identifier(canonical: string): DisplayIdentifier {
  const sanitized = sanitizeActionIdentifier(
    canonical,
    (value) => isSafeModelId(value) && !value.split("/").includes(".."),
  );
  return sanitized.actionable
    ? { actionable: true, canonical: sanitized.canonical, display: sanitized.display }
    : { actionable: false, display: sanitized.display };
}

function throughput(
  value: ThroughputEstimate,
  reason: "no-sourced-performance-profile" | "not-evaluated-model-does-not-fit" =
    "no-sourced-performance-profile",
): ThroughputViewModel {
  if (!value.known) return { known: false, label: line("unknown"), reason };
  return {
    known: true,
    lowTokPerSec: value.lowTokPerSec,
    highTokPerSec: value.highTokPerSec,
    label: line(`${String(value.lowTokPerSec)}–${String(value.highTokPerSec)} tok/s`),
  };
}

function bottleneckLabel(value: Bottleneck): TerminalText {
  const labels: Readonly<Record<Bottleneck, string>> = {
    vram: "VRAM",
    ram: "RAM",
    compute: "Compute",
    storage: "Storage",
  };
  return line(labels[value]);
}

function fittingVerdict(value: "yes" | "slow" | "no"): "yes" | "slow" {
  if (value === "no") {
    throw new ValidationError("ranked recommendation entry cannot have a no verdict");
  }
  return value;
}

function recommendationContextEvidence(
  entry: RecommendationResult["entries"][number],
): TerminalText {
  if (entry.contextSizing !== undefined) {
    const kv =
      entry.contextSizing.kvCacheBytes === null
        ? "KV cache unknown"
        : `KV cache ${String(entry.contextSizing.kvCacheBytes)} bytes`;
    return line(
      `${String(entry.contextSizing.tokens)} tokens; weights ${String(entry.contextSizing.weightsBytes)} bytes; ${kv}`,
    );
  }
  if (entry.maxContext !== undefined) {
    return line(
      entry.maxContext.tokens === null
        ? "maximum context unknown"
        : `maximum context ${String(entry.maxContext.tokens)} tokens; bound by ${entry.maxContext.boundBy}`,
    );
  }
  return line("default context footprint");
}

function sourceViewModels(
  model: CatalogResult["rows"][number]["model"],
): CatalogSourceViewModel[] {
  const sources: CatalogSourceViewModel[] = [];
  if (model.source.ollama !== undefined) {
    sources.push({ type: "ollama", id: line(model.source.ollama) });
  }
  if (model.source.hf !== undefined) {
    sources.push({ type: "hf", repo: line(model.source.hf) });
  }
  if (model.source.gguf !== undefined) {
    sources.push({
      type: "gguf",
      repo: line(model.source.gguf.repo),
      revision: line(model.source.gguf.revision),
      file: line(model.source.gguf.file),
      sha256: line(model.source.gguf.sha256),
    });
  }
  if (model.source.mlx !== undefined) {
    sources.push({
      type: "mlx",
      repo: line(model.source.mlx.repo),
      revision: line(model.source.mlx.revision),
      files: model.source.mlx.files.map((file) => ({
        file: line(file.file),
        sha256: line(file.sha256),
        bytes: file.bytes,
      })),
    });
  }
  return sources;
}

export function buildRecommendViewModel(result: RecommendationResult): RecommendViewModel {
  assertCollectionLimit(result.entries, "recommendation row");
  assertCollectionLimit(result.wontFit, "non-fitting recommendation row");
  assertBoundedInput(result);
  return freezeDeep({
    hardware: {
      arch: line(result.hardware.arch),
      platform: line(result.hardware.platform),
      totalRamBytes: result.hardware.totalRamBytes,
      freeRamBytes: result.hardware.freeRamBytes,
      usableBytes: result.usableBytes,
      memoryKind: result.memoryKind,
      freeDiskBytes: result.hardware.freeDiskBytes,
      gpu: result.hardware.gpu.map((gpu) => ({
        vendor: line(gpu.vendor),
        vramBytes: gpu.vramBytes,
      })),
    },
    rows: result.entries.map((entry) => ({
      rank: entry.rank,
      model: identifier(entry.model.id),
      params: line(entry.model.params),
      quant: line(entry.quant.name),
      requiredBytes: entry.requiredBytes,
      verdict: fittingVerdict(entry.verdict),
      throughput: throughput(
        entry.throughput,
        entry.throughputEvidence.unknownReason ?? "no-sourced-performance-profile",
      ),
      backends: entry.backends.map(line),
      license: line(entry.model.license),
      score: entry.score,
      scores: { ...entry.scores },
      capabilities: entry.model.capabilities.map(line),
      contextLength: entry.model.contextLength,
      contextEvidence: recommendationContextEvidence(entry),
      throughputBackend: line(entry.throughputEvidence.backend),
      throughputEvidence: line(
        entry.throughputEvidence.unknownReason === null
          ? entry.throughputEvidence.source
          : `${entry.throughputEvidence.source}; ${entry.throughputEvidence.unknownReason}`,
      ),
    })),
    wontFit: result.wontFit.map((entry) => ({
      model: identifier(entry.model.id),
      reason: line(entry.reason),
    })),
    command: (() => {
      const top = result.entries[0];
      if (top === undefined) return null;
      const model = identifier(top.model.id);
      if (!model.actionable) return null;
      const argv = [
        "local-llmup" as SafeActionId,
        "up" as SafeActionId,
        model.canonical as SafeActionId,
      ] as const;
      return { argv, display: line(argv.join(" ")) };
    })(),
  });
}

export function buildCanRunViewModel(result: CanRunResult): CanRunViewModel {
  assertBoundedInput(result);
  return freezeDeep({
    model: identifier(result.modelId),
    verdict: result.runnable,
    quant: result.quant === null ? null : line(result.quant),
    reason: result.reason === null ? null : line(result.reason),
    throughput: throughput(
      result.throughput,
      result.runnable === "no"
        ? "not-evaluated-model-does-not-fit"
        : (result.throughputEvidence.unknownReason ?? "no-sourced-performance-profile"),
    ),
    backends: result.backends.map(line),
    throughputBackend: line(result.throughputBackend),
    requiredBytes: result.requiredBytes,
    usableBytes: result.usableBytes,
    fitEvidence: line(
      result.requiredBytes === null
        ? `does not fit: ${result.reason ?? "unknown"}`
        : `${String(result.requiredBytes)} of ${String(result.usableBytes)} usable bytes`,
    ),
    throughputEvidence: line(
      result.throughputEvidence.unknownReason === null
        ? result.throughputEvidence.source
        : `${result.throughputEvidence.source}; ${result.throughputEvidence.unknownReason}`,
    ),
  });
}

export function buildDoctorViewModel(result: DoctorReport): DoctorViewModel {
  assertCollectionLimit(result.checks, "doctor check");
  assertCollectionLimit(result.backends, "doctor backend");
  assertBoundedInput(result);
  return freezeDeep({
    ok: result.ok,
    checks: result.checks.map((check) => ({
      name: line(check.name),
      status: check.status,
      detail: line(check.detail),
    })),
    backends: result.backends.map((backend) => ({
      name: line(backend.name),
      installed: backend.installed,
      version: backend.version === null ? null : line(backend.version),
      isDefault: backend.isDefault,
      installHint: line(backend.installHint),
    })),
    score: result.hardwareScore?.total ?? null,
    scoreSub: result.hardwareScore === null ? null : { ...result.hardwareScore.sub },
    bottleneck:
      result.hardwareScore === null ? null : bottleneckLabel(result.hardwareScore.bottleneck),
  });
}

export function buildCatalogViewModel(result: CatalogResult): CatalogViewModel {
  assertCollectionLimit(result.rows, "catalog row");
  assertBoundedInput(result);
  return freezeDeep({
    hardware: {
      arch: line(result.hardware.arch),
      platform: line(result.hardware.platform),
      totalRamBytes: result.hardware.totalRamBytes,
      freeRamBytes: result.hardware.freeRamBytes,
      usableBytes: usableMemoryBytes(result.hardware),
      memoryKind: usableMemoryKind(result.hardware),
      freeDiskBytes: result.hardware.freeDiskBytes,
      gpu: result.hardware.gpu.map((gpu) => ({
        vendor: line(gpu.vendor),
        vramBytes: gpu.vramBytes,
      })),
    },
    filter: result.filter,
    total: result.total,
    rows: result.rows.map((row) => ({
      model: identifier(row.model.id),
      params: line(row.model.params),
      architecture: line(row.model.architecture),
      quant: line(row.quant.name),
      requiredBytes: row.requiredBytes,
      fit: row.fit,
      releaseDate: line(row.model.releaseDate),
      family: line(row.model.family),
      activeParams: row.model.activeParams === undefined ? null : line(row.model.activeParams),
      openWeight: row.model.openWeight,
      capabilities: row.model.capabilities.map(line),
      license: line(row.model.license),
      contextLength: row.model.contextLength,
      kvBytesPerToken: row.model.kvBytesPerToken ?? null,
      benchmarkProxy: row.model.benchmarkProxy ?? null,
      sources: sourceViewModels(row.model),
      supportedBackends: row.supportedBackends.map(line),
      quantizations: row.model.quantizations.map((entry) => ({
        name: line(entry.name),
        diskBytes: entry.diskBytes,
        minRamBytes: entry.minRamBytes,
        minVramBytes: entry.minVramBytes,
        sha256: entry.sha256 === undefined ? null : line(entry.sha256),
        digestVerified: entry.digestVerified ?? null,
      })),
    })),
    refresh:
      result.refresh === null
        ? null
        : {
            added: result.refresh.added.map(line),
            updated: result.refresh.updated.map(line),
            removed: result.refresh.removed.map(line),
            skipped: result.refresh.skipped.map(line),
            capped: result.refresh.capped.map(line),
          },
    emptyReason: result.emptyReason === null ? null : line(result.emptyReason),
  });
}

export function buildLsViewModel(result: LsResult): LsViewModel {
  assertBoundedInput(result);
  if (result.type === "empty") {
    return freezeDeep({ type: "empty", nextCommand: line("local-llmup up <model>") });
  }
  return freezeDeep({
    type: "active",
    model: identifier(result.modelId),
    backend: line(result.backend),
    endpoint: line(result.endpoint),
    port: result.port,
    ownership: result.ownedByUs ? "owned" : "attached",
  });
}
