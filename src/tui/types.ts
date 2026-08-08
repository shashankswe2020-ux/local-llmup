import type { UiMode } from "./capabilities.js";
import type { TerminalText } from "./sanitize.js";

export type UiDecision<T> =
  | { readonly type: "accepted"; readonly value: T }
  | { readonly type: "cancelled" };

export type UiReviewDecision =
  | { readonly type: "accepted" }
  | { readonly type: "back" }
  | { readonly type: "cancelled" };

declare const SAFE_ACTION_ID_BRAND: unique symbol;
export type SafeActionId = string & { readonly [SAFE_ACTION_ID_BRAND]: true };

export type UiChoiceItem =
  | { readonly actionable: true; readonly id: SafeActionId; readonly display: TerminalText }
  | { readonly actionable: false; readonly display: TerminalText };

export interface UiChoiceRequest<T extends UiChoiceItem> {
  readonly title: TerminalText;
  readonly items: readonly T[];
  readonly initialId: string | null;
  readonly signal: AbortSignal;
}

export interface ReviewViewModel {
  readonly title: TerminalText;
  readonly canonicalTargetIds: readonly string[];
  readonly lines: readonly TerminalText[];
}

export interface UiReviewRequest {
  readonly screen: "up" | "switch" | "down" | "migrate" | "telemetry";
  readonly viewModel: ReviewViewModel;
  readonly signal: AbortSignal;
}

export type DisplayIdentifier =
  | { readonly actionable: true; readonly canonical: string; readonly display: TerminalText }
  | { readonly actionable: false; readonly display: TerminalText };

export interface CommandHandoffViewModel {
  readonly argv: readonly SafeActionId[];
  readonly display: TerminalText;
}

export type ThroughputViewModel =
  | {
      readonly known: true;
      readonly lowTokPerSec: number;
      readonly highTokPerSec: number;
      readonly label: TerminalText;
    }
  | {
      readonly known: false;
      readonly label: TerminalText;
      readonly reason:
        | "no-sourced-performance-profile"
        | "not-evaluated-model-does-not-fit";
    };

export interface RecommendRowViewModel {
  readonly rank: number;
  readonly model: DisplayIdentifier;
  readonly params: TerminalText;
  readonly quant: TerminalText;
  readonly requiredBytes: number;
  readonly verdict: "yes" | "slow";
  readonly throughput: ThroughputViewModel;
  readonly backends: readonly TerminalText[];
  readonly license: TerminalText;
  readonly score: number;
  readonly scores: {
    readonly quality: number;
    readonly fit: number;
    readonly speed: number;
    readonly recency: number;
    readonly capability: number;
  };
  readonly capabilities: readonly TerminalText[];
  readonly contextLength: number;
  readonly contextEvidence: TerminalText;
  readonly throughputBackend: TerminalText;
  readonly throughputEvidence: TerminalText;
}

export interface RecommendViewModel {
  readonly hardware: {
    readonly arch: TerminalText;
    readonly platform: TerminalText;
    readonly totalRamBytes: number;
    readonly freeRamBytes: number;
    readonly usableBytes: number;
    readonly memoryKind: "ram" | "vram";
    readonly freeDiskBytes: number;
    readonly gpu: readonly {
      readonly vendor: TerminalText;
      readonly vramBytes: number;
    }[];
  };
  readonly rows: readonly RecommendRowViewModel[];
  readonly wontFit: readonly {
    readonly model: DisplayIdentifier;
    readonly reason: TerminalText;
  }[];
  readonly command: CommandHandoffViewModel | null;
}

export interface CanRunViewModel {
  readonly model: DisplayIdentifier;
  readonly verdict: "yes" | "slow" | "no";
  readonly quant: TerminalText | null;
  readonly reason: TerminalText | null;
  readonly throughput: ThroughputViewModel;
  readonly backends: readonly TerminalText[];
  readonly throughputBackend: TerminalText;
  readonly requiredBytes: number | null;
  readonly usableBytes: number | null;
  readonly fitEvidence: TerminalText;
  readonly throughputEvidence: TerminalText;
}

