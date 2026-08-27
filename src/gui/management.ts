/**
 * GUI model-management bridge. Wraps the `recommend`, `up`, and `ls` command
 * layers behind a small, injectable interface so the browser workspace can list
 * recommended models, bring one online, and report the active server — all
 * routed through the same deterministic `local-llmup` internals the CLI uses.
 */
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { collectLs, type LsResult } from "../commands/ls.js";
import {
  collectRecommendation,
  type RecommendationResult,
  type RecommendOptions,
} from "../commands/recommend.js";
import { runUp, type UpOptions } from "../commands/up.js";
import { BACKEND_NAMES, type BackendName, type Runnable } from "../types.js";

/** A compact, UI-facing view of one recommended model. */
export interface ManagedModelSummary {
  readonly id: string;
  readonly family: string;
  readonly params: string;
  readonly verdict: Runnable;
  readonly quant: string;
  readonly diskBytes: number;
  readonly throughput: {
    readonly known: boolean;
    readonly lowTokPerSec: number;
    readonly highTokPerSec: number;
  };
  readonly backends: readonly string[];
  readonly contextTokens?: number;
  /** False when attention geometry is unknown and context fit could not be measured. */
  readonly contextFitKnown?: boolean;
}

/** A compact, UI-facing view of the active local server. */
export interface ActiveModelSummary {
  readonly modelId: string;
  readonly backend: string;
  readonly endpoint: string;
  readonly port: number;
  readonly ownership: "owned" | "attached";
}

/** A validated request to bring a model online from the GUI. */
export interface GuiUpRequest {
  readonly model: string;
  readonly port?: number;
  /** Force a specific backend; omitted → auto-detect the first servable one. */
  readonly backend?: BackendName;
}

/** Options for scoping a recommendation query from the GUI. */
export interface RecommendedOptions {
  /** Cap the number of returned models (default 8). */
  readonly limit?: number;
  /** Scope the throughput estimate to this inference runtime (default `ollama`). */
  readonly runtime?: BackendName;
  /** Model-relative context window used for fit and ranking. */
  readonly contextPreset?: ContextWindowPreset;
}

export const CONTEXT_WINDOW_PRESETS = ["low", "mid", "high", "max"] as const;
export type ContextWindowPreset = (typeof CONTEXT_WINDOW_PRESETS)[number];

const CONTEXT_WINDOW_PERCENT: Readonly<Record<ContextWindowPreset, 25 | 50 | 75 | 100>> = {
  low: 25,
  mid: 50,
  high: 75,
  max: 100,
};

const CONTEXT_WINDOW_PRESET_SCHEMA = z.enum(CONTEXT_WINDOW_PRESETS);

/** Parse an optional model-relative context preset from the GUI query string. */
export function parseContextWindowPreset(raw: string | null): ContextWindowPreset | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const parsed = CONTEXT_WINDOW_PRESET_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `unknown context preset: ${raw.slice(0, 40)} (known: ${CONTEXT_WINDOW_PRESETS.join(", ")})`,
    );
  }
  return parsed.data;
}

/** The management surface the GUI server depends on. */
export interface GuiModelManager {
  /** Ranked, fitting models for this machine, scoped to an optional runtime. */
  recommended(options?: RecommendedOptions): Promise<readonly ManagedModelSummary[]>;
  /** The inference runtimes the advisor can score throughput for. */
  runtimes(): readonly BackendName[];
  /** The active local server, or `null` when nothing is running. */
  active(): ActiveModelSummary | null;
  /** Bring `request.model` online and return the resulting active server. */
  up(request: GuiUpRequest): Promise<ActiveModelSummary>;
}

/** Injectable command-layer side effects, so the manager is testable with fakes. */
export interface ModelManagerDeps {
  readonly collectRecommendation: (options?: RecommendOptions) => Promise<RecommendationResult>;
  readonly runUp: (options: UpOptions) => Promise<void>;
  readonly collectLs: () => LsResult;
}

const DEFAULT_RECOMMEND_LIMIT = 8;

const GUI_UP_REQUEST_SCHEMA = z
  .object({
    model: z.string().trim().min(1).max(256),
    port: z.number().int().min(1).max(65535).optional(),
    backend: z.enum(BACKEND_NAMES).optional(),
  })
  .strict();

/** Parse and validate a GUI `up` request. Throws {@link ValidationError}. */
export function parseGuiUpRequest(input: unknown): GuiUpRequest {
  const parsed = GUI_UP_REQUEST_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`invalid up payload: ${parsed.error.issues[0]?.message ?? "bad request"}`);
  }
  const request: GuiUpRequest = { model: parsed.data.model };
  return {
    ...request,
    ...(parsed.data.port !== undefined ? { port: parsed.data.port } : {}),
    ...(parsed.data.backend !== undefined ? { backend: parsed.data.backend } : {}),
  };
}

function toActiveSummary(result: LsResult): ActiveModelSummary | null {
  if (result.type === "empty") {
    return null;
  }
  return {
    modelId: result.modelId,
    backend: result.backend,
    endpoint: result.endpoint,
    port: result.port,
    ownership: result.ownedByUs ? "owned" : "attached",
  };
}

/** Build a model manager over explicit command-layer dependencies. */
export function createModelManager(deps: ModelManagerDeps): GuiModelManager {
  return {
    async recommended(options: RecommendedOptions = {}): Promise<readonly ManagedModelSummary[]> {
      const limit = options.limit ?? DEFAULT_RECOMMEND_LIMIT;
      const recommendOptions: RecommendOptions = {
        ...(options.runtime !== undefined ? { backend: options.runtime } : {}),
        ...(options.contextPreset !== undefined
          ? { contextPercent: CONTEXT_WINDOW_PERCENT[options.contextPreset] }
          : {}),
      };
      const result = await deps.collectRecommendation(recommendOptions);
      return result.entries.slice(0, limit).map((entry) => ({
        id: entry.model.id,
        family: entry.model.family,
        params: entry.model.params,
        verdict: entry.verdict,
        quant: entry.quant.name,
        diskBytes: entry.quant.diskBytes,
        throughput: {
          known: entry.throughput.known,
          lowTokPerSec: entry.throughput.lowTokPerSec,
          highTokPerSec: entry.throughput.highTokPerSec,
        },
        backends: [...entry.backends],
        ...(entry.contextSizing !== undefined ? { contextTokens: entry.contextSizing.tokens } : {}),
        ...(entry.contextSizing !== undefined
          ? { contextFitKnown: entry.contextSizing.kvCacheBytes !== null }
          : {}),
      }));
    },
    runtimes(): readonly BackendName[] {
      return [...BACKEND_NAMES];
    },
    active(): ActiveModelSummary | null {
      return toActiveSummary(deps.collectLs());
    },
    async up(request: GuiUpRequest): Promise<ActiveModelSummary> {
      const options: UpOptions = {
        model: request.model,
        ...(request.port !== undefined ? { port: request.port } : {}),
        ...(request.backend !== undefined ? { backend: request.backend } : {}),
      };
      await deps.runUp(options);
      const active = toActiveSummary(deps.collectLs());
      if (active === null) {
        throw new ValidationError(`model ${request.model} did not become active`);
      }
      return active;
    },
  };
}

/** Build the production model manager wired to the real command internals. */
export function createDefaultModelManager(): GuiModelManager {
  return createModelManager({
    collectRecommendation: (options) => collectRecommendation(options),
    runUp: (options) => runUp(options),
    collectLs: () => collectLs(),
  });
}
