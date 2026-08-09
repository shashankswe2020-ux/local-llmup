/**
 * The `switch` command: make a different, already-servable model the active one
 * without moving memory. Ollama is a single shared daemon that serves every
 * pulled model on one endpoint, so switching is: ensure the target is pulled and
 * the daemon is healthy, then repoint `state.active.modelId` — the endpoint,
 * pid, port, and ownership are inherited from the running server.
 *
 * The daemon-preparation steps (pull, health) run before the lock; the state is
 * only rewritten once they succeed, so any failure leaves the prior active model
 * exactly as it was. Switching to the model that is already active is a defined
 * no-op.
 */
import { loadCatalog } from "../catalog/load.js";
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { resolveModel } from "../resolver.js";
import { stripControl } from "../sanitize.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import type { BackendAdapter } from "../backend/adapter.js";
import { select } from "../backend/select.js";
import {
  readState,
  withLock,
  writeState,
  STATE_SCHEMA_VERSION,
  type RuntimeState,
} from "../state/state.js";
import type { Catalog } from "../types.js";
import {
  assertConfirmationUnchanged,
  captureLiveProcessIdentity,
  createRuntimeConfirmationSnapshot,
  type ConfirmationSnapshot,
} from "../tui/snapshots.js";

/** Inputs for `switch`. */
export interface SwitchOptions {
  readonly model: string;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface SwitchDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly readState: (config: Config) => RuntimeState;
  readonly writeState: (config: Config, state: RuntimeState) => void;
  readonly withLock: <T>(config: Config, fn: () => T | Promise<T>) => Promise<T>;
  readonly captureLiveProcessIdentity: typeof captureLiveProcessIdentity;
  readonly registry: BackendRegistry;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
  /** Progress and diagnostics → stderr. */
  readonly log: (text: string) => void;
}

const createDefaultDeps = (): SwitchDeps => ({
  config: loadConfig(),
  loadCatalog: () => loadCatalog(),
  readState,
  writeState,
  withLock,
  captureLiveProcessIdentity,
  registry: createDefaultRegistry(),
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
});

export type SwitchPrepared =
  | {
      readonly type: "already-active";
      readonly targetId: string;
      readonly endpoint: string;
      readonly backend: string;
    }
  | {
      readonly type: "ready";
      readonly currentModelId: string;
      readonly targetId: string;
      readonly endpoint: string;
      readonly backend: string;
      readonly ollamaId: string;
      readonly expectedSha256?: string | undefined;
      readonly expectedSizeBytes: number;
      readonly adapter: BackendAdapter;
      readonly snapshot: ConfirmationSnapshot;
    };

export type SwitchResult =
  | { readonly type: "already-active"; readonly modelId: string; readonly endpoint: string }
  | { readonly type: "switched"; readonly modelId: string; readonly endpoint: string };

export interface SwitchExecutionEvent {
  readonly phase: "prepare" | "readiness" | "locked-revalidate" | "state-commit";
  readonly status: "started" | "completed";
  readonly label: string;
}

export type SwitchExecutionObserver = (event: SwitchExecutionEvent) => void;

/** Resolve and validate all evidence shown before a switch starts pulling. */
export async function prepareSwitch(
  options: SwitchOptions,
  deps: SwitchDeps = createDefaultDeps(),
): Promise<SwitchPrepared> {
  const resolved = resolveModel(deps.loadCatalog(), options.model);
  const target = resolved.model;
  const preparedState = deps.readState(deps.config);
  const current = preparedState.active;
  if (current === null) {
    throw new ValidationError("no active server to switch. Run `local-llmup up <model>` first.");
  }
  if (current.modelId === target.id) {
    return Object.freeze({
      type: "already-active",
      targetId: target.id,
      endpoint: current.endpoint,
      backend: current.backend,
    });
  }
  const preparedProcessIdentity = await deps.captureLiveProcessIdentity(current);
  const approvedSnapshot = createRuntimeConfirmationSnapshot({
    operation: "replace_server",
    canonicalTargetIds: [current.modelId, target.id],
    state: preparedState,
    processIdentityHash: preparedProcessIdentity.hash,
  });

  // Prepare the target on the running daemon. Both steps run before the lock, so
  // a failure here never rewrites state — the prior active model is preserved.
  const adapter = (
    await select({ intent: "attach", registry: deps.registry, activeBackend: current.backend })
  ).adapter;
  if (!adapter.capabilities.canPull) {
    throw new ValidationError(
      `${adapter.name} models are runtime-managed; run \`local-llmup up ${target.id} --backend ${adapter.name}\` to attach the target`,
    );
  }
  if (
    adapter.capabilities.formats.includes("gguf") ||
    adapter.capabilities.formats.includes("mlx")
  ) {
    throw new ValidationError(
      `${adapter.name} is a single-model server; run \`local-llmup up ${target.id} --backend ${adapter.name}\` to replace it`,
    );
  }
  const ollamaId = target.source.ollama;
  if (ollamaId === undefined) {
    throw new ValidationError(`model ${target.id} has no ollama source to serve`);
  }
  const quant = resolved.quant ?? target.quantizations[0];
  if (quant === undefined) {
    throw new ValidationError(`model ${target.id} has no quantization to verify`);
  }
  return Object.freeze({
    type: "ready",
    currentModelId: current.modelId,
    targetId: target.id,
    endpoint: current.endpoint,
    backend: adapter.name,
    ollamaId,
    ...(quant.sha256 !== undefined ? { expectedSha256: quant.sha256 } : {}),
    expectedSizeBytes: quant.diskBytes,
    adapter,
    snapshot: approvedSnapshot,
  });
}

