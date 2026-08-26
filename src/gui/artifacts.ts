/** Safe serving of generated chat artifacts (images / graphs) to the GUI. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "../errors.js";

/** Cap on a single served image (matplotlib PNGs are tens of KB). */
export const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * Validate a requested artifact name to a single image file basename directly
 * inside `artifactsDir`. Rejects any path separators, traversal, dotfiles, and
 * unknown extensions so only generated images can ever be read.
 */
export function resolveArtifactPath(artifactsDir: string, name: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(name);
    } catch {
      throw new ValidationError(`invalid artifact name: ${name.slice(0, 40)}`);
    }
  })();

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/iu.test(decoded)) {
    throw new ValidationError(`invalid artifact name: ${decoded.slice(0, 40)}`);
  }

  const baseDir = path.resolve(artifactsDir);
  const candidate = path.resolve(baseDir, decoded);
  const relative = path.relative(baseDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new ValidationError(`path traversal refused: ${decoded.slice(0, 40)}`);
  }
  return candidate;
}

/** Read a validated artifact image, or throw {@link ValidationError}. */
export async function readArtifactImage(
  artifactsDir: string,
  name: string,
): Promise<{ readonly content: Buffer; readonly contentType: string }> {
  const resolved = resolveArtifactPath(artifactsDir, name);
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new ValidationError(`artifact is not a regular file: ${name.slice(0, 40)}`);
  }
  if (info.size > MAX_ARTIFACT_BYTES) {
    throw new ValidationError(`artifact too large: ${name.slice(0, 40)}`);
  }
  const content = await readFile(resolved);
  const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  return { content, contentType };
}
