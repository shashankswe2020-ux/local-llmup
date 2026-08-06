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
  type BackendAdapter,
  type PullResult,
  type ServeHandle,
} from "../backend/adapter.js";
import { createDefaultRegistry, type BackendRegistry } from "../backend/registry.js";
import { select } from "../backend/select.js";
import {
  STATE_SCHEMA_VERSION,
  readState,
  withLock,
  writeState,
  type RuntimeState,
  type ServerState,
} from "../state/state.js";
import type {
  BackendName,
  Catalog,
  CatalogModel,
  HardwareProfile,
  Quantization,
} from "../types.js";

/** Inputs for `up`. Servers always bind loopback in v1, so there is no host. */
export interface UpOptions {
  readonly model: string;
  /** Port for the backend server; defaults to the backend's standard port. */
  readonly port?: number | undefined;
  /** Force a specific backend; omitted → auto-detect the first servable one. */
  readonly backend?: BackendName | undefined;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface UpDeps {
  readonly config: Config;
  readonly loadCatalog: () => Catalog;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly registry: BackendRegistry;
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
  registry: createDefaultRegistry(),
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

  // 3. Resolve the backend for a create action. Auto-detect probes each
  // registered backend's `isInstalled()`; with no servable backend it throws a
  // BackendError listing each install hint. Phase 0 registers only Ollama, so
  // this resolves Ollama exactly as the previous inline install check did.
  const selection = await select({
    intent: "create",
    registry: deps.registry,
    platform: hardware.platform,
    arch: hardware.arch,
    ...(options.backend !== undefined ? { flag: options.backend } : {}),
  });
  const adapter = selection.adapter;

  // 4. Pull and verify the weights. Source resolution is format-aware: daemon
  // runtimes (Ollama) pull by model id through their own store; self-managed
  // runtimes (llama.cpp) download a pinned GGUF and hand back its on-disk path.
  const ollamaId = adapter.capabilities.formats.includes("ollama")
    ? model.source.ollama
    : undefined;
  const ggufSource = adapter.capabilities.formats.includes("gguf")
    ? model.source.gguf
    : undefined;
  let pullResult: PullResult;
  if (ollamaId !== undefined) {
    deps.log(`Pulling ${stripControl(ollamaId)} (${quant.name})...\n`);
    pullResult = await adapter.pull({
      modelId: ollamaId,
      ...(quant.sha256 !== undefined ? { expectedSha256: quant.sha256 } : {}),
      expectedSizeBytes: quant.diskBytes,
      onProgress: (event) => deps.log(`  ${stripControl(event.status)}\n`),
    });
  } else if (ggufSource !== undefined) {
    deps.log(`Pulling ${stripControl(ggufSource.file)} (${quant.name})...\n`);
    pullResult = await adapter.pull({
      modelId: model.id,
      source: {
        repo: ggufSource.repo,
        revision: ggufSource.revision,
        file: ggufSource.file,
        ...(ggufSource.sha256 !== undefined ? { sha256: ggufSource.sha256 } : {}),
      },
      onProgress: (event) => deps.log(`  ${stripControl(event.status)}\n`),
    });
  } else {
    throw new ValidationError(
      `model ${model.id} has no source that backend ${adapter.name} can serve`,
    );
  }

  // Honesty gate: surface unverified integrity rather than serving silently. A
  // pull is unverified when the catalog carried no digest, so only a weaker
  // check (size floor or pinned commit) backed the download.
  if (!pullResult.digestVerified) {
    deps.log(
      `up: warning — ${stripControl(model.id)} weights could not be digest-verified (no catalog SHA-256); serving on a weaker integrity check\n`,
    );
  }

  // 5-7. Spawn/attach, health-check, and persist under one lock.
  // This closes the race where two concurrent `up` runs could both spawn owned
  // daemons before either one writes state.
  const port = options.port ?? adapter.capabilities.defaultPort;
  let endpoint = "";
  await deps.withLock(deps.config, async () => {
    const modelPath = pullResult.modelPath;
    const handle = await adapter.serve({
      host: DEFAULT_BIND_HOST,
      port,
      ...(modelPath !== undefined ? { modelPath } : {}),
    });

    // Second readiness probe is intentional: `serve` proves daemon liveness,
    // while this command-level check requires OpenAI-compatible readiness so
    // the endpoint is usable by the rest of llmup before state is persisted.
    // On failure, stop only a daemon we spawned, then abort.
    try {
      await adapter.waitUntilReady({
        endpoint: handle.endpoint,
        requireOpenAiCompatibility: true,
      });
    } catch (error) {
      await stopQuietly(adapter, handle);
      throw new BackendError(`server for ${model.id} did not become ready`, { cause: error });
    }

    // Reconcile inside the lock: a previously-recorded server we own is stopped
    // before its record is replaced, so re-running `up` cannot orphan a daemon
    // that `down` would no longer be able to find. If persistence fails, stop the
    // daemon we just started so it is not left running without a state record.
    try {
      const prior = deps.readState(deps.config).active;
      if (prior !== null && prior.ownedByUs && !(prior.pid === handle.pid && prior.port === handle.port)) {
        await stopQuietly(adapter, {
          endpoint: prior.endpoint,
          pid: prior.pid,
          port: prior.port,
          ownedByUs: prior.ownedByUs,
        });
      }
      const backend = adapter.name;
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
      await stopQuietly(adapter, handle);
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
