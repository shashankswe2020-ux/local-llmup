import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DIR_MODE, FILE_MODE, type Config } from "../config.js";
import { StateError } from "../errors.js";
import { BACKEND_NAMES, type BackendName } from "../types.js";
import { assertLoopbackEndpoint } from "../backend/adapter.js";

/** Bumped when the on-disk state layout changes in a backward-incompatible way. */
export const STATE_SCHEMA_VERSION = 2 as const;

/** The last schema version that predated the `backend` field. */
const V1_SCHEMA_VERSION = 1 as const;

/** The only backend a v1 state file could have described. */
const V1_DEFAULT_BACKEND = "ollama" satisfies BackendName;

/** Shared fields persisted for any active server entry. */
const ServerStateCommonSchema = z
  .object({
    backend: z.enum(BACKEND_NAMES),
    modelId: z.string().min(1),
    endpoint: z
      .string()
      .url()
      .refine(
        (endpoint) => {
          try {
            assertLoopbackEndpoint(endpoint);
            return true;
          } catch {
            return false;
          }
        },
        { message: "endpoint must be loopback HTTP" },
      ),
    port: z.number().int().min(1).max(65535),
    modelPath: z.string().min(1).optional(),
  })
  .strict();

/** A daemon we spawned locally and can signal by pid. */
const OwnedServerStateSchema = ServerStateCommonSchema.extend({
  ownedByUs: z.literal(true),
  pid: z.number().int().positive(),
  processExecutable: z.string().min(1).optional(),
  processStartedAt: z.string().min(1).optional(),
  authToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
}).strict();

/** A daemon we attached to and do not own (no trusted pid available). */
const AttachedServerStateSchema = ServerStateCommonSchema.extend({
  ownedByUs: z.literal(false),
  pid: z.number().int().positive().optional(),
  processExecutable: z.string().min(1).optional(),
  processStartedAt: z.string().min(1).optional(),
}).strict();

/** A running inference server that this CLI knows about. */
const ServerStateSchema = z.discriminatedUnion("ownedByUs", [
  OwnedServerStateSchema,
  AttachedServerStateSchema,
]);

/** Persisted runtime state: the single active server, if any. */
const RuntimeStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    active: ServerStateSchema.nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.active === null) return;
    if (state.active.backend === "mlx") {
      if (!state.active.ownedByUs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["active", "ownedByUs"],
          message: "MLX state must describe an owned process",
        });
      } else {
        for (const field of ["processExecutable", "processStartedAt", "authToken"] as const) {
          if (state.active[field] === undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["active", field],
              message: `owned MLX state requires ${field}`,
            });
          }
        }
      }
    } else if (state.active.backend === "lmstudio") {
      if (state.active.ownedByUs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["active", "ownedByUs"],
          message: "LM Studio state must describe an attached server",
        });
      } else {
        for (const field of [
          "pid",
          "processExecutable",
          "processStartedAt",
          "modelPath",
        ] as const) {
          if (state.active[field] === undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["active", field],
              message: `attached LM Studio state requires ${field}`,
            });
          }
        }
      }
    } else if (!state.active.ownedByUs && state.active.pid !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active", "pid"],
        message: "attached PID is only valid for LM Studio state",
      });
    } else if (state.active.ownedByUs && state.active.authToken !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active", "authToken"],
        message: "session token is only valid for MLX state",
      });
    }
    if (state.active.backend !== "lmstudio" && state.active.modelPath !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active", "modelPath"],
        message: "delegated model path is only valid for LM Studio state",
      });
    }
    const url = new URL(state.active.endpoint);
    const endpointPort = Number(url.port || "80");
    if (endpointPort !== state.active.port) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active", "port"],
        message: "recorded port must match endpoint port",
      });
    }
  });

export type ServerState = z.infer<typeof ServerStateSchema>;
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

/**
 * Normalize on-disk state into the current schema shape before validation.
 *
 * Two backward-compatibility transforms are composed here:
 *  - **v1 → v2:** a `schemaVersion: 1` file predates the `backend` field, so we
 *    stamp `schemaVersion: 2` and default the active server's `backend` to
 *    `"ollama"` (the only backend v1 could serve). The migrated state is
 *    rewritten as v2 on the next mutation.
 *  - **legacy pid 0:** older files encoded attached daemons as
 *    `{ ownedByUs: false, pid: 0 }`; we drop the sentinel pid so persisted state
 *    no longer relies on it.
 */
function normalizeLegacyRuntimeState(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  let candidate = parsed as Record<string, unknown>;

  if (candidate["schemaVersion"] === V1_SCHEMA_VERSION) {
    const active = candidate["active"];
    let migratedActive: unknown = active;
    if (typeof active === "object" && active !== null) {
      const activeRecord = active as Record<string, unknown>;
      if (activeRecord["backend"] === undefined) {
        migratedActive = { ...activeRecord, backend: V1_DEFAULT_BACKEND };
      }
    }
    candidate = {
      ...candidate,
      schemaVersion: STATE_SCHEMA_VERSION,
      active: migratedActive,
    };
  }

  const active = candidate["active"];
  if (typeof active !== "object" || active === null) return candidate;

  const activeRecord = active as Record<string, unknown>;
  if (activeRecord["ownedByUs"] !== false || activeRecord["pid"] !== 0) {
    return candidate;
  }

  const { pid: _legacyPid, ...normalizedActive } = activeRecord;
  return { ...candidate, active: normalizedActive };
}

