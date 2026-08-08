import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative } from "node:path";
import { MemoryError } from "../errors.js";
import { TextDecoder } from "node:util";

/** Return a usable no-follow flag, failing closed on unsupported platforms. */
export function requireNoFollowFlag(value: unknown): number {
  if (typeof value !== "number" || value === 0) {
    throw new MemoryError("secure memory reads require O_NOFOLLOW support");
  }
  return value;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function containedCanonicalPath(
  path: string,
  root: string,
  label: string,
): { readonly path: string; readonly root: FileIdentity; readonly canonicalRoot: string } {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new MemoryError(`${label} memory root is not a trusted directory: ${root}`);
  }
  const canonicalRoot = realpathSync(root);
  const resolvedRootStat = lstatSync(root);
  if (
    !resolvedRootStat.isDirectory() ||
    resolvedRootStat.isSymbolicLink() ||
    !sameIdentity(rootStat, resolvedRootStat)
  ) {
    throw new MemoryError(`${label} memory root changed during canonicalization: ${root}`);
  }
  const canonicalPath = realpathSync(path);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) {
    return {
      path: canonicalPath,
      root: { dev: rootStat.dev, ino: rootStat.ino },
      canonicalRoot,
    };
  }
  throw new MemoryError(`${label} escapes its memory store: ${path}`);
}

/** Read at most maxBytes+1 from one no-follow regular-file descriptor. */
export function readBoundedUtf8File(
  path: string,
  label: string,
  maxBytes: number,
  options: {
    readonly allowMissing?: boolean | undefined;
    readonly allowedRoot?: string | undefined;
  } = {},
): string | undefined {
  let fd: number | undefined;
  try {
    const contained =
      options.allowedRoot === undefined
        ? undefined
        : containedCanonicalPath(path, options.allowedRoot, label);
    const securePath = contained?.path ?? path;
    fd = openSync(securePath, constants.O_RDONLY | requireNoFollowFlag(constants.O_NOFOLLOW));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new MemoryError(`${label} is not a regular file: ${path}`);
    if (contained !== undefined) {
      const pathStat = lstatSync(securePath);
      const rootStat = lstatSync(options.allowedRoot as string);
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        !sameIdentity(stat, pathStat) ||
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !sameIdentity(contained.root, rootStat) ||
        realpathSync(options.allowedRoot as string) !== contained.canonicalRoot
      ) {
        throw new MemoryError(`${label} path changed while opening: ${path}`);
      }
    }
    if (stat.size > maxBytes) {
      throw new MemoryError(`${label} exceeds ${String(maxBytes)} bytes: ${path}`);
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const bytesRead = readSync(fd, buffer, offset, maxBytes + 1 - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new MemoryError(`${label} exceeds ${String(maxBytes)} bytes: ${path}`);
    }
    if (contained !== undefined) {
      const pathStat = lstatSync(securePath);
      const rootStat = lstatSync(options.allowedRoot as string);
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        !sameIdentity(stat, pathStat) ||
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !sameIdentity(contained.root, rootStat) ||
        realpathSync(options.allowedRoot as string) !== contained.canonicalRoot
      ) {
        throw new MemoryError(`${label} path changed while reading: ${path}`);
      }
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, offset),
      );
    } catch (error) {
      throw new MemoryError(`${label} is not valid UTF-8: ${path}`, { cause: error });
    }
  } catch (error) {
    if (options.allowMissing === true && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(`failed to read ${label}: ${path}`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
