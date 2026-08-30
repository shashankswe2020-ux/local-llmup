/**
 * Read-only workspace capability service (task 32.5).
 *
 * A registered root grants a bounded, opaque capability id; the raw path is
 * only returned once (for confirmation) and never round-trips from the browser
 * afterward. Every read is deny-checked, containment-checked against the
 * canonical root, no-follow, size-bounded, and UTF-8 validated, so traversal,
 * symlink, secret, binary, and oversized inputs fail closed.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, basename, dirname } from "node:path";
import { ValidationError } from "../../errors.js";
import { readBoundedUtf8File } from "../../memory/bounded-read.js";
import {
  isDeniedPath,
  isIgnoredDirectory,
  isProbablyBinaryPath,
  normalizeRelativePath,
} from "./policy.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TREE_ENTRIES = 2000;
const MAX_ROOTS = 8;
const MAX_SEARCH_SCAN = 20000;
const MAX_SEARCH_MATCHES = 500;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const GIT_TIMEOUT_MS = 5000;
const MAX_GIT_OUTPUT_CHARS = 100 * 1024;

/** Public handle for a registered workspace root. */
export interface WorkspaceRoot {
  readonly id: string;
  readonly name: string;
}

export interface TreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir";
  readonly size?: number;
}

export interface SearchResult {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export interface SearchPage {
  readonly results: readonly SearchResult[];
  readonly nextCursor: string | null;
  readonly scanTruncated: boolean;
}

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** An immutable, bounded snapshot of a file (or line range) at read time. */
export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
  readonly size: number;
  readonly truncated: boolean;
  readonly range?: LineRange;
}

export type GitMode = "status" | "diff";

/** A read-only Git snapshot, or an honest reason it is unavailable. */
export interface GitSnapshot {
  readonly kind: "git";
  readonly mode: GitMode;
  readonly label: string;
  readonly available: boolean;
  readonly content: string;
  readonly hash: string;
  readonly size: number;
  readonly truncated: boolean;
  readonly reason?: "git-not-found" | "not-a-repository" | "git-failed" | "no-changes";
}

/** Result of one invocation of the injected Git process seam. */
export interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly failedToStart: boolean;
}

/** Runs `git` with a fixed argument vector and no shell. Injectable for tests. */
export type GitRunner = (args: readonly string[], cwd: string) => GitRunResult;

function defaultGitRunner(args: readonly string[], cwd: string): GitRunResult {
  const result = spawnSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_CHARS * 4,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    code: result.status,
    failedToStart: result.error !== undefined,
  };
}

export class WorkspaceService {
  private readonly roots = new Map<string, string>();
  private readonly runGit: GitRunner;

  constructor(deps: { runGit?: GitRunner } = {}) {
    this.runGit = deps.runGit ?? defaultGitRunner;
  }

