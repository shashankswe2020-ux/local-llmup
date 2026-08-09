/**
 * Interactive chat entry point for TUI/accessible modes.
 *
 * Auto TUI chat emits no assistant transcript to stdout during the session;
 * exit writes one compact session-end summary. `--no-tui` and piped chat
 * preserve the existing assistant-reply stdout transcript byte-for-byte.
 */
import { loadCatalog } from "../catalog/load.js";
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { resolveModel } from "../resolver.js";
import { stripControl } from "../sanitize.js";
import type { ChatMessage as BackendChatMessage } from "../backend/adapter.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { select } from "../backend/select.js";
import { captureExchange, type CaptureEmbedder, type CaptureResult } from "../memory/capture.js";
import { openMemoryStore, type MemoryStore } from "../memory/store.js";
import { readState, withLock, type RuntimeState } from "../state/state.js";
import {
  captureLiveProcessIdentity,
  type LiveProcessIdentity,
} from "../tui/snapshots.js";
import type { Catalog } from "../types.js";
import {
  formatChatSessionSummary,
  formatDraftError,
  isResponseWithinLimits,
  truncateGraphemeSafe,
  validateDraft,
} from "./chat-limits.js";
import type { UiModeSelection } from "./capabilities.js";

const MAX_CONTEXT_MESSAGES = 20;

export type InteractiveChatSelection = UiModeSelection & {
  readonly mode: "tui" | "accessible";
};

export interface InteractiveChatDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly readState: (config: Config) => RuntimeState;
  readonly registry: BackendRegistry;
  readonly openMemoryStore: (config: Config, modelId: string) => MemoryStore;
  readonly captureExchange: (
    config: Config,
    store: MemoryStore,
    exchange: { readonly user: string; readonly assistant: string },
    options: {
      now?: (() => Date) | undefined;
      embedder?: CaptureEmbedder | undefined;
      embeddingUnsupported?: boolean | undefined;
    },
  ) => Promise<CaptureResult>;
  readonly withLock: <T>(config: Config, fn: () => T | Promise<T>) => Promise<T>;
  readonly captureLiveProcessIdentity: (
    active: NonNullable<RuntimeState["active"]>,
  ) => Promise<LiveProcessIdentity>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly readTurn: () => Promise<string | null>;
  readonly now?: (() => Date) | undefined;
  readonly embedder?: CaptureEmbedder | undefined;
}

const createDefaultDeps = (): InteractiveChatDeps => ({
  config: loadConfig(),
  loadCatalog: () => loadCatalog(),
  readState,
  registry: createDefaultRegistry(),
  openMemoryStore,
  captureExchange,
  withLock,
  captureLiveProcessIdentity,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  readTurn: () => Promise.resolve(null),
  now: undefined,
  embedder: undefined,
});

export interface ChatSessionResult {
  readonly turns: number;
  readonly memoryWarnings: number;
}

/**
 * Run an interactive TUI or accessible chat session. Auto TUI emits only a
 * session-end summary to stdout; the assistant-reply transcript goes to the
 * TUI stream (stderr). Accessible mode uses the same approach but with line-
 * oriented I/O.
 */
export async function runInteractiveChat(
  options: { readonly model?: string | undefined },
  mode: InteractiveChatSelection,
  deps: InteractiveChatDeps = createDefaultDeps(),
): Promise<ChatSessionResult> {
  const active = deps.readState(deps.config).active;
  if (active === null) {
    throw new ValidationError("no active server. Run `local-llmup up <model>` first.");
  }
  const liveProcessIdentity = await deps.captureLiveProcessIdentity(active);

  const resolved = resolveModel(deps.loadCatalog(), options.model ?? active.modelId);
  const modelId = resolved.model.id;
  const adapter = (
    await select({ intent: "attach", registry: deps.registry, activeBackend: active.backend })
  ).adapter;
  const singleModelRuntime =
    adapter.capabilities.formats.includes("gguf") || adapter.capabilities.formats.includes("mlx");
  if (singleModelRuntime && modelId !== active.modelId) {
    throw new ValidationError(
      `active ${adapter.name} server is serving ${active.modelId}; run \`local-llmup up ${modelId} --backend ${adapter.name}\` first`,
    );
  }
  const backendModelId = adapter.capabilities.formats.includes("ollama")
    ? resolved.model.source.ollama
    : modelId;
  if (backendModelId === undefined) {
    throw new ValidationError(
      `model ${modelId} has no source that backend ${adapter.name} can chat with`,
    );
  }

  const store = deps.openMemoryStore(deps.config, modelId);
  const canEmbed = adapter.capabilities.canEmbed;
  const captureOptions: {
    now?: (() => Date) | undefined;
    embedder?: CaptureEmbedder | undefined;
    embeddingUnsupported?: boolean | undefined;
  } = {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(canEmbed && deps.embedder !== undefined ? { embedder: deps.embedder } : {}),
    ...(!canEmbed ? { embeddingUnsupported: true } : {}),
  };

  deps.writeStderr(
    `Chatting with ${stripControl(modelId)} (${stripControl(active.endpoint)}). ` +
      `End input to exit.\n`,
  );

  const messages: BackendChatMessage[] = [];
  let turns = 0;
  let memoryWarnings = 0;

  for (;;) {
    const turn = await deps.readTurn();
    if (turn === null) break;
    if (turn.trim().length === 0) continue;

    // Validate draft limits before backend call
    const draftError = validateDraft(turn);
    if (draftError !== null) {
      deps.writeStderr(`chat: ${formatDraftError(draftError)}\n`);
      continue;
    }

    messages.push({ role: "user", content: turn });
    const context = messages.slice(-MAX_CONTEXT_MESSAGES);

    // Show pending state (no fake streaming)
    deps.writeStderr("Waiting for response...\n");

    const result = await adapter.chat({
      endpoint: active.endpoint,
      model: backendModelId,
      messages: context,
      ...(active.ownedByUs && active.authToken !== undefined
        ? { authToken: active.authToken }
        : {}),
      ...(active.modelPath !== undefined ? { expectedModelPath: active.modelPath } : {}),
      expectedProcess: liveProcessIdentity.expectedProcess,
    });
    const reply = result.content;

    // Validate response size before memory capture
    if (!isResponseWithinLimits(reply)) {
      deps.writeStderr(
        "chat: response exceeds 1 MiB limit; skipping memory capture\n",
      );
      memoryWarnings += 1;
      // Still display the reply on TUI stream (grapheme-safe truncation)
      deps.writeStderr(`${stripControl(truncateGraphemeSafe(reply, 2000))}...[truncated]\n`);
      messages.push({ role: "assistant", content: reply });
      turns += 1;
      continue;
    }

    // TUI mode: assistant replies go to TUI stream (stderr), not stdout
    deps.writeStderr(`${stripControl(reply)}\n`);
    messages.push({ role: "assistant", content: reply });
    turns += 1;

    // Record the exchange under the runtime lock
    try {
      await deps.withLock(deps.config, () =>
        deps.captureExchange(
          deps.config,
          store,
          { user: turn, assistant: reply },
          captureOptions,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.writeStderr(`chat: failed to record memory: ${stripControl(message)}\n`);
      memoryWarnings += 1;
    }
  }

  // Auto TUI: emit session-end summary to stdout (not the transcript)
  deps.writeStdout(formatChatSessionSummary(turns, memoryWarnings));
  return { turns, memoryWarnings };
}
