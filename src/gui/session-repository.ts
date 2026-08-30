/**
 * Persistent, owner-only store for GUI chat sessions (task 32.4).
 *
 * Gate 1 decisions encoded here:
 * - Location: `~/.local-llmup/gui-sessions/` (0700), one `<uuid>.json` file per
 *   session (0600). Separate from per-model memory stores; extracted-memory
 *   semantics are untouched.
 * - Schema: versioned {@link SessionDoc} at {@link GUI_SESSION_SCHEMA_VERSION}.
 * - Retention: bounded to {@link MAX_SESSIONS} sessions and
 *   {@link MAX_MESSAGES_PER_SESSION} messages per session (oldest messages drop).
 *   Archive is a soft flag; delete removes the file; export is a plain read.
 * - Recovery: run state is never persisted, so a restart never restores an
 *   interrupted run as active — the store only holds completed conversation.
 *
 * Every read is bounded, no-follow, containment-checked, and schema-validated,
 * so corrupt, oversized, symlinked, or wrong-version files fail closed.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { DIR_MODE, FILE_MODE, type Config } from "../config.js";
import { LocalLlmupError, ValidationError } from "../errors.js";
import { readBoundedUtf8File } from "../memory/bounded-read.js";
import { stripControl } from "../sanitize.js";
import { sanitizeGuiText } from "./text-sanitize.js";

/** Bumped when the on-disk session layout changes incompatibly. */
export const GUI_SESSION_SCHEMA_VERSION = 1;

const MAX_SESSIONS = 500;
const MAX_MESSAGES_PER_SESSION = 2000;
const MAX_MESSAGE_CHARS = 32 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;
const MAX_SEARCH_RESULTS = 50;
const DERIVED_TITLE_CHARS = 60;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Raised on an optimistic-revision mismatch. Maps to HTTP 409. */
export class SessionConflictError extends LocalLlmupError {
  constructor(message = "session was modified by another writer") {
    super(message, "SESSION_CONFLICT");
    this.name = "SessionConflictError";
  }
}

const RoleSchema = z.enum(["user", "assistant", "system"]);

/** Auditable manifest of context attached to a message (tasks 32.6 / 32.7). */
const AttachmentSchema = z.object({
  kind: z.enum(["file", "terminal", "diagnostics", "git"]).optional(),
  label: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1024).optional(),
  hash: z.string().min(1).max(128),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  included: z.boolean(),
  range: z
    .object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
    .optional(),
});
export type StoredAttachment = z.infer<typeof AttachmentSchema>;

const StoredMessageSchema = z.object({
  role: RoleSchema,
  content: z.string().max(MAX_MESSAGE_CHARS),
  at: z.string().min(1).max(40),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

const SessionDocSchema = z.object({
  schemaVersion: z.literal(GUI_SESSION_SCHEMA_VERSION),
  id: z.string().regex(ID_RE),
  title: z.string().max(MAX_TITLE_CHARS),
  createdAt: z.string().min(1).max(40),
  updatedAt: z.string().min(1).max(40),
  revision: z.number().int().nonnegative(),
  archived: z.boolean(),
  messages: z.array(StoredMessageSchema).max(MAX_MESSAGES_PER_SESSION),
});
export type SessionDoc = z.infer<typeof SessionDocSchema>;

/** Lightweight session header returned by listing and mutation APIs. */
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly archived: boolean;
  readonly messageCount: number;
}

export interface ListOptions {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly includeArchived?: boolean | undefined;
}

export interface MessagePage {
  readonly messages: readonly StoredMessage[];
  readonly nextCursor: string | null;
}

export interface SessionRepositoryDeps {
  readonly now?: (() => Date) | undefined;
}

function toSummary(doc: SessionDoc): SessionSummary {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    revision: doc.revision,
    archived: doc.archived,
    messageCount: doc.messages.length,
  };
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError("invalid cursor");
  }
  return parsed;
}

export class SessionRepository {
  private readonly dir: string;
  private readonly stagingDir: string;
  private readonly now: () => Date;

  constructor(private readonly config: Config, deps: SessionRepositoryDeps = {}) {
    this.dir = config.guiSessionsDir;
    this.stagingDir = config.stagingDir;
    this.now = deps.now ?? (() => new Date());
  }