  /** Register a directory and return an opaque capability id. */
  registerRoot(inputPath: unknown): WorkspaceRoot {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      throw new ValidationError("a workspace path is required");
    }
    if (this.roots.size >= MAX_ROOTS) {
      throw new ValidationError("too many workspace roots are registered");
    }
    const absolute = resolve(inputPath.trim());
    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch {
      throw new ValidationError("workspace path does not exist");
    }
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ValidationError("workspace root must be a directory");
    }
    const id = randomUUID();
    this.roots.set(id, canonical);
    return { id, name: basename(canonical) || canonical };
  }

  revoke(id: string): void {
    this.roots.delete(id);
  }

  has(id: string): boolean {
    return this.roots.has(id);
  }

  /** List one directory level, hiding denied, ignored, and symlinked entries. */
  tree(id: string, subdir: unknown = ""): { path: string; entries: readonly TreeEntry[] } {
    const root = this.rootFor(id);
    const rel = normalizeRelativePath(subdir);
    if (rel !== "" && isDeniedPath(rel)) {
      throw new ValidationError("path is not accessible");
    }
    const dir = this.secureDir(root, rel);
    const entries: TreeEntry[] = [];
    for (const name of readdirSync(dir)) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        break;
      }
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let childStat;
      try {
        childStat = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (childStat.isSymbolicLink()) {
        continue; // symlinks are never listed
      }
      if (childStat.isDirectory()) {
        if (isIgnoredDirectory(name) || isDeniedPath(childRel)) {
          continue;
        }
        entries.push({ name, path: childRel, type: "dir" });
      } else if (childStat.isFile() && !isDeniedPath(childRel)) {
        entries.push({ name, path: childRel, type: "file", size: childStat.size });
      }
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name < b.name ? -1 : 1));
    return { path: rel, entries };
  }

  /**
   * Recursively find files whose relative path matches `query` (case-
   * insensitive substring). The walk is bounded (scan + match caps), excludes
   * denied/ignored/symlinked/binary entries, and paginates over a stable,
   * sorted result set with an opaque numeric cursor.
   */
  search(
    id: string,
    query: unknown,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): SearchPage {
    const root = this.rootFor(id);
    const needle = (typeof query === "string" ? query : "").trim().toLowerCase().slice(0, 256);
    const limit = boundedLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const offset = parseOffsetCursor(options.cursor);

    const matches: SearchResult[] = [];
    let scanned = 0;
    let scanTruncated = false;
    const stack: string[] = [""];
    while (stack.length > 0) {
      if (matches.length >= MAX_SEARCH_MATCHES || scanned >= MAX_SEARCH_SCAN) {
        scanTruncated = true;
        break;
      }
      const rel = stack.pop() as string;
      let dir: string;
      try {
        dir = this.secureDir(root, rel);
      } catch {
        continue; // a directory that vanished or turned into a symlink mid-walk
      }
      for (const name of readdirSync(dir)) {
        if (++scanned >= MAX_SEARCH_SCAN) {
          scanTruncated = true;
          break;
        }
        const childRel = rel === "" ? name : `${rel}/${name}`;
        let childStat;
        try {
          childStat = lstatSync(join(dir, name));
        } catch {
          continue;
        }
        if (childStat.isSymbolicLink()) {
          continue;
        }
        if (childStat.isDirectory()) {
          if (!isIgnoredDirectory(name) && !isDeniedPath(childRel)) {
            stack.push(childRel);
          }
        } else if (childStat.isFile() && !isDeniedPath(childRel) && !isProbablyBinaryPath(name)) {
          if (needle === "" || childRel.toLowerCase().includes(needle)) {
            matches.push({ name, path: childRel, size: childStat.size });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              scanTruncated = true;
              break;
            }
          }
        }
      }
    }

    matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const page = matches.slice(offset, offset + limit);
    const nextCursor = offset + limit < matches.length ? String(offset + limit) : null;
    return { results: page, nextCursor, scanTruncated };
  }

  /** Read a bounded, hashed snapshot of a file, optionally a line range. */
  read(id: string, filePath: unknown, range?: LineRange | undefined): FileSnapshot {
    const root = this.rootFor(id);
    const rel = normalizeRelativePath(filePath);
    if (rel === "") {
      throw new ValidationError("a file path is required");
    }
    if (isDeniedPath(rel)) {
      throw new ValidationError("file is not accessible");
    }
    let content: string | undefined;
    try {
      content = readBoundedUtf8File(join(root, rel), "workspace file", MAX_FILE_BYTES, {
        allowedRoot: root,
        allowMissing: true,
      });
    } catch (error) {
      // Convert bounded-read failures (symlink, escape, oversized, non-UTF-8)
      // into a boundary validation error so reads always fail closed.
      throw new ValidationError(error instanceof Error ? error.message : "file is not accessible");
    }
    if (content === undefined) {
      throw new ValidationError("file not found");
    }
    if (range === undefined) {
      return this.snapshot(rel, content, false, undefined);
    }
    const lines = content.split("\n");
    const startLine = Math.max(1, Math.floor(range.startLine));
    const endLine = Math.min(lines.length, Math.max(startLine, Math.floor(range.endLine)));
    const sliced = lines.slice(startLine - 1, endLine).join("\n");
    return this.snapshot(rel, sliced, false, { startLine, endLine });
  }

  /**
   * Read a bounded, read-only Git snapshot for a registered root. Uses a fixed
   * argument vector with no shell/hooks, a timeout, and an output cap. Missing
   * Git, a non-repository root, and other failures return honest unavailable
   * states rather than throwing.
   */
  gitContext(id: string, mode: GitMode): GitSnapshot {
    const root = this.rootFor(id);
    const label = `git ${mode}`;
    const args =
      mode === "status"
        ? ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]
        : ["-C", root, "--no-pager", "diff", "--no-color"];
    const result = this.runGit(args, root);
    if (result.failedToStart) {
      return this.gitUnavailable(mode, label, "git-not-found");
    }
    if (result.code !== 0) {
      const reason = /not a git repository/iu.test(result.stderr)
        ? "not-a-repository"
        : "git-failed";
      return this.gitUnavailable(mode, label, reason);
    }
    let content = result.stdout;
    const truncated = content.length > MAX_GIT_OUTPUT_CHARS;
    if (truncated) {
      content = content.slice(0, MAX_GIT_OUTPUT_CHARS);
    }
    if (content.trim().length === 0) {
      return this.gitUnavailable(mode, label, "no-changes");
    }
    return {
      kind: "git",
      mode,
      label,
      available: true,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content, "utf8"),
      truncated,
    };
  }

  private gitUnavailable(mode: GitMode, label: string, reason: GitSnapshot["reason"]): GitSnapshot {
    return {
      kind: "git",
      mode,
      label,
      available: false,
      content: "",
      hash: "",
      size: 0,
      truncated: false,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private snapshot(
    path: string,
    content: string,
    truncated: boolean,
    range: LineRange | undefined,
  ): FileSnapshot {
    const hash = createHash("sha256").update(content).digest("hex");
    return {
      path,
      content,
      hash,
      size: Buffer.byteLength(content, "utf8"),
      truncated,
      ...(range !== undefined ? { range } : {}),
    };
  }

  /** Canonical root path for a registered workspace; throws if unknown. */
  rootPath(id: string): string {
    return this.rootFor(id);
  }

  /**
   * Resolve a writable target inside the root, validating parent containment
   * and rejecting symlinks on the final component. The parent directory must
   * exist; the target itself may or may not (create vs. update).
   */
  resolveContainedPath(id: string, filePath: unknown): { root: string; abs: string; rel: string } {
    const root = this.rootFor(id);
    const rel = normalizeRelativePath(filePath);
    if (rel === "" || isDeniedPath(rel)) {
      throw new ValidationError("path is not writable");
    }
    const target = join(root, rel);
    let canonicalParent: string;
    try {
      canonicalParent = realpathSync(dirname(target));
    } catch {
      throw new ValidationError("parent directory does not exist");
    }
    const fromRoot = relative(root, canonicalParent);
    if (canonicalParent !== root && (fromRoot.startsWith("..") || isAbsolute(fromRoot))) {
      throw new ValidationError("path escapes the workspace");
    }
    const abs = join(canonicalParent, basename(target));
    try {
      if (lstatSync(abs).isSymbolicLink()) {
        throw new ValidationError("symlinks are not writable");
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      // ENOENT: the target does not exist yet (a create); that is fine.
    }
    return { root, abs, rel };
  }

  private rootFor(id: string): string {
    const root = this.roots.get(id);
    if (root === undefined) {
      throw new ValidationError("unknown workspace");
    }
    return root;
  }

  /** Resolve a directory within the root, rejecting symlinks and escapes. */
  private secureDir(root: string, rel: string): string {
    const target = rel === "" ? root : join(root, rel);
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      throw new ValidationError("path not found");
    }
    if (stat.isSymbolicLink()) {
      throw new ValidationError("symlinks are not allowed");
    }
    if (!stat.isDirectory()) {
      throw new ValidationError("not a directory");
    }
    const canonical = realpathSync(target);
    const fromRoot = relative(root, canonical);
    if (canonical !== root && (fromRoot.startsWith("..") || isAbsolute(fromRoot))) {
      throw new ValidationError("path escapes the workspace");
    }
    return canonical;
  }
}

/** Clamp an optional page size into `[1, max]`, defaulting when absent. */
function boundedLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

/** Parse an opaque numeric offset cursor; unparseable cursors start at 0. */
function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
