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
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { select } from "../backend/select.js";
import {
  createEmptyState,
  readState,
  withLock,
  writeState,
  type RuntimeState,
} from "../state/state.js";
import type { Catalog } from "../types.js";
import {
  assertConfirmationUnchanged,
  captureLiveProcessIdentity,
  createRuntimeConfirmationSnapshot,
  type LiveProcessIdentity,
  type ConfirmationSnapshot,
} from "../tui/snapshots.js";

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
  readonly registry: BackendRegistry;
  readonly captureLiveProcessIdentity: typeof captureLiveProcessIdentity;
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
  registry: createDefaultRegistry(),
  captureLiveProcessIdentity,
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
});

export interface DownPrepared {
  readonly snapshot: ConfirmationSnapshot;
  readonly processIdentity: LiveProcessIdentity | null;
}

/** Capture the exact state/process target shown by a future confirmation review. */
export async function prepareDownConfirmation(
  options: DownOptions,
  deps: DownDeps = createDefaultDeps(),
): Promise<DownPrepared> {
  const state = deps.readState(deps.config);
  const active = state.active;
  if (active !== null && options.model !== undefined) {
    const resolved = resolveModel(deps.loadCatalog(), options.model);
    if (resolved.model.id !== active.modelId) {
      throw new ValidationError(
        `${resolved.model.id} is not the active model (${active.modelId})`,
      );
    }
  }
  const processIdentity =
    active === null ? null : await deps.captureLiveProcessIdentity(active);
  return Object.freeze({
    snapshot: createRuntimeConfirmationSnapshot({
      operation: active?.ownedByUs === false ? "detach" : "down",
      canonicalTargetIds: active === null ? [] : [active.modelId],
      state,
      processIdentityHash: processIdentity?.hash ?? null,
    }),
    processIdentity,
  });
}

/** Stop the active server (if we own it) and clear the state record. */
export async function runDown(
  options: DownOptions,
  deps: DownDeps = createDefaultDeps(),
): Promise<void> {
  const prepared = await prepareDownConfirmation(options, deps);
  await deps.withLock(deps.config, async () => {
    const currentState = deps.readState(deps.config);
    const active = currentState.active;
    const currentProcessIdentity =
      active === null ? null : await deps.captureLiveProcessIdentity(active);
    const current = createRuntimeConfirmationSnapshot({
      operation: active?.ownedByUs === false ? "detach" : "down",
      canonicalTargetIds: active === null ? [] : [active.modelId],
      state: currentState,
      processIdentityHash: currentProcessIdentity?.hash ?? null,
    });
    assertConfirmationUnchanged(prepared.snapshot, current);
    if (active === null) {
      deps.write("No active server to stop.\n");
      return;
    }

    const label = stripControl(active.modelId);
    const endpoint = stripControl(active.endpoint);

    if (active.ownedByUs) {
      const adapter = (
        await select({ intent: "attach", registry: deps.registry, activeBackend: active.backend })
      ).adapter;
      const previousState: RuntimeState = { ...createEmptyState(), active };
      if (currentProcessIdentity === null) {
        throw new ValidationError("owned runtime process identity is unavailable");
      }

      // Clear first so a successful stop cannot strand an owned pid in state.
      deps.writeState(deps.config, createEmptyState());
      try {
        await adapter.stop({
          endpoint: active.endpoint,
          pid: active.pid,
          port: active.port,
          ownedByUs: true,
          processExecutable: currentProcessIdentity.expectedProcess.executable,
          processStartedAt: currentProcessIdentity.expectedProcess.started,
        });
      } catch (error) {
        deps.writeState(deps.config, previousState);
        throw error;
      }

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