/** Options controlling lock acquisition. Overrides exist primarily for tests. */
export interface LockOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly pid?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

/** A fresh state with no active server. */
export function createEmptyState(): RuntimeState {
  return { schemaVersion: STATE_SCHEMA_VERSION, active: null };
}

/**
 * Read and validate the runtime state.
 *
 * Returns an empty state when the file is absent. Corrupt states are surfaced
 * as distinct {@link StateError} kinds: `empty`, `unparseable`, or `invalid`.
 */
export function readState(config: Config): RuntimeState {
  let raw: string;
  try {
    raw = readFileSync(config.stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyState();
    }
    throw new StateError(`failed to read state file: ${config.stateFile}`, "io", { cause: error });
  }

  if (raw.length === 0) {
    throw new StateError(`state file is empty: ${config.stateFile}`, "empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateError(`state file is not valid JSON: ${config.stateFile}`, "unparseable", {
      cause: error,
    });
  }

  const normalized = normalizeLegacyRuntimeState(parsed);
  const result = RuntimeStateSchema.safeParse(normalized);
  if (!result.success) {
    throw new StateError(`state file failed validation: ${config.stateFile}`, "invalid", {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Write the runtime state atomically: serialize to a temp file in the staging
 * directory (same filesystem as the target), then rename over the state file.
 * A partially written temp file can never be observed as the live state.
 */
export function writeState(config: Config, state: RuntimeState): void {
  const result = RuntimeStateSchema.safeParse(state);
  if (!result.success) {
    throw new StateError("refusing to write invalid runtime state", "invalid", {
      cause: result.error,
    });
  }
  const validated = result.data;
  ensureDir(config.homeDir);
  ensureDir(config.stagingDir);

  const json = `${JSON.stringify(validated, null, 2)}\n`;
  const tempFile = join(config.stagingDir, `state.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, json, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
    renameSync(tempFile, config.stateFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Best-effort cleanup; ignore if the temp file is already gone.
    }
    throw new StateError(`failed to write state file: ${config.stateFile}`, "io", { cause: error });
  }
}

/**
 * Run `fn` while holding the mutation lock, serializing concurrent invocations.
 *
 * A stale lock left by a dead process is reclaimed rather than deadlocking. A
 * lock held by a live process blocks until it is released or `timeoutMs`
 * elapses, at which point a {@link StateError} of kind `locked` is thrown.
 */
export async function withLock<T>(
  config: Config,
  fn: () => T | Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  await acquireLock(config, isAlive, pid, timeoutMs, pollIntervalMs);
  try {
    return await fn();
  } finally {
    releaseLock(config);
  }
}

async function acquireLock(
  config: Config,
  isAlive: (pid: number) => boolean,
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  ensureDir(config.homeDir);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(config.lockFile, "wx", FILE_MODE);
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StateError(`failed to acquire lock: ${config.lockFile}`, "io", { cause: error });
      }
    }

    const holder = readHolderPid(config.lockFile);
    // Reclaim only when a valid holder PID is positively confirmed dead. A null
    // holder means the file is mid-creation (created empty by openSync before
    // its PID is written) or unreadable — clobbering it here would let two live
    // acquirers both enter the critical section, so we wait instead.
    if (holder !== null && !isAlive(holder)) {
      reclaimStaleLock(config.lockFile);
      continue;
    }

    if (Date.now() >= deadline) {
      if (holder === null) {
        // The lock stayed unreadable/empty for the entire timeout: treat it as a
        // crashed half-creation and reclaim it rather than deadlocking.
        reclaimStaleLock(config.lockFile);
        continue;
      }
      throw new StateError(`lock held by pid ${holder}: ${config.lockFile}`, "locked");
    }
    await delay(pollIntervalMs);
  }
}

/**
 * Reclaim a stale lock atomically: rename it to a caller-unique name so only one
 * racer wins the reclaim, then delete it. A blind unlink could delete a lock a
 * different process had just recreated; renaming makes the winner the sole owner
 * of the delete. A losing racer's rename fails and it simply retries the loop.
 */
function reclaimStaleLock(lockFile: string): void {
  const claim = `${lockFile}.reclaim.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockFile, claim);
    unlinkSync(claim);
  } catch {
    // Another process reclaimed or recreated the lock first; retry acquisition.
  }
}

function releaseLock(config: Config): void {
  try {
    unlinkSync(config.lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new StateError(`failed to release lock: ${config.lockFile}`, "io", { cause: error });
    }
  }
}

function readHolderPid(lockFile: string): number | null {
  try {
    const pid = Number(readFileSync(lockFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True when a process with `pid` exists (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
