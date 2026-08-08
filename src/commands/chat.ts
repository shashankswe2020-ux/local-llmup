/**
 * The `chat` command: the memory-capture path (spec §3.5). local-llmup sits in
 * the request path as a thin recorder — it forwards each user turn to the active
 * backend's OpenAI-compatible endpoint, streams the reply back, and records the
 * exchange into the model's memory store so `migrate` has something to carry.
 *
 * The active model/endpoint come from `state.json` (or `-m <model>`); the
 * backend model id is the resolved catalog entry's `source.ollama`, while the
 * memory store is keyed on the catalog id. In-session turns accumulate so the
 * model sees prior context; every exchange is passed to `captureExchange`, which
 * owns sanitization and persistence. Backend replies are stripped of control/
 * ANSI bytes before they reach the terminal.
 */
import { createInterface } from "node:readline";
import { loadCatalog } from "../catalog/load.js";
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { resolveModel } from "../resolver.js";
import { stripControl } from "../sanitize.js";
import type { ChatMessage } from "../backend/adapter.js";
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

/**
 * Cap on how many trailing messages are sent to the backend per turn. Chat
 * sessions are unbounded, but the model's context window is not; sending only a
 * recent window keeps requests bounded (and avoids O(n²) full-transcript copies)
 * while the complete history is still recorded to disk by the capture layer.
 */
const MAX_CONTEXT_MESSAGES = 20;

/** Inputs for `chat`. */
export interface ChatOptions {
  /** Model to chat with; defaults to the active served model. */
  readonly model?: string | undefined;
}

/** One recorded exchange handed to the capture layer. */
interface ChatExchange {
  readonly user: string;
  readonly assistant: string;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface ChatDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly readState: (config: Config) => RuntimeState;
  readonly registry: BackendRegistry;
  readonly openMemoryStore: (config: Config, modelId: string) => MemoryStore;
  readonly captureExchange: (
    config: Config,
    store: MemoryStore,
    exchange: ChatExchange,
    options: {
      now?: (() => Date) | undefined;
      embedder?: CaptureEmbedder | undefined;
      embeddingUnsupported?: boolean | undefined;
    },
  ) => Promise<CaptureResult>;
  /** Serializes memory-store writes against other mutating commands. */
  readonly withLock: <T>(config: Config, fn: () => T | Promise<T>) => Promise<T>;
  /** Read the next user turn, or `null` at end of input. */
  readonly readTurn: () => Promise<string | null>;
  /** Command result data (assistant replies) → stdout. */
  readonly write: (text: string) => void;
  /** Prompts and diagnostics → stderr. */
  readonly log: (text: string) => void;
  readonly captureLiveProcessIdentity: (
    active: NonNullable<RuntimeState["active"]>,
  ) => Promise<LiveProcessIdentity>;
  readonly now?: (() => Date) | undefined;
  readonly embedder?: CaptureEmbedder | undefined;
}

/**
 * Build a line reader over stdin that resolves one user turn per call and `null`
 * once input closes. Works for both piped and interactive line input.
 */
function createStdinReader(): () => Promise<string | null> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const pending: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;

  rl.on("line", (line: string) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(line);
    } else {
      waiter(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter(null);
    }
  });

  return () =>
    new Promise<string | null>((resolve) => {
      const next = pending.shift();
      if (next !== undefined) {
        resolve(next);
      } else if (closed) {
        resolve(null);
      } else {
        waiters.push(resolve);
      }
    });
}

const createDefaultDeps = (): ChatDeps => ({
  config: loadConfig(),
  loadCatalog: () => loadCatalog(),
  readState,
  registry: createDefaultRegistry(),
  openMemoryStore,
  captureExchange,
  withLock,
  readTurn: createStdinReader(),
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
  captureLiveProcessIdentity,
});

/**
 * Run an interactive/piped chat session against the active model, recording each
 * exchange into memory. Throws {@link ValidationError} when no server is active
 * or the target model cannot be served.
 */
export async function runChat(
  options: ChatOptions,
  deps: ChatDeps = createDefaultDeps(),
): Promise<void> {
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
  // Best-effort embeddings: a backend that cannot embed captures vector-less
  // rather than fabricating vectors or hard-failing (honesty gate, spec §3.3).
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

  deps.log(
    `Chatting with ${stripControl(modelId)} (${stripControl(active.endpoint)}). ` +
      `End input to exit.\n`,
  );

  const messages: ChatMessage[] = [];
  for (;;) {
    const turn = await deps.readTurn();
    if (turn === null) {
      break;
    }
    if (turn.trim().length === 0) {
      continue;
    }

    messages.push({ role: "user", content: turn });
    const context = messages.slice(-MAX_CONTEXT_MESSAGES);
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

    deps.write(`${stripControl(reply)}\n`);
    messages.push({ role: "assistant", content: reply });

    // Record the exchange under the runtime lock so concurrent chat/migrate
    // sessions cannot race the memory store. A recording failure must not tear
    // down a healthy conversation, so warn and continue.
    try {
      await deps.withLock(deps.config, () =>
        deps.captureExchange(deps.config, store, { user: turn, assistant: reply }, captureOptions),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`chat: failed to record memory: ${stripControl(message)}\n`);
    }
  }
}
