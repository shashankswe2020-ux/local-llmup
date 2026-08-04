/**
 * The `down` command: stop the local server this CLI is tracking. Ollama is a
 * single shared daemon, so `down` only signals a daemon we started ourselves
 * (`ownedByUs`); an attached daemon is left running and we simply forget it.
 * Either way the active-server record is cleared. All mutation happens under the
 * state lock so a concurrent `up`/`switch` cannot race the teardown.
 */
import { loadCatalog } from "../catalog/load.js";
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { resolveModel } from "../resolver.js";
import { stripControl } from "../sanitize.js";
import { OllamaAdapter } from "../backend/ollama.js";
import type { BackendAdapter } from "../backend/adapter.js";
import {
  createEmptyState,
  readState,
  withLock,
  writeState,
  type RuntimeState,
} from "../state/state.js";
import type { Catalog } from "../types.js";

/** Inputs for `down`. An optional model guards against stopping the wrong one. */
export interface DownOptions {
  readonly model?: string | undefined;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface DownDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly readState: (config: Config) => RuntimeState;
  readonly writeState: (config: Config, state: RuntimeState) => void;
  readonly withLock: <T>(config: Config, fn: () => T | Promise<T>) => Promise<T>;
  readonly adapter: BackendAdapter;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
  /** Diagnostics → stderr. */
  readonly log: (text: string) => void;
}

const createDefaultDeps = (): DownDeps => ({
  config: loadConfig(),
  loadCatalog: () => loadCatalog(),
  readState,
  writeState,
  withLock,
  adapter: new OllamaAdapter(),
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
});

/** Stop the active server (if we own it) and clear the state record. */
export async function runDown(
  options: DownOptions,
  deps: DownDeps = createDefaultDeps(),
): Promise<void> {
  await deps.withLock(deps.config, async () => {
    const active = deps.readState(deps.config).active;
    if (active === null) {
      deps.write("No active server to stop.\n");
      return;
    }

    // Guard: a named target must be the model we are actually serving.
    if (options.model !== undefined) {
      const resolved = resolveModel(deps.loadCatalog(), options.model);
      if (resolved.model.id !== active.modelId) {
        throw new ValidationError(
          `${resolved.model.id} is not the active model (${active.modelId})`,
        );
      }
    }

    const label = stripControl(active.modelId);
    const endpoint = stripControl(active.endpoint);

    if (active.ownedByUs) {
      await deps.adapter.stop({
        endpoint: active.endpoint,
        pid: active.pid,
        port: active.port,
        ownedByUs: true,
      });
      deps.writeState(deps.config, createEmptyState());
      deps.write(`Stopped ${label} (${endpoint}).\n`);
      return;
    }

    // Attached daemon: not ours to stop. Forget it but leave it running.
    deps.writeState(deps.config, createEmptyState());
    deps.write(
      `Detached from ${label} (${endpoint}); it was not started by local-llmup and is still running.\n`,
    );
  });
}