export interface DoctorViewModel {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly name: TerminalText;
    readonly status: "ok" | "warn" | "fail";
    readonly detail: TerminalText;
  }[];
  readonly backends: readonly {
    readonly name: TerminalText;
    readonly installed: boolean;
    readonly version: TerminalText | null;
    readonly isDefault: boolean;
    readonly installHint: TerminalText;
  }[];
  readonly score: number | null;
  readonly scoreSub: Readonly<Record<"vram" | "ram" | "compute" | "storage", number>> | null;
  readonly bottleneck: TerminalText | null;
}

export interface CatalogViewModel {
  readonly hardware: {
    readonly arch: TerminalText;
    readonly platform: TerminalText;
    readonly totalRamBytes: number;
    readonly freeRamBytes: number;
    readonly usableBytes: number;
    readonly memoryKind: "ram" | "vram";
    readonly freeDiskBytes: number;
    readonly gpu: readonly {
      readonly vendor: TerminalText;
      readonly vramBytes: number;
    }[];
  };
  readonly filter: "fits" | "all";
  readonly total: number;
  readonly rows: readonly {
    readonly model: DisplayIdentifier;
    readonly params: TerminalText;
    readonly architecture: TerminalText;
    readonly quant: TerminalText;
    readonly requiredBytes: number;
    readonly fit: "fit" | "ram-bound" | "vram-bound" | "disk-bound" | "context-bound";
    readonly releaseDate: TerminalText;
    readonly family: TerminalText;
    readonly activeParams: TerminalText | null;
    readonly openWeight: boolean;
    readonly capabilities: readonly TerminalText[];
    readonly license: TerminalText;
    readonly contextLength: number;
    readonly kvBytesPerToken: number | null;
    readonly benchmarkProxy: number | null;
    readonly sources: readonly CatalogSourceViewModel[];
    readonly supportedBackends: readonly TerminalText[];
    readonly quantizations: readonly {
      readonly name: TerminalText;
      readonly diskBytes: number;
      readonly minRamBytes: number;
      readonly minVramBytes: number;
      readonly sha256: TerminalText | null;
      readonly digestVerified: boolean | null;
    }[];
  }[];
  readonly refresh: {
    readonly added: readonly TerminalText[];
    readonly updated: readonly TerminalText[];
    readonly removed: readonly TerminalText[];
    readonly skipped: readonly TerminalText[];
    readonly capped: readonly TerminalText[];
  } | null;
  readonly emptyReason: TerminalText | null;
}

export type CatalogSourceViewModel =
  | { readonly type: "ollama"; readonly id: TerminalText }
  | { readonly type: "hf"; readonly repo: TerminalText }
  | {
      readonly type: "gguf";
      readonly repo: TerminalText;
      readonly revision: TerminalText;
      readonly file: TerminalText;
      readonly sha256: TerminalText;
    }
  | {
      readonly type: "mlx";
      readonly repo: TerminalText;
      readonly revision: TerminalText;
      readonly files: readonly {
        readonly file: TerminalText;
        readonly sha256: TerminalText;
        readonly bytes: number;
      }[];
    };

export type LsViewModel =
  | { readonly type: "empty"; readonly nextCommand: TerminalText }
  | {
      readonly type: "active";
      readonly model: DisplayIdentifier;
      readonly backend: TerminalText;
      readonly endpoint: TerminalText;
      readonly port: number;
      readonly ownership: "owned" | "attached";
    };

export interface CommandViewModelMap {
  readonly recommend: RecommendViewModel;
  readonly canRun: CanRunViewModel;
  readonly doctor: DoctorViewModel;
  readonly catalog: CatalogViewModel;
  readonly ls: LsViewModel;
}

