import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  });
}
