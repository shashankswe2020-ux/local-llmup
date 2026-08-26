/**
 * Fail-closed persistence for MCP connector definitions at
 * `~/.local-llmup/connectors.json`. Loading mirrors {@link loadUserConfig}:
 * the file is opened with `O_NOFOLLOW`, inspected via its descriptor, size
 * bounded, and validated with Zod — anything malformed or hostile is rejected
 * rather than trusted. Writing is atomic (staging file + rename) with
 * owner-only permissions.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DIR_MODE, FILE_MODE, loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import {
  ConnectorsFileSchema,
  emptyConnectorsFile,
  type ConnectorsFile,
} from "./schema.js";

/** Upper bound on the connectors file size (a few dozen small records). */
export const MAX_CONNECTORS_FILE_BYTES = 64 * 1024;

/** `O_NOFOLLOW` where the platform provides it (POSIX); `0` elsewhere. */
const O_NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/**
 * Load and validate the connectors document, failing **closed**. Returns an
 * empty document when the file is absent or blank. Throws
 * {@link ValidationError} on a symlink, a group/other-writable file, an
 * oversized file, invalid JSON, or a schema violation.
 */
export function loadConnectors(config: Config = loadConfig()): ConnectorsFile {
  const path = config.connectorsFile;

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW_FLAG);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyConnectorsFile();
    }
    if (code === "ELOOP") {
      throw new ValidationError(`refusing to read connectors: ${path} is a symlink`, {
        cause: error,
      });
    }
    throw new ValidationError(`failed to read connectors file: ${path}`, { cause: error });
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new ValidationError(`refusing to read connectors: ${path} is not a regular file`);
    }

    const mode = stats.mode & 0o777;
    if ((mode & 0o022) !== 0) {
      throw new ValidationError(
        `refusing to read connectors ${path}: group/other-writable (0${mode.toString(8)})`,
      );
    }

    const buffer = Buffer.alloc(MAX_CONNECTORS_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(fd, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    if (total > MAX_CONNECTORS_FILE_BYTES) {
      throw new ValidationError(
        `connectors file ${path} is too large (> ${MAX_CONNECTORS_FILE_BYTES} bytes)`,
      );
    }

    const raw = buffer.toString("utf8", 0, total);
    if (raw.trim().length === 0) {
      return emptyConnectorsFile();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ValidationError(`connectors file ${path} is not valid JSON`, { cause: error });
    }

    const result = ConnectorsFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(`connectors file ${path} failed validation`, {
        cause: result.error,
      });
    }
    return result.data;
  } finally {
    closeSync(fd);
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/**
 * Write the connectors document atomically: serialize to a temp file in the
 * staging directory (same filesystem as the target), then rename over the
 * connectors file. A partially written temp file can never be observed as the
 * live document. The file is validated before it is written.
 */
export function saveConnectors(config: Config, file: ConnectorsFile): void {
  const result = ConnectorsFileSchema.safeParse(file);
  if (!result.success) {
    throw new ValidationError("refusing to write invalid connectors file", {
      cause: result.error,
    });
  }
  ensureDir(config.homeDir);
  ensureDir(config.stagingDir);

  const json = `${JSON.stringify(result.data, null, 2)}\n`;
  const tempFile = join(config.stagingDir, `connectors.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, json, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
    renameSync(tempFile, config.connectorsFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Best-effort cleanup; ignore if the temp file is already gone.
    }
    throw new ValidationError(`failed to write connectors file: ${config.connectorsFile}`, {
      cause: error,
    });
  }
}
