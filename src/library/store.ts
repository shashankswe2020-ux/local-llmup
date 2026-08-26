/**
 * Fail-closed filesystem persistence for library items. Agents live as
 * `~/.local-llmup/agents/<id>.md`; skills as `~/.local-llmup/skills/<id>/SKILL.md`
 * — the Claude Code / Codex layout. Reads open files with `O_NOFOLLOW`, bound
 * size, and reject group/other-writable files (an injected system prompt is a
 * tamper vector). Writes are atomic (staging file + rename) with owner-only
 * permissions. Listing is best-effort: an unreadable or malformed entry is
 * skipped rather than failing the whole catalog.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DIR_MODE, FILE_MODE, loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { parseDocument, serializeDocument } from "./frontmatter.js";
import {
  LIBRARY_ID_RE,
  LibraryItemSchema,
  MAX_BODY_BYTES,
  type LibraryItem,
  type LibraryKind,
} from "./schema.js";

/** Upper bound on a single document file (frontmatter + body). */
const MAX_DOC_BYTES = MAX_BODY_BYTES + 4 * 1024;

const O_NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

function kindDir(config: Config, kind: LibraryKind): string {
  return kind === "agent" ? config.agentsDir : config.skillsDir;
}

/** Absolute path of the document backing `id` for the given kind. */
function itemPath(config: Config, kind: LibraryKind, id: string): string {
  if (!LIBRARY_ID_RE.test(id)) {
    throw new ValidationError(`invalid library id: ${id.slice(0, 40)}`);
  }
  return kind === "agent"
    ? join(kindDir(config, kind), `${id}.md`)
    : join(kindDir(config, kind), id, "SKILL.md");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Securely read a document file, or `null` when absent. Throws when hostile. */
function readDocFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW_FLAG);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    if (code === "ELOOP") {
      throw new ValidationError(`refusing to read library document: ${path} is a symlink`, {
        cause: error,
      });
    }
    throw new ValidationError(`failed to read library document: ${path}`, { cause: error });
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new ValidationError(`refusing to read library document: ${path} is not a regular file`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new ValidationError(
        `refusing to read library document ${path}: group/other-writable`,
      );
    }
    const buffer = Buffer.alloc(MAX_DOC_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(fd, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_DOC_BYTES) {
      throw new ValidationError(`library document ${path} is too large (> ${MAX_DOC_BYTES} bytes)`);
    }
    return buffer.toString("utf8", 0, total);
  } finally {
    closeSync(fd);
  }
}

/** Resolve a raw document + id into a validated {@link LibraryItem}. */
function toItem(id: string, raw: string): LibraryItem {
  const { frontmatter, body } = parseDocument(raw);
  const skills = (frontmatter.skills ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => LIBRARY_ID_RE.test(entry))
    .slice(0, 50);
  const candidate = {
    id,
    name: (frontmatter.name ?? id).slice(0, 120),
    description: (frontmatter.description ?? "").slice(0, 500),
    enabled: frontmatter.enabled !== "false",
    body: body.slice(0, MAX_BODY_BYTES),
    skills,
  };
  return LibraryItemSchema.parse(candidate);
}

/** Enumerate ids present on disk for the given kind. */
function listIds(config: Config, kind: LibraryKind): string[] {
  const dir = kindDir(config, kind);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ValidationError(`failed to list library directory: ${dir}`, { cause: error });
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (kind === "agent") {
      if (!entry.endsWith(".md")) continue;
      const id = entry.slice(0, -3);
      if (LIBRARY_ID_RE.test(id)) ids.push(id);
    } else {
      if (!LIBRARY_ID_RE.test(entry)) continue;
      try {
        if (statSync(join(dir, entry)).isDirectory()) ids.push(entry);
      } catch {
        // Skip entries that vanish between readdir and stat.
      }
    }
  }
  return ids.sort();
}

/** List all readable items of a kind, skipping unreadable/malformed entries. */
export function listItems(config: Config, kind: LibraryKind): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const id of listIds(config, kind)) {
    try {
      const raw = readDocFile(itemPath(config, kind, id));
      if (raw !== null) items.push(toItem(id, raw));
    } catch {
      // Best-effort: a single hostile/corrupt document must not hide the rest.
    }
  }
  return items;
}

/** Read a single item, or `undefined` when it does not exist. */
export function readItem(
  config: Config,
  kind: LibraryKind,
  id: string,
): LibraryItem | undefined {
  const raw = readDocFile(itemPath(config, kind, id));
  return raw === null ? undefined : toItem(id, raw);
}

/** Whether an item already exists on disk. */
export function itemExists(config: Config, kind: LibraryKind, id: string): boolean {
  try {
    return readDocFile(itemPath(config, kind, id)) !== null;
  } catch {
    return true; // A hostile-but-present file still counts as taken.
  }
}

/** Serialize and atomically write an item. Creates parent directories 0700. */
export function writeItem(config: Config, kind: LibraryKind, item: LibraryItem): void {
  const validated = LibraryItemSchema.parse(item);
  const target = itemPath(config, kind, validated.id);
  const frontmatter: Record<string, string> = { name: validated.name };
  if (validated.description.length > 0) frontmatter.description = validated.description;
  frontmatter.enabled = validated.enabled ? "true" : "false";
  if (validated.skills.length > 0) frontmatter.skills = validated.skills.join(", ");
  const content = serializeDocument(frontmatter, validated.body);

  ensureDir(config.homeDir);
  ensureDir(config.stagingDir);
  if (kind === "skill") ensureDir(join(config.skillsDir, validated.id));
  else ensureDir(config.agentsDir);

  const tempFile = join(config.stagingDir, `library.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, content, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
    renameSync(tempFile, target);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Best-effort cleanup.
    }
    throw new ValidationError(`failed to write library document: ${target}`, { cause: error });
  }
}

/** Remove an item. For skills, removes its enclosing directory. */
export function deleteItem(config: Config, kind: LibraryKind, id: string): void {
  const target = itemPath(config, kind, id);
  try {
    if (kind === "skill") {
      rmSync(join(config.skillsDir, id), { recursive: true, force: true });
    } else {
      rmSync(target, { force: true });
    }
  } catch (error) {
    throw new ValidationError(`failed to delete library document: ${target}`, { cause: error });
  }
}

/** Convenience wrappers used by the service layer. */
export function listAgents(config: Config = loadConfig()): LibraryItem[] {
  return listItems(config, "agent");
}

export function listSkills(config: Config = loadConfig()): LibraryItem[] {
  return listItems(config, "skill");
}