  /** Create a new empty session. Fails closed once {@link MAX_SESSIONS} exist. */
  create(title?: string): SessionSummary {
    if (this.sessionFiles().length >= MAX_SESSIONS) {
      throw new ValidationError(`session limit reached (${String(MAX_SESSIONS)})`);
    }
    const stamp = this.timestamp();
    const doc: SessionDoc = {
      schemaVersion: GUI_SESSION_SCHEMA_VERSION,
      id: randomUUID(),
      title: this.cleanTitle(title) || "New chat",
      createdAt: stamp,
      updatedAt: stamp,
      revision: 0,
      archived: false,
      messages: [],
    };
    this.writeDoc(doc);
    return toSummary(doc);
  }

  /** List session summaries, newest first, cursor-paginated and bounded. */
  list(options: ListOptions = {}): { sessions: readonly SessionSummary[]; nextCursor: string | null } {
    const limit = boundedLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = parseOffsetCursor(options.cursor);
    const summaries: SessionSummary[] = [];
    for (const id of this.sessionFiles()) {
      const doc = this.tryReadDoc(id);
      if (doc === undefined) {
        continue; // corrupt/unsafe entries are skipped, never surfaced
      }
      if (doc.archived && options.includeArchived !== true) {
        continue;
      }
      summaries.push(toSummary(doc));
    }
    summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1));
    const page = summaries.slice(offset, offset + limit);
    const nextCursor = offset + limit < summaries.length ? String(offset + limit) : null;
    return { sessions: page, nextCursor };
  }

  /** Read a full session document, or `undefined` when it does not exist. */
  get(id: string): SessionDoc | undefined {
    return this.readDoc(id, true);
  }

  /** Read a bounded, cursor-paginated page of a session's messages. */
  readMessages(
    id: string,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): MessagePage {
    const doc = this.requireDoc(id);
    const limit = boundedLimit(options.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    const offset = parseOffsetCursor(options.cursor);
    const messages = doc.messages.slice(offset, offset + limit);
    const nextCursor = offset + limit < doc.messages.length ? String(offset + limit) : null;
    return { messages, nextCursor };
  }

  /** Append one message, bumping the revision and enforcing retention. */
  append(
    id: string,
    message: { role: StoredMessage["role"]; content: string; attachments?: readonly StoredAttachment[] },
    options: { expectedRevision?: number } = {},
  ): SessionSummary {
    const doc = this.requireDoc(id);
    this.assertRevision(doc, options.expectedRevision);
    const stored: StoredMessage = {
      role: message.role,
      content: sanitizeGuiText(message.content).slice(0, MAX_MESSAGE_CHARS),
      at: this.timestamp(),
      ...(message.attachments !== undefined && message.attachments.length > 0
        ? { attachments: message.attachments.slice(0, 20) }
        : {}),
    };
    const messages = [...doc.messages, stored].slice(-MAX_MESSAGES_PER_SESSION);
    const title =
      doc.title === "New chat" && message.role === "user" && stored.content.trim().length > 0
        ? this.cleanTitle(stored.content.slice(0, DERIVED_TITLE_CHARS))
        : doc.title;
    const next: SessionDoc = {
      ...doc,
      title: title || doc.title,
      messages,
      revision: doc.revision + 1,
      updatedAt: this.timestamp(),
    };
    this.writeDoc(next);
    return toSummary(next);
  }

  /** Rename a session. */
  rename(id: string, title: string, options: { expectedRevision?: number } = {}): SessionSummary {
    const doc = this.requireDoc(id);
    this.assertRevision(doc, options.expectedRevision);
    const cleaned = this.cleanTitle(title);
    if (cleaned.length === 0) {
      throw new ValidationError("session title must not be empty");
    }
    const next: SessionDoc = { ...doc, title: cleaned, revision: doc.revision + 1, updatedAt: this.timestamp() };
    this.writeDoc(next);
    return toSummary(next);
  }

  /** Archive or unarchive a session. */
  setArchived(id: string, archived: boolean): SessionSummary {
    const doc = this.requireDoc(id);
    const next: SessionDoc = { ...doc, archived, revision: doc.revision + 1, updatedAt: this.timestamp() };
    this.writeDoc(next);
    return toSummary(next);
  }

  /** Permanently delete a session file. Missing sessions are a no-op. */
  remove(id: string): void {
    try {
      unlinkSync(this.pathFor(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ValidationError(`failed to delete session: ${id}`);
      }
    }
  }

  /** Case-insensitive search across titles and message content, bounded. */
  search(
    query: string,
    options: { limit?: number | undefined; includeArchived?: boolean | undefined } = {},
  ): readonly { summary: SessionSummary; snippet: string }[] {
    const needle = stripControl(query).trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }
    const limit = boundedLimit(options.limit, MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const matches: { summary: SessionSummary; snippet: string }[] = [];
    for (const id of this.sessionFiles()) {
      const doc = this.tryReadDoc(id);
      if (doc === undefined || (doc.archived && options.includeArchived !== true)) {
        continue;
      }
      const snippet = this.matchSnippet(doc, needle);
      if (snippet !== null) {
        matches.push({ summary: toSummary(doc), snippet });
      }
    }
    matches.sort((a, b) => (a.summary.updatedAt < b.summary.updatedAt ? 1 : -1));
    return matches.slice(0, limit);
  }

  private matchSnippet(doc: SessionDoc, needle: string): string | null {
    if (doc.title.toLowerCase().includes(needle)) {
      return doc.title;
    }
    for (const message of doc.messages) {
      const lower = message.content.toLowerCase();
      const at = lower.indexOf(needle);
      if (at !== -1) {
        const start = Math.max(0, at - 24);
        return message.content.slice(start, start + 80);
      }
    }
    return null;
  }

  private assertRevision(doc: SessionDoc, expected: number | undefined): void {
    if (expected !== undefined && expected !== doc.revision) {
      throw new SessionConflictError();
    }
  }

  private cleanTitle(title: string | undefined): string {
    return stripControl(title ?? "").replace(/\s+/gu, " ").trim().slice(0, MAX_TITLE_CHARS);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private pathFor(id: string): string {
    if (!ID_RE.test(id)) {
      throw new ValidationError(`invalid session id: ${stripControl(id).slice(0, 64)}`);
    }
    return join(this.dir, `${id}.json`);
  }

  private sessionFiles(): string[] {
    this.ensureDir(this.dir);
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const id = entry.slice(0, -".json".length);
      if (ID_RE.test(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  private requireDoc(id: string): SessionDoc {
    const doc = this.readDoc(id, false);
    if (doc === undefined) {
      throw new ValidationError(`session not found: ${id}`);
    }
    return doc;
  }

  /** Read + validate one session, failing closed on any integrity problem. */
  private readDoc(id: string, allowMissing: boolean): SessionDoc | undefined {
    const path = this.pathFor(id);
    this.ensureDir(this.dir);
    const raw = readBoundedUtf8File(path, "gui session", MAX_FILE_BYTES, {
      allowMissing,
      allowedRoot: this.dir,
    });
    if (raw === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError(`corrupt session file: ${id}`);
    }
    const result = SessionDocSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(`invalid session file: ${id}`);
    }
    if (result.data.id !== id) {
      throw new ValidationError(`session id mismatch: ${id}`);
    }
    return result.data;
  }

  /** Like {@link readDoc} but returns `undefined` on any failure (for listing). */
  private tryReadDoc(id: string): SessionDoc | undefined {
    try {
      return this.readDoc(id, true);
    } catch {
      return undefined;
    }
  }

  private writeDoc(doc: SessionDoc): void {
    const validated = SessionDocSchema.parse(doc);
    this.ensureDir(this.dir);
    this.ensureDir(this.stagingDir);
    const json = `${JSON.stringify(validated, null, 2)}\n`;
    const tempFile = join(this.stagingDir, `gui-session.${process.pid}.${randomUUID()}.tmp`);
    const target = this.pathFor(validated.id);
    try {
      writeFileSync(tempFile, json, { mode: FILE_MODE });
      chmodSync(tempFile, FILE_MODE);
      renameSync(tempFile, target);
    } catch (error) {
      try {
        unlinkSync(tempFile);
      } catch {
        // best effort cleanup
      }
      throw new ValidationError(`failed to write session: ${validated.id}`, { cause: error });
    }
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ValidationError(`session file is not a regular file: ${validated.id}`);
    }
    chmodSync(target, FILE_MODE);
  }

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
  }
}
