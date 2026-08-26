/** Local harness: bridge chat requests to the currently active local backend. */
import type { BackendAdapter, ChatMessage } from "../backend/adapter.js";
import type { BackendRegistry } from "../backend/registry.js";
import { ValidationError } from "../errors.js";
import type { Config } from "../config.js";
import type { RuntimeState } from "../state/state.js";
import type { BackendName } from "../types.js";
import type { ChatHarness, HarnessChatRequest, HarnessMessage } from "./adapter.js";

export interface LocalHarnessDeps {
  readonly config: Config;
  readonly readState: (config: Config) => RuntimeState;
  readonly registry: BackendRegistry;
  readonly select: (input: {
    readonly intent: "attach";
    readonly registry: BackendRegistry;
    readonly activeBackend: BackendName | undefined;
    readonly flag?: string | undefined;
    readonly envBackend?: string | undefined;
  }) => Promise<{ readonly adapter: BackendAdapter }>;
}

function normalizeMessages(messages: readonly HarnessMessage[]): readonly ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function buildExpectedProcess(active: NonNullable<RuntimeState["active"]>):
  | { readonly pid: number; readonly executable: string; readonly started: string }
  | undefined {
  if (!active.ownedByUs) return undefined;
  if (
    active.pid === undefined ||
    active.processExecutable === undefined ||
    active.processStartedAt === undefined
  ) {
    return undefined;
  }
  return {
    pid: active.pid,
    executable: active.processExecutable,
    started: active.processStartedAt,
  };
}

export function createLocalHarness(deps: LocalHarnessDeps): ChatHarness {
  return {
    name: "local",
    unavailableHint: "no active server. Run `local-llmup up <model>` first.",
    async isAvailable(): Promise<boolean> {
      return deps.readState(deps.config).active !== null;
    },
    async *chat(request: HarnessChatRequest): AsyncIterable<string> {
      const result = await this.chatSync(request);
      yield result;
    },
    async chatSync(request: HarnessChatRequest): Promise<string> {
      const active = deps.readState(deps.config).active;
      if (active === null) {
        throw new ValidationError("no active server. Run `local-llmup up <model>` first.");
      }

      const selected = await deps.select({
        intent: "attach",
        registry: deps.registry,
        activeBackend: active.backend,
      });
      const expectedProcess = buildExpectedProcess(active);
      const result = await selected.adapter.chat({
        endpoint: active.endpoint,
        model: request.model,
        messages: normalizeMessages(request.messages),
        ...(active.ownedByUs && active.authToken !== undefined ? { authToken: active.authToken } : {}),
        ...(active.modelPath !== undefined ? { expectedModelPath: active.modelPath } : {}),
        ...(expectedProcess !== undefined ? { expectedProcess } : {}),
      });
      return result.content;
    },
  };
}
