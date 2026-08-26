/**
 * GUI runtime (inference backend) controller. Lets the browser workspace see
 * which runtimes are installed and running, and start/stop a *daemon* runtime's
 * server process on toggle. Only daemon runtimes that serve from a shared model
 * store (Ollama in v1) can be started without a specific model loaded; per-model
 * runtimes (llama.cpp, MLX) and attach-only runtimes (LM Studio) are surfaced
 * read-only and must be launched by serving a model from the Models tab.
 *
 * The controller is the single owner of any daemon *this process* spawned: it
 * records the {@link ServeHandle} so {@link RuntimeController.shutdown} tears
 * those down on server exit. A toggle may also stop a daemon running *outside*
 * this app; that path attaches to obtain a verified handle and stops it only
 * after the adapter confirms the process owns the loopback port and matches the
 * runtime executable.
 */
import { buildEndpoint, DEFAULT_BIND_HOST, type BackendAdapter, type ServeHandle } from "../backend/adapter.js";
import type { BackendRegistry } from "../backend/registry.js";
import { ValidationError } from "../errors.js";
import { BACKEND_NAMES, type BackendName } from "../types.js";

/** A UI-facing view of one inference runtime's current state. */
export interface RuntimeStatusView {
  readonly name: BackendName;
  /** Whether the runtime binary/daemon is available on this machine. */
  readonly installed: boolean;
  /** Whether a server is currently answering readiness on its loopback port. */
  readonly running: boolean;
  /** True only when this process spawned the running daemon (so it may stop it). */
  readonly ownedByUs: boolean;
  /** Loopback endpoint the runtime serves on, or `null` when not installed. */
  readonly endpoint: string | null;
  /** True when a toggle may start this runtime without loading a model first. */
  readonly canStart: boolean;
  /** True when a toggle may stop this running daemon (including a foreign one). */
  readonly canStop: boolean;
  /** Human-readable note (why a runtime cannot be toggled, or how it is running). */
  readonly detail?: string | undefined;
}

/** The runtime-control surface the GUI server depends on. */
export interface RuntimeController {
  /** Status of every known runtime, probed in parallel. */
  list(): Promise<readonly RuntimeStatusView[]>;
  /** Start (or attach to) a daemon runtime's server; throws on non-daemon runtimes. */
  start(name: string): Promise<RuntimeStatusView>;
  /** Stop a running daemon (one we spawned, or an identity-verified foreign one). */
  stop(name: string): Promise<RuntimeStatusView>;
  /** Best-effort teardown of every daemon this controller started. */
  shutdown(): Promise<void>;
}

/**
 * Runtimes that run as a shared-store daemon and can serve with no model loaded.
 * Only these are startable from a toggle; everything else needs a model and is
 * launched via the `up` flow. Kept as a name allowlist (rather than a capability
 * flag) so the shared backend capability schema is not widened for the GUI.
 */
const DAEMON_RUNTIMES: ReadonlySet<BackendName> = new Set<BackendName>(["ollama"]);

/** Short, bounded readiness probe used only to report running/not-running. */
const STATUS_PROBE_TIMEOUT_MS = 600;
/** Readiness budget after starting a daemon we spawned. */
const START_READY_TIMEOUT_MS = 15_000;

function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

function assertBackendName(name: string): BackendName {
  if (!isBackendName(name)) {
    throw new ValidationError(`unknown runtime: ${name} (known: ${BACKEND_NAMES.join(", ")})`);
  }
  return name;
}

function detailFor(name: BackendName, running: boolean, ownedByUs: boolean): string | undefined {
  if (!DAEMON_RUNTIMES.has(name)) {
    return "Runs per model — start a model from the Models tab to launch this runtime.";
  }
  if (running && !ownedByUs) {
    return "Running — started outside this app. Turning it off will stop the external server.";
  }
  return undefined;
}

