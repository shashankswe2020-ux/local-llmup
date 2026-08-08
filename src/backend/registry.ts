/**
 * The backend registry is the single construction site for `BackendAdapter`
 * implementations. Command code receives a {@link BackendRegistry} in its deps
 * and resolves adapters by name (or via `select()`), never calling `new
 * *Adapter()` directly. The default registry includes Ollama, llama.cpp, MLX,
 * and attach-only LM Studio in stable order.
 */
import { ValidationError } from "../errors.js";
import type { BackendAdapter } from "./adapter.js";
import { LlamaCppAdapter } from "./llamacpp.js";
import { MlxAdapter } from "./mlx.js";
import { LmStudioAdapter } from "./lmstudio.js";
import { OllamaAdapter } from "./ollama.js";

/** A read-only lookup over the registered inference backends. */
export interface BackendRegistry {
  /** All registered adapters in registration order (stable snapshot). */
  all(): readonly BackendAdapter[];
  /** Resolve an adapter by name; throws {@link ValidationError} if unknown. */
  get(name: string): BackendAdapter;
  /**
   * The subset of adapters whose backend is installed on this machine, in
   * registration order. Each `isInstalled()` probe is isolated: a probe that
   * throws is treated as "not installed" so one broken backend cannot hide the
   * others.
   */
  available(): Promise<readonly BackendAdapter[]>;
}

/**
 * Build a registry over an explicit adapter list. Registration order is the
 * stable order reported by `all()`/`available()`. Duplicate names are rejected
 * so `get()` is unambiguous.
 */
export function createRegistry(adapters: readonly BackendAdapter[]): BackendRegistry {
  const order: readonly BackendAdapter[] = Object.freeze([...adapters]);
  const byName = new Map<string, BackendAdapter>();
  for (const adapter of order) {
    if (byName.has(adapter.name)) {
      throw new ValidationError(`duplicate backend adapter: ${adapter.name}`);
    }
    byName.set(adapter.name, adapter);
  }

  return {
    all(): readonly BackendAdapter[] {
      return order;
    },
    get(name: string): BackendAdapter {
      const adapter = byName.get(name);
      if (adapter === undefined) {
        const known = order.map((a) => a.name).join(", ");
        throw new ValidationError(`unknown backend: ${name} (known: ${known})`);
      }
      return adapter;
    },
    async available(): Promise<readonly BackendAdapter[]> {
      const probes = await Promise.all(
        order.map(async (adapter) => {
          try {
            return { adapter, installed: await adapter.isInstalled() };
          } catch {
            return { adapter, installed: false };
          }
        }),
      );
      return probes.filter((p) => p.installed).map((p) => p.adapter);
    },
  };
}

/** Build the production registry in stable fallback order. */
export function createDefaultRegistry(): BackendRegistry {
  return createRegistry([
    new OllamaAdapter(),
    new LlamaCppAdapter(),
    new MlxAdapter(),
    new LmStudioAdapter(),
  ]);
}
