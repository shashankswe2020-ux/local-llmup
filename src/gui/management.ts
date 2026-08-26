/**
 * GUI model-management bridge. Wraps the `recommend`, `up`, and `ls` command
 * layers behind a small, injectable interface so the browser workspace can list
 * recommended models, bring one online, and report the active server — all
 * routed through the same deterministic `local-llmup` internals the CLI uses.
 */
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { collectLs, type LsResult } from "../commands/ls.js";
import { collectRecommendation, type RecommendationResult } from "../commands/recommend.js";
import { runUp, type UpOptions } from "../commands/up.js";
import type { Runnable } from "../types.js";

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
}

/** The management surface the GUI server depends on. */
export interface GuiModelManager {
  /** Ranked, fitting models for this machine (limited to `limit`, default 8). */
  recommended(limit?: number): Promise<readonly ManagedModelSummary[]>;
  /** The active local server, or `null` when nothing is running. */
  active(): ActiveModelSummary | null;
  /** Bring `request.model` online and return the resulting active server. */
  up(request: GuiUpRequest): Promise<ActiveModelSummary>;
}

/** Injectable command-layer side effects, so the manager is testable with fakes. */
export interface ModelManagerDeps {
  readonly collectRecommendation: () => Promise<RecommendationResult>;
  readonly runUp: (options: UpOptions) => Promise<void>;
  readonly collectLs: () => LsResult;
}

const DEFAULT_RECOMMEND_LIMIT = 8;

const GUI_UP_REQUEST_SCHEMA = z
  .object({
    model: z.string().trim().min(1).max(256),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

/** Parse and validate a GUI `up` request. Throws {@link ValidationError}. */
export function parseGuiUpRequest(input: unknown): GuiUpRequest {
  const parsed = GUI_UP_REQUEST_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`invalid up payload: ${parsed.error.issues[0]?.message ?? "bad request"}`);
  }
  return parsed.data.port !== undefined
    ? { model: parsed.data.model, port: parsed.data.port }
    : { model: parsed.data.model };
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
    async recommended(limit = DEFAULT_RECOMMEND_LIMIT): Promise<readonly ManagedModelSummary[]> {
      const result = await deps.collectRecommendation();
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
      }));
    },
    active(): ActiveModelSummary | null {
      return toActiveSummary(deps.collectLs());
    },
    async up(request: GuiUpRequest): Promise<ActiveModelSummary> {
      const options: UpOptions =
        request.port !== undefined ? { model: request.model, port: request.port } : { model: request.model };
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
    collectRecommendation: () => collectRecommendation(),
    runUp: (options) => runUp(options),
    collectLs: () => collectLs(),
  });
}
