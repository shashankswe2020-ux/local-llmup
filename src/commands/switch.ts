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
import { select } from "../backend/select.js";
import { readState, withLock, writeState, STATE_SCHEMA_VERSION, type RuntimeState } from "../state/state.js";
import type { Catalog } from "../types.js";

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
  registry: createDefaultRegistry(),
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
});

/** Make `options.model` the active served model, preserving prior state on failure. */
export async function runSwitch(
  options: SwitchOptions,
  deps: SwitchDeps = createDefaultDeps(),
): Promise<void> {
  const resolved = resolveModel(deps.loadCatalog(), options.model);
  const target = resolved.model;
  const ollamaId = target.source.ollama;
  if (ollamaId === undefined) {
    throw new ValidationError(`model ${target.id} has no ollama source to serve`);
  }

  const current = deps.readState(deps.config).active;
  if (current === null) {
    throw new ValidationError(
      "no active server to switch. Run `local-llmup up <model>` first.",
    );
  }
  if (current.modelId === target.id) {
    deps.write(`${stripControl(target.id)} is already active.\n`);
    return;
  }

  // Prepare the target on the running daemon. Both steps run before the lock, so
  // a failure here never rewrites state — the prior active model is preserved.
  const adapter = (
    await select({ intent: "attach", registry: deps.registry, activeBackend: current.backend })
  ).adapter;
  const quant = resolved.quant;
  deps.log(`Preparing ${stripControl(ollamaId)}...\n`);
  await adapter.pull({
    modelId: ollamaId,
    ...(quant?.sha256 !== undefined ? { expectedSha256: quant.sha256 } : {}),
    ...(quant !== undefined ? { expectedSizeBytes: quant.diskBytes } : {}),
    onProgress: (event) => deps.log(`  ${stripControl(event.status)}\n`),
  });
  await adapter.waitUntilReady({ endpoint: current.endpoint });

  // Commit the pointer move under the lock, inheriting the live daemon handle.
  const endpoint = await deps.withLock(deps.config, () => {
    const active = deps.readState(deps.config).active;
    if (active === null) {
      throw new ValidationError("the active server stopped during switch; run `up` again.");
    }
    // A concurrent switch may have already made the target active; treat that as
    // done rather than rewriting identical state.
    if (active.modelId !== target.id) {
      deps.writeState(deps.config, {
        schemaVersion: STATE_SCHEMA_VERSION,
        active: { ...active, modelId: target.id },
      });
    }
    return active.endpoint;
  });

  deps.write(`Switched to ${stripControl(target.id)} (${stripControl(endpoint)}).\n`);
}
