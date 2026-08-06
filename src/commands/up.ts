/**
 * The `up` command: bring a model online end-to-end. It resolves the requested
 * name against the catalog, preflights free disk against the selected quant,
 * ensures the backend is installed, pulls (and verifies) the weights, starts a
 * loopback-only server, waits for it to pass a health probe, and finally records
 * the active server in `state.json` under the state lock.
 *
 * Ordering matters and is asserted by the acceptance tests: resolve → disk
 * preflight → ensure backend → pull → serve → health → state write. The state
 * write lives here in the command layer (not the adapter) because the adapter is
 * stateless. Side effects are injected via {@link UpDeps} so the whole flow can
 * be driven with fakes.
 */
import { loadCatalog } from "../catalog/load.js";
import { loadConfig, type Config } from "../config.js";
import { BackendError, ValidationError } from "../errors.js";
import { detectHardware } from "../hardware/detect.js";
import { evaluateFit } from "../ranking/fit.js";
import { resolveModel } from "../resolver.js";
import { stripControl } from "../sanitize.js";
import {
  DEFAULT_BIND_HOST,
  DEFAULT_OLLAMA_PORT,
  type BackendAdapter,
  type ServeHandle,
} from "../backend/adapter.js";
import { OllamaAdapter } from "../backend/ollama.js";
import {
  STATE_SCHEMA_VERSION,
  readState,
  withLock,
  writeState,
  type RuntimeState,
  type ServerState,
} from "../state/state.js";
import type { Catalog, CatalogModel, HardwareProfile, Quantization } from "../types.js";

/** Inputs for `up`. Servers always bind loopback in v1, so there is no host. */
export interface UpOptions {
  readonly model: string;
  /** Port for the backend server; defaults to the backend's standard port. */
  readonly port?: number | undefined;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface UpDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly adapter: BackendAdapter;
  readonly readState: (config: Config) => RuntimeState;
  readonly writeState: (config: Config, state: RuntimeState) => void;
  readonly withLock: <T>(config: Config, fn: () => T | Promise<T>) => Promise<T>;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
  /** Progress and diagnostics → stderr. */
  readonly log: (text: string) => void;
}

const createDefaultDeps = (): UpDeps => ({
  config: loadConfig(),
  loadCatalog: () => loadCatalog(),
  detectHardware: () => detectHardware(),
  adapter: new OllamaAdapter(),
  readState,
  writeState,
  withLock,
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
});

/**
 * Pick the quant to install: the one named by a `-<quant>` suffix if given,
 * otherwise the highest-quality quant that fits this hardware. Throws when no
 * quant fits, naming the binding constraint.
 */
function chooseQuant(
  model: CatalogModel,
  requested: Quantization | undefined,
  hardware: HardwareProfile,
): Quantization {
  if (requested !== undefined) return requested;
  const fit = evaluateFit(model, hardware);
  if (!fit.fits) {
    if (fit.reason === "disk-bound") {
      throw new ValidationError(
        insufficientDiskMessage(model, smallestDiskQuant(model), hardware.freeDiskBytes),
      );
    }
    throw new ValidationError(`${model.id} does not fit this hardware (${fit.reason})`);
  }
  return fit.quant;
}

function evaluateRequestedQuantFit(
  model: CatalogModel,
  requested: Quantization,
  hardware: HardwareProfile,
) {
  return evaluateFit({ ...model, quantizations: [requested] }, hardware);
}

function smallestDiskQuant(model: CatalogModel): Quantization {
  let smallest = model.quantizations[0];
  for (const quant of model.quantizations) {
    if (smallest === undefined || quant.diskBytes < smallest.diskBytes) {
      smallest = quant;
    }
  }
  if (smallest === undefined) {
    throw new ValidationError(`model ${model.id} has no quantizations`);
  }
  return smallest;
}

/** Format bytes as whole GiB for human-facing messages. */
function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function insufficientDiskMessage(
  model: CatalogModel,
  quant: Quantization,
  freeDiskBytes: number,
): string {
  return `insufficient disk for ${model.id} (${quant.name}): need ${formatGiB(quant.diskBytes)}, ${formatGiB(freeDiskBytes)} free`;
}

/**
 * Bring `options.model` online and persist it as the active server. Throws a
 * typed error on any failure; the caller maps that to a stderr message and a
 * non-zero exit code.
 */
