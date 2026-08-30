import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BACKEND_NAMES, type BackendName } from "./types.js";
import { ValidationError } from "./errors.js";

/** Directory permission bits for local-llmup-owned directories (owner-only). */
export const DIR_MODE = 0o700;

/** File permission bits for local-llmup-owned files (owner read/write only). */
export const FILE_MODE = 0o600;

const HOME_DIR_NAME = ".local-llmup";
const ENV_HOME_OVERRIDE = "LOCAL_LLMUP_HOME";

/** Resolved filesystem locations local-llmup reads from and writes to. */
export interface Config {
  /** Root directory for all local-llmup state (`~/.local-llmup` by default). */
  readonly homeDir: string;
  /** Atomically written runtime state (active model, endpoint, daemon pid/port). */
  readonly stateFile: string;
  /** Lock file serializing mutating commands. */
  readonly lockFile: string;
  /** Root of per-model memory stores. */
  readonly memoryDir: string;
  /** Owner-only staging directory (same filesystem as `homeDir`) for atomic writes. */
  readonly stagingDir: string;
  /** Persisted MCP connector definitions (`~/.local-llmup/connectors.json`). */
  readonly connectorsFile: string;
  /** Directory of agent (persona/system-prompt) markdown files (`~/.local-llmup/agents`). */
  readonly agentsDir: string;
  /** Directory of skill packages, each a `SKILL.md` (`~/.local-llmup/skills`). */
  readonly skillsDir: string;
  /** Directory of generated chat artifacts (images/graphs) servable to the GUI. */
  readonly artifactsDir: string;
  /** Owner-only store of persisted GUI chat sessions (`~/.local-llmup/gui-sessions`). */
  readonly guiSessionsDir: string;
}

/**
 * Resolve local-llmup's paths. `LOCAL_LLMUP_HOME` overrides the default home
 * directory; blank or whitespace-only values are ignored.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const override = env[ENV_HOME_OVERRIDE]?.trim();
  const homeDir = override ? resolve(override) : join(homedir(), HOME_DIR_NAME);

  return Object.freeze({
    homeDir,
    stateFile: join(homeDir, "state.json"),
    lockFile: join(homeDir, "lock"),
    memoryDir: join(homeDir, "memory"),
    stagingDir: join(homeDir, ".staging"),
    connectorsFile: join(homeDir, "connectors.json"),
    agentsDir: join(homeDir, "agents"),
    skillsDir: join(homeDir, "skills"),
    artifactsDir: join(homeDir, "artifacts"),
    guiSessionsDir: join(homeDir, "gui-sessions"),
  });
}

/** Filename of the optional user config under {@link Config.homeDir}. */
export const USER_CONFIG_FILE = "config.json";

/**
 * Upper bound on the user config file size. The document holds a handful of
 * scalar preferences, so anything larger is treated as corrupt/hostile and
 * rejected rather than read into memory.
 */
export const MAX_USER_CONFIG_BYTES = 4096;

/** `O_NOFOLLOW` where the platform provides it (POSIX); `0` elsewhere. */
const O_NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/**
 * Optional user preferences persisted at `~/.local-llmup/config.json`. Absent or
 * blank means "no preference". `schemaVersion` is a hard literal so a future,
 * incompatible layout fails closed rather than being silently misread.
 */
export const UserConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultBackend: z.enum(BACKEND_NAMES),
  })
  .strict();

/** Validated user preferences. */
export interface UserConfig {
  readonly schemaVersion: 1;
  readonly defaultBackend: BackendName;
}

/**
 * Load and validate the optional user config, failing **closed**. Returns
 * `undefined` when the file is absent or blank (no preference). Throws
 * {@link ValidationError} on a symlink, a group/other-writable file, an
 * oversized file, invalid JSON, an unknown key, a wrong version, or an unknown
 * backend name.
 *
 * The file is opened with `O_NOFOLLOW` and inspected via its file descriptor so
 * the symlink, permission, and size checks cannot be defeated by a swap between
 * `stat` and `open` (TOCTOU). This loader is deliberately **not** on the advice
 * path (`recommend`/`can-run`), which stays deterministic and offline.
 */
export function loadUserConfig(config: Config = loadConfig()): UserConfig | undefined {
  const path = join(config.homeDir, USER_CONFIG_FILE);

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW_FLAG);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined; // no config → no preference
    }
    if (code === "ELOOP") {
      throw new ValidationError(`refusing to read config: ${path} is a symlink`, { cause: error });
    }
    throw new ValidationError(`failed to read config file: ${path}`, { cause: error });
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new ValidationError(`refusing to read config: ${path} is not a regular file`);
    }

    const mode = stats.mode & 0o777;
    if ((mode & 0o022) !== 0) {
      // Reject only group/other-WRITABLE: `defaultBackend` is a non-secret enum,
      // so world-readable leaks nothing, but a writable config is a tamper vector.
      throw new ValidationError(
        `refusing to read config ${path}: group/other-writable (0${mode.toString(8)})`,
      );
    }

    if (stats.size > MAX_USER_CONFIG_BYTES) {
      throw new ValidationError(
        `config file ${path} is too large (${stats.size} > ${MAX_USER_CONFIG_BYTES} bytes)`,
      );
    }

    // Bound the read to the same descriptor. `fstat.size` is a fast early reject,
    // but a same-UID append between fstat and read could grow the file, so read at
    // most MAX+1 bytes and reject on overflow rather than trusting the stat size.
    const buffer = Buffer.alloc(MAX_USER_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(fd, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    if (total > MAX_USER_CONFIG_BYTES) {
      throw new ValidationError(
        `config file ${path} is too large (> ${MAX_USER_CONFIG_BYTES} bytes)`,
      );
    }

    const raw = buffer.toString("utf8", 0, total);
    if (raw.trim().length === 0) {
      return undefined; // blank → no preference
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ValidationError(`config file ${path} is not valid JSON`, { cause: error });
    }

    const result = UserConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(`config file ${path} failed validation`, { cause: result.error });
    }
    return result.data;
  } finally {
    closeSync(fd);
  }
}