/** Build a runtime controller over an explicit backend registry. */
export function createRuntimeController(registry: BackendRegistry): RuntimeController {
  // Only daemons *we* spawned are tracked, so stop() never signals a foreign one.
  const owned = new Map<BackendName, ServeHandle>();

  async function probeRunning(adapter: BackendAdapter, endpoint: string): Promise<boolean> {
    try {
      await adapter.waitUntilReady({ endpoint, retries: 1, timeoutMs: STATUS_PROBE_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async function statusOf(adapter: BackendAdapter): Promise<RuntimeStatusView> {
    const name = adapter.name;
    let installed = false;
    try {
      installed = await adapter.isInstalled();
    } catch {
      installed = false;
    }
    if (!installed) {
      return {
        name,
        installed: false,
        running: false,
        ownedByUs: false,
        endpoint: null,
        canStart: false,
        canStop: false,
        detail: "Not installed.",
      };
    }

    const endpoint = buildEndpoint(DEFAULT_BIND_HOST, adapter.capabilities.defaultPort);
    const ownedHandle = owned.get(name);
    const running = ownedHandle !== undefined ? true : await probeRunning(adapter, endpoint);
    const ownedByUs = ownedHandle !== undefined;

    return {
      name,
      installed: true,
      running,
      ownedByUs,
      endpoint,
      canStart: DAEMON_RUNTIMES.has(name),
      // A running daemon can be stopped from a toggle — including one started
      // outside this app, which stop() below terminates only after verifying it
      // owns the loopback port and matches the runtime executable.
      canStop: DAEMON_RUNTIMES.has(name) && running,
      detail: detailFor(name, running, ownedByUs),
    };
  }

  return {
    async list(): Promise<readonly RuntimeStatusView[]> {
      return Promise.all(registry.all().map((adapter) => statusOf(adapter)));
    },

    async start(name: string): Promise<RuntimeStatusView> {
      const backend = assertBackendName(name);
      const adapter = registry.get(backend);
      if (!DAEMON_RUNTIMES.has(backend)) {
        throw new ValidationError(
          `${backend} runs per model — start a model from the Models tab to launch it`,
        );
      }
      if (!(await adapter.isInstalled())) {
        throw new ValidationError(`${backend} is not installed — install it first`);
      }

      const handle = await adapter.serve();
      await adapter.waitUntilReady({ endpoint: handle.endpoint, timeoutMs: START_READY_TIMEOUT_MS });
      // Only record a daemon we actually spawned; an attached foreign daemon is
      // left untracked so stop() never signals a process we do not own.
      if (handle.ownedByUs) {
        owned.set(backend, handle);
      }
      return statusOf(adapter);
    },

    async stop(name: string): Promise<RuntimeStatusView> {
      const backend = assertBackendName(name);
      const adapter = registry.get(backend);
      const handle = owned.get(backend);
      if (handle !== undefined) {
        await adapter.stop(handle);
        owned.delete(backend);
        return statusOf(adapter);
      }
      // No handle we spawned: this is a daemon running outside this app. Attach to
      // obtain a verified handle, then stop it with an explicit foreign opt-in.
      // serve() attaches (never spawns) to a reachable, identity-checked daemon.
      if (DAEMON_RUNTIMES.has(backend) && (await adapter.isInstalled())) {
        const attached = await adapter.serve();
        if (attached.ownedByUs) {
          // We unexpectedly spawned one; track and stop it through the owned path.
          await adapter.stop(attached);
        } else {
          await adapter.stop(attached, { allowForeign: true });
        }
      }
      return statusOf(adapter);
    },

    async shutdown(): Promise<void> {
      const entries = [...owned.entries()];
      owned.clear();
      await Promise.all(
        entries.map(async ([backend, handle]) => {
          try {
            await registry.get(backend).stop(handle);
          } catch {
            // Best-effort teardown; a failed stop must not block server exit.
          }
        }),
      );
    },
  };
}