export async function runUp(options: UpOptions, deps: UpDeps = createDefaultDeps()): Promise<void> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
  ) {
    throw new ValidationError(`invalid port: ${options.port} (expected an integer in 1..65535)`);
  }

  const catalog = deps.loadCatalog();

  // 1. Resolve the requested name to a single catalog model.
  const resolved = resolveModel(catalog, options.model);
  const model = resolved.model;
  const ollamaId = model.source.ollama;
  if (ollamaId === undefined) {
    throw new ValidationError(`model ${model.id} has no ollama source to pull`);
  }

  // 2. Disk preflight against the selected quant, using the injectable probe.
  const hardware = await deps.detectHardware();
  const quant = chooseQuant(model, resolved.quant, hardware);
  if (quant.diskBytes > hardware.freeDiskBytes) {
    throw new ValidationError(insufficientDiskMessage(model, quant, hardware.freeDiskBytes));
  }
  if (resolved.quant !== undefined) {
    const fit = evaluateRequestedQuantFit(model, quant, hardware);
    if (!fit.fits) {
      deps.log(
        `up: requested quant ${stripControl(quant.name)} for ${stripControl(model.id)} may not fit this hardware (${fit.reason}); continuing because it was explicitly requested\n`,
      );
    }
  }

  // 3. Ensure the backend is installed; surface the install command otherwise.
  if (!(await deps.adapter.isInstalled())) {
    throw new BackendError(
      `${deps.adapter.name} is not installed. Install it with: ${deps.adapter.installHint()}`,
    );
  }

  // 4. Pull and verify the weights.
  deps.log(`Pulling ${stripControl(ollamaId)} (${quant.name})...\n`);
  await deps.adapter.pull({
    modelId: ollamaId,
    ...(quant.sha256 !== undefined ? { expectedSha256: quant.sha256 } : {}),
    expectedSizeBytes: quant.diskBytes,
    onProgress: (event) => deps.log(`  ${stripControl(event.status)}\n`),
  });

  // 5-7. Spawn/attach, health-check, and persist under one lock.
  // This closes the race where two concurrent `up` runs could both spawn owned
  // daemons before either one writes state.
  const port = options.port ?? DEFAULT_OLLAMA_PORT;
  let endpoint = "";
  await deps.withLock(deps.config, async () => {
    const handle = await deps.adapter.serve({ host: DEFAULT_BIND_HOST, port });

    // Second readiness probe is intentional: `serve` proves daemon liveness,
    // while this command-level check requires OpenAI-compatible readiness so
    // the endpoint is usable by the rest of llmup before state is persisted.
    // On failure, stop only a daemon we spawned, then abort.
    try {
      await deps.adapter.waitUntilReady({
        endpoint: handle.endpoint,
        requireOpenAiCompatibility: true,
      });
    } catch (error) {
      await stopQuietly(deps.adapter, handle);
      throw new BackendError(`server for ${model.id} did not become ready`, { cause: error });
    }

    // Reconcile inside the lock: a previously-recorded server we own is stopped
    // before its record is replaced, so re-running `up` cannot orphan a daemon
    // that `down` would no longer be able to find. If persistence fails, stop the
    // daemon we just started so it is not left running without a state record.
    try {
      const prior = deps.readState(deps.config).active;
      if (prior !== null && prior.ownedByUs && !(prior.pid === handle.pid && prior.port === handle.port)) {
        await stopQuietly(deps.adapter, {
          endpoint: prior.endpoint,
          pid: prior.pid,
          port: prior.port,
          ownedByUs: prior.ownedByUs,
        });
      }
      // Phase 0 is Ollama-only; B6 will source this from select().
      const backend = "ollama" as const;
      const active: ServerState = handle.ownedByUs
        ? {
            backend,
            modelId: model.id,
            endpoint: handle.endpoint,
            pid: handle.pid,
            port: handle.port,
            ownedByUs: true,
          }
        : {
            backend,
            modelId: model.id,
            endpoint: handle.endpoint,
            port: handle.port,
            ownedByUs: false,
          };
      deps.writeState(deps.config, { schemaVersion: STATE_SCHEMA_VERSION, active });
      endpoint = handle.endpoint;
    } catch (error) {
      await stopQuietly(deps.adapter, handle);
      throw error;
    }
  });

  deps.write(`${stripControl(model.id)} ready at ${stripControl(endpoint)}\n`);
}

/** Stop an owned daemon during cleanup, swallowing errors so the original
 * failure is the one that propagates. A no-op for attached daemons. */
async function stopQuietly(adapter: BackendAdapter, handle: ServeHandle): Promise<void> {
  try {
    await adapter.stop(handle);
  } catch {
    // Best-effort cleanup; the caller is already unwinding a prior failure.
  }
}