export type UiPhase =
  | "read-only"
  | "resolve"
  | "preflight"
  | "select-backend"
  | "acquire"
  | "verify"
  | "prior-cleanup"
  | "serve"
  | "readiness"
  | "state-commit"
  | "prepare"
  | "review"
  | "locked-revalidate"
  | "state-clear"
  | "stop-detach"
  | "rollback"
  | "load"
  | "plan"
  | "summarize-embed"
  | "stage"
  | "commit"
  | "optional-source-delete"
  | "read-draft"
  | "request"
  | "display"
  | "memory-capture";

export type UiErrorCode =
  | "validation"
  | "backend"
  | "integrity"
  | "timeout"
  | "cancelled"
  | "state-race"
  | "filesystem"
  | "render"
  | "unknown";

export type UiProgressEvent =
  | { readonly type: "phase_started"; readonly phase: UiPhase; readonly label: TerminalText }
  | {
      readonly type: "progress";
      readonly phase: UiPhase;
      readonly completed: number;
      readonly total: number | null;
      readonly unit: "bytes" | "items";
    }
  | {
      readonly type: "message";
      readonly phase: UiPhase;
      readonly level: "info" | "warn";
      readonly text: TerminalText;
    }
  | { readonly type: "phase_completed"; readonly phase: UiPhase; readonly detail?: TerminalText }
  | {
      readonly type: "phase_failed";
      readonly phase: UiPhase;
      readonly code: UiErrorCode;
      readonly detail: TerminalText;
    };

export type UiProgressInputEvent =
  | { readonly type: "phase_started"; readonly phase: UiPhase; readonly label: string }
  | {
      readonly type: "progress";
      readonly phase: UiPhase;
      readonly completed: number;
      readonly total: number | null;
      readonly unit: "bytes" | "items";
    }
  | {
      readonly type: "message";
      readonly phase: UiPhase;
      readonly level: "info" | "warn";
      readonly text: string;
    }
  | { readonly type: "phase_completed"; readonly phase: UiPhase; readonly detail?: string }
  | {
      readonly type: "phase_failed";
      readonly phase: UiPhase;
      readonly code: UiErrorCode;
      readonly detail: string;
    };

export interface UiErrorViewModel {
  readonly code: UiErrorCode;
  readonly message: TerminalText;
}

export interface UiDriver {
  readonly mode: UiMode;
  choose<T extends UiChoiceItem>(
    request: UiChoiceRequest<T>,
  ): Promise<UiDecision<{ readonly id: SafeActionId }>>;
  review(request: UiReviewRequest): Promise<UiReviewDecision>;
  readonly emit: (event: UiProgressEvent) => void;
  complete<K extends keyof CommandViewModelMap>(
    screen: K,
    viewModel: CommandViewModelMap[K],
  ): Promise<void>;
  fail(error: UiErrorViewModel): Promise<void>;
}

export interface UiControllerDriver {
  readonly mode: UiMode;
  choose<T extends UiChoiceItem>(
    request: UiChoiceRequest<T>,
  ): Promise<UiDecision<{ readonly id: SafeActionId }>>;
  review(request: UiReviewRequest): Promise<UiReviewDecision>;
}

export interface ExecutionContext {
  readonly signal: AbortSignal;
  readonly emit: (event: UiProgressInputEvent) => void;
}

export interface InteractiveCommandController<Options, Intent, Prepared, Result> {
  resolveIntent(
    options: Options,
    ui: UiControllerDriver,
    context: ExecutionContext,
  ): Promise<UiDecision<Intent>>;
  prepare(intent: Intent, context: ExecutionContext): Promise<Prepared>;
  review(
    prepared: Prepared,
    ui: UiControllerDriver,
    context: ExecutionContext,
  ): Promise<UiReviewDecision>;
  execute(prepared: Prepared, context: ExecutionContext): Promise<Result>;
}
