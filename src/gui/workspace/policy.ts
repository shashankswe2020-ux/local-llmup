/**
 * Path and content policy for read-only workspace access (task 32.5).
 *
 * The deny list is the security boundary: it always excludes secrets and VCS
 * internals even when a path is explicitly requested. Ignore rules are a
 * separate convenience layer that only trims noise from directory listings.
 */
import { ValidationError } from "../../errors.js";

const MAX_PATH_LENGTH = 1024;
const MAX_PATH_SEGMENTS = 40;

/** Directory/segment names that are never accessible (credentials, VCS, keys). */
const DENIED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config",
]);

/** Exact filenames that are never readable. */
const DENIED_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".dockercfg",
  "credentials",
]);

/** Filename prefixes that are never readable (e.g. `.env.local`). */
const DENIED_PREFIXES = [".env.", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

/** File extensions that are never readable (private keys/certs). */
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".asc"]);

/** Directory names hidden from listings as noise (not a security boundary). */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".staging",
  ".turbo",
]);

/**
 * Validate and normalize a workspace-relative path. Returns "" for the root.
 * Rejects NUL, backslashes, absolute/drive paths, and `.`/`..`/empty segments.
 */
export function normalizeRelativePath(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  if (raw.length > MAX_PATH_LENGTH) {
    throw new ValidationError("workspace path is too long");
  }
  if (raw.includes("\0")) {
    throw new ValidationError("workspace path contains a NUL byte");
  }
  if (raw.includes("\\")) {
    throw new ValidationError("workspace path must use '/' separators");
  }
  if (raw === "" || raw === ".") {
    return "";
  }
  if (raw.startsWith("/")) {
    throw new ValidationError("absolute workspace paths are not allowed");
  }
  if (/^[A-Za-z]:/u.test(raw)) {
    throw new ValidationError("drive-letter workspace paths are not allowed");
  }
  const segments = raw.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new ValidationError("workspace path is too deep");
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ValidationError(`invalid workspace path segment: ${JSON.stringify(segment)}`);
    }
  }
  return segments.join("/");
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** True when a normalized relative path must never be exposed. */
export function isDeniedPath(rel: string): boolean {
  if (rel === "") {
    return false;
  }
  const segments = rel.split("/");
  for (const segment of segments) {
    if (DENIED_SEGMENTS.has(segment)) {
      return true;
    }
  }
  const name = segments[segments.length - 1] ?? "";
  if (DENIED_FILENAMES.has(name)) {
    return true;
  }
  if (DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  return DENIED_EXTENSIONS.has(fileExtension(name));
}

/** True when a directory name is noise that listings should hide. */
export function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

/** Extensions whose contents are binary and are excluded from search/reads. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".flac",
  ".sqlite",
  ".db",
]);

/** Heuristic (extension-based) binary filter for listings; not a boundary. */
export function isProbablyBinaryPath(name: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(name));
}