/** Execute exactly one previously prepared switch. */
export async function executePreparedSwitch(
  prepared: SwitchPrepared,
  deps: SwitchDeps = createDefaultDeps(),
  observe: SwitchExecutionObserver = () => undefined,
): Promise<SwitchResult> {
  if (prepared.type === "already-active") {
    return {
      type: "already-active",
      modelId: prepared.targetId,
      endpoint: prepared.endpoint,
    };
  }
  const notify = (event: SwitchExecutionEvent): void => {
    try {
      observe(event);
    } catch {
      // Presentation progress is advisory and cannot affect domain execution.
    }
  };
  const adapter = prepared.adapter;
  notify({ phase: "prepare", status: "started", label: "Pull target model" });
  deps.log(`Preparing ${stripControl(prepared.ollamaId)}...\n`);
  await adapter.pull({
    modelId: prepared.ollamaId,
    ...(prepared.expectedSha256 !== undefined
      ? { expectedSha256: prepared.expectedSha256 }
      : {}),
    expectedSizeBytes: prepared.expectedSizeBytes,
    onProgress: (event) => deps.log(`  ${stripControl(event.status)}\n`),
  });
  notify({ phase: "prepare", status: "completed", label: "Target model prepared" });
  notify({ phase: "readiness", status: "started", label: "Check runtime readiness" });
  await adapter.waitUntilReady({ endpoint: prepared.endpoint });
  notify({ phase: "readiness", status: "completed", label: "Runtime readiness passed" });

  // Commit the pointer move under the lock, inheriting the live daemon handle.
  const endpoint = await deps.withLock(deps.config, async () => {
    notify({ phase: "locked-revalidate", status: "started", label: "Revalidate active runtime" });
    const lockedState = deps.readState(deps.config);
    const active = lockedState.active;
    const lockedProcessIdentity =
      active === null ? null : await deps.captureLiveProcessIdentity(active);
    const currentSnapshot = createRuntimeConfirmationSnapshot({
      operation: "replace_server",
      canonicalTargetIds:
        active === null ? [prepared.targetId] : [active.modelId, prepared.targetId],
      state: lockedState,
      processIdentityHash: lockedProcessIdentity?.hash ?? null,
    });
    assertConfirmationUnchanged(
      prepared.snapshot,
      currentSnapshot,
      "the active server changed during switch; retry the command.",
    );
    if (active === null) {
      throw new ValidationError("the active server stopped during switch; run `up` again.");
    }
    notify({ phase: "locked-revalidate", status: "completed", label: "Active runtime revalidated" });
    // A concurrent switch may have already made the target active; treat that as
    // done rather than rewriting identical state.
    if (active.modelId !== prepared.targetId) {
      notify({ phase: "state-commit", status: "started", label: "Commit active model" });
      deps.writeState(deps.config, {
        schemaVersion: STATE_SCHEMA_VERSION,
        active: { ...active, modelId: prepared.targetId },
      });
      notify({ phase: "state-commit", status: "completed", label: "Active model committed" });
    }
    return active.endpoint;
  });

  return { type: "switched", modelId: prepared.targetId, endpoint };
}

export function formatSwitchResult(result: SwitchResult): string {
  return result.type === "already-active"
    ? `${stripControl(result.modelId)} is already active.\n`
    : `Switched to ${stripControl(result.modelId)} (${stripControl(result.endpoint)}).\n`;
}

/** Make `options.model` the active served model, preserving prior state on failure. */
export async function runSwitch(
  options: SwitchOptions,
  deps: SwitchDeps = createDefaultDeps(),
): Promise<void> {
  const prepared = await prepareSwitch(options, deps);
  const result = await executePreparedSwitch(prepared, deps);
  deps.write(formatSwitchResult(result));
}
