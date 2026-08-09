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

export type DownResult =
  | { readonly type: "no-active" }
  | { readonly type: "stopped"; readonly modelId: string; readonly endpoint: string }
  | { readonly type: "detached"; readonly modelId: string; readonly endpoint: string };

export interface DownExecutionEvent {
  readonly phase: "locked-revalidate" | "state-clear" | "stop-detach" | "rollback";
  readonly status: "started" | "completed";
  readonly label: string;
}

export type DownExecutionObserver = (event: DownExecutionEvent) => void;

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

/** Execute only the exact state/process target represented by `prepared`. */
export async function executePreparedDown(
  prepared: DownPrepared,
  deps: DownDeps = createDefaultDeps(),
  observe: DownExecutionObserver = () => undefined,
): Promise<DownResult> {
  const notify = (event: DownExecutionEvent): void => {
    try {
      observe(event);
    } catch {
      // Presentation progress is advisory and cannot affect domain execution.
    }
  };
  return deps.withLock(deps.config, async () => {
    notify({ phase: "locked-revalidate", status: "started", label: "Revalidate active server" });
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
    notify({ phase: "locked-revalidate", status: "completed", label: "Active server revalidated" });
    if (active === null) {
      return { type: "no-active" };
    }

    if (active.ownedByUs) {
      const adapter = (
        await select({ intent: "attach", registry: deps.registry, activeBackend: active.backend })
      ).adapter;
      const previousState: RuntimeState = { ...createEmptyState(), active };
      if (currentProcessIdentity === null) {
        throw new ValidationError("owned runtime process identity is unavailable");
      }

      // Clear first so a successful stop cannot strand an owned pid in state.
      notify({ phase: "state-clear", status: "started", label: "Clear active server state" });
      deps.writeState(deps.config, createEmptyState());
      notify({ phase: "state-clear", status: "completed", label: "Active server state cleared" });
      try {
        notify({ phase: "stop-detach", status: "started", label: "Stop verified owned process" });
        await adapter.stop({
          endpoint: active.endpoint,
          pid: active.pid,
          port: active.port,
          ownedByUs: true,
          processExecutable: currentProcessIdentity.expectedProcess.executable,
          processStartedAt: currentProcessIdentity.expectedProcess.started,
        });
        notify({ phase: "stop-detach", status: "completed", label: "Owned process stopped" });
      } catch (error) {
        notify({ phase: "rollback", status: "started", label: "Restore active server state" });
        deps.writeState(deps.config, previousState);
        notify({ phase: "rollback", status: "completed", label: "Active server state restored" });
        throw error;
      }

      return { type: "stopped", modelId: active.modelId, endpoint: active.endpoint };
    }

    // Attached daemon: not ours to stop. Forget it but leave it running.
    notify({ phase: "state-clear", status: "started", label: "Forget attached runtime state" });
    deps.writeState(deps.config, createEmptyState());
    notify({ phase: "state-clear", status: "completed", label: "Attached runtime state forgotten" });
    notify({ phase: "stop-detach", status: "completed", label: "Runtime left running" });
    return { type: "detached", modelId: active.modelId, endpoint: active.endpoint };
  });
}

/** Preserve the authoritative plain output contract for a typed down result. */
export function formatDownResult(result: DownResult): string {
  if (result.type === "no-active") return "No active server to stop.\n";
  const label = stripControl(result.modelId);
  const endpoint = stripControl(result.endpoint);
  return result.type === "stopped"
    ? `Stopped ${label} (${endpoint}).\n`
    : `Detached from ${label} (${endpoint}); it was not started by local-llmup and is still running.\n`;
}

/** Stop the active server (if we own it) and clear the state record. */
export async function runDown(
  options: DownOptions,
  deps: DownDeps = createDefaultDeps(),
): Promise<void> {
  const prepared = await prepareDownConfirmation(options, deps);
  const result = await executePreparedDown(prepared, deps);
  deps.write(formatDownResult(result));
}
