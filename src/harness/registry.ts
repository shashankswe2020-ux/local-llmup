/** Data structure and construction helpers for chat harnesses. */
import { createDefaultRegistry as createDefaultBackendRegistry } from "../backend/registry.js";
import { select } from "../backend/select.js";
import { loadConfig } from "../config.js";
import { ValidationError } from "../errors.js";
import { readState } from "../state/state.js";
import { createClaudeHarness } from "./claude.js";
import { createLocalHarness } from "./local.js";
import { createOpenAICompatibleHarness } from "./openai-compatible.js";
import { createOpenAIHarness } from "./openai.js";
import type { ChatHarness } from "./adapter.js";

/** A read-only lookup over the registered chat harnesses. */
export interface HarnessRegistry {
  /** All registered harnesses in registration order. */
  all(): readonly ChatHarness[];
  /** Resolve a harness by name; throws {@link ValidationError} if unknown. */
  get(name: string): ChatHarness;
  /** The subset of harnesses currently available in this runtime. */
  available(): Promise<readonly ChatHarness[]>;
}

/**
 * Build a registry over an explicit harness list. Registration order is the
 * stable order reported by `all()` and `available()`.
 */
export function createRegistry(harnesses: readonly ChatHarness[]): HarnessRegistry {
  const order: readonly ChatHarness[] = Object.freeze([...harnesses]);
  const byName = new Map<string, ChatHarness>();

  for (const harness of order) {
    if (byName.has(harness.name)) {
      throw new ValidationError(`duplicate harness: ${harness.name}`);
    }
    byName.set(harness.name, harness);
  }

  return {
    all(): readonly ChatHarness[] {
      return order;
    },
    get(name: string): ChatHarness {
      const harness = byName.get(name);
      if (harness === undefined) {
        const known = order.map((entry) => entry.name).join(", ");
        throw new ValidationError(`unknown harness: ${name} (known: ${known})`);
      }
      return harness;
    },
    async available(): Promise<readonly ChatHarness[]> {
      const probes = await Promise.all(
        order.map(async (harness) => {
          try {
            return { harness, available: await harness.isAvailable() };
          } catch {
            return { harness, available: false };
          }
        }),
      );
      return probes.filter((probe) => probe.available).map((probe) => probe.harness);
    },
  };
}

/** Build the production harness registry with the canonical built-ins. */
export function createDefaultRegistry(): HarnessRegistry {
  return createRegistry([
    createLocalHarness({
      config: loadConfig(),
      readState,
      registry: createDefaultBackendRegistry(),
      select,
    }),
    createClaudeHarness(),
    createOpenAIHarness(),
    createOpenAICompatibleHarness(),
  ]);
}
