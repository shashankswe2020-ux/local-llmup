/**
 * Per-model memory store: the on-disk home for a model's conversation history,
 * facts, and embeddings under `~/.local-llmup/memory/<slug>/`. This module owns
 * the store's *foundation* — deriving a filesystem-safe slug from a model id,
 * defending against traversal (both `..` in the id and symlinked store dirs),
 * and reading/writing a `schemaVersion`'d `meta.json` — so higher layers
 * (`capture`, `migrate`) can treat a store as an opened, validated handle.
 *
 * Safety invariants enforced here:
 * - A model id is slugged to a single path segment with no separators, no
 *   leading dots, and no way to escape the memory root.
 * - The resolved store directory's realpath must stay inside the memory root,
 *   re-checked immediately before the metadata write, so a planted symlink
 *   cannot redirect writes outside the home directory.
 * - Distinct model ids that slug to the same name never share a store: creation
 *   is a first-writer-wins atomic `link`, and the owning id recorded in
 *   `meta.json` makes any mismatch a hard error — even under concurrency.
 * - Directories are `0700` and files `0600`, re-applied via `chmod` and then
 *   verified with `stat` (fail-closed) so a permissive `umask` cannot widen them.
 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, sep } from "node:path";
import { z } from "zod";
import { DIR_MODE, FILE_MODE, type Config } from "../config.js";
import { MemoryError, ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";

/** Bumped when the on-disk memory layout changes incompatibly. */
export const MEMORY_SCHEMA_VERSION = 1 as const;

/** The embedding model + vector dimension a store's `embeddings/` were built with. */
const EmbeddingMetaSchema = z
  .object({
    /** Embedding model id (e.g. `nomic-embed-text`). */
    model: z.string().min(1),
    /** Vector dimension produced by that model. */
    dimension: z.number().int().positive(),
  })
  .strict();

/** Validated embedding descriptor recorded in a store's `meta.json`. */
export type EmbeddingMeta = z.infer<typeof EmbeddingMetaSchema>;

const MemoryMetaSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    /** The exact model id that owns this store; guards slug collisions. */
    modelId: z.string().min(1),
    /** ISO-8601 creation timestamp. */
    createdAt: z.string().min(1),
    /** Present once the store has an embedding index; fixes its vector space. */
    embedding: EmbeddingMetaSchema.optional(),
  })
  .strict();

/** Validated contents of a store's `meta.json`. */
export type MemoryMeta = z.infer<typeof MemoryMetaSchema>;

/** An opened, validated per-model memory store. */
export interface MemoryStore {
  /** The model id this store belongs to. */
  readonly modelId: string;
  /** Absolute path to the store directory. */
  readonly dir: string;
  /** Validated store metadata. */
  readonly meta: MemoryMeta;
}

const META_FILE = "meta.json";

/** The store metadata filename, exported so migration can stage/verify it. */
export const MEMORY_META_FILE = META_FILE;

/**
 * Derive a filesystem-safe, single-segment slug from a model id.
 *
 * Unsafe characters (including path separators) collapse to `-`, the result is
 * lowercased, and leading/trailing dots and dashes are stripped — so `../evil`
 * becomes `evil` and no slug can be a hidden file or a traversal segment. Throws
 * {@link ValidationError} when nothing safe remains.
 */
export function memorySlug(modelId: string): string {
  const slug = modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");

  if (slug.length === 0) {
    throw new ValidationError(`model id has no filesystem-safe slug: ${JSON.stringify(modelId)}`);
  }
  return slug;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Fail closed if `path` is not restricted to exactly `expected` owner-only bits. */
function verifyPerms(path: string, expected: number): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== expected) {
    throw new MemoryError(
      `refusing to use ${path}: permissions 0${mode.toString(8)} are not 0${expected.toString(8)}`,
    );
  }
}

/** Assert the store dir's realpath is inside the (realpath'd) memory root. */
function assertWithinRoot(config: Config, dir: string, modelId: string): void {
  const rootReal = realpathSync(config.memoryDir);
  const dirReal = realpathSync(dir);
  if (!isWithin(rootReal, dirReal)) {
    throw new MemoryError(
      `memory store for ${stripControl(modelId)} resolves outside the memory root`,
    );
  }
}

/**
 * Resolve (creating if needed) the store directory for `slug`. A symlink planted
 * at the slug that points outside the memory root is rejected.
 */
function resolveStoreDir(config: Config, slug: string, modelId: string): string {
  ensureDir(config.memoryDir);
  const dir = join(config.memoryDir, slug);
  try {
    realpathSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      ensureDir(dir);
    } else {
      throw new MemoryError(`failed to resolve memory store for ${stripControl(modelId)}`, {
        cause: error,
      });
    }
  }
  assertWithinRoot(config, dir, modelId);
  return dir;
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup; ignore if the temp file is already gone.
  }
}

/**
 * Create `meta.json` for a brand-new store, first-writer-wins. The metadata is
 * written to a temp file and `link`ed into place: `link` is atomic and fails
 * with `EEXIST` if the target already exists, so a concurrent creator can never
 * silently clobber another model's store, and readers never observe a partially
 * written file. Returns `"exists"` when this caller lost the create race.
 */
function createMeta(
  config: Config,
  dir: string,
  modelId: string,
  meta: MemoryMeta,
): "created" | "exists" {
  ensureDir(config.stagingDir);
  const json = `${JSON.stringify(meta, null, 2)}\n`;
  const tempFile = join(config.stagingDir, `meta.${process.pid}.${randomUUID()}.tmp`);
  const target = join(dir, META_FILE);

  try {
    writeFileSync(tempFile, json, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
  } catch (error) {
    tryUnlink(tempFile);
    throw new MemoryError(`failed to stage memory metadata: ${target}`, { cause: error });
  }

  // Re-verify containment right before the link, narrowing the window between
  // the earlier realpath check and this write.
  assertWithinRoot(config, dir, modelId);

  try {
    linkSync(tempFile, target);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "exists";
    }
    throw new MemoryError(`failed to write memory metadata: ${target}`, { cause: error });
  } finally {
    tryUnlink(tempFile);
  }
}

function parseMeta(raw: string, target: string, modelId: string): MemoryMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MemoryError(`memory metadata is not valid JSON: ${target}`, { cause: error });
  }

  const result = MemoryMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new MemoryError(`memory metadata failed validation: ${target}`, { cause: result.error });
  }

  // A distinct model id that slugs to this directory must never inherit another
  // model's memory — that would silently cross-contaminate the two histories.
  if (result.data.modelId !== modelId) {
    throw new MemoryError(
      `memory slug collision: ${target} belongs to ${stripControl(result.data.modelId)}, not ${stripControl(modelId)}`,
    );
  }
  return result.data;
}

function loadOrCreateMeta(config: Config, dir: string, modelId: string): MemoryMeta {
  const target = join(dir, META_FILE);

  // Two passes at most: create → (lost race) → re-read the winner's metadata.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    try {
      raw = readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const meta: MemoryMeta = {
          schemaVersion: MEMORY_SCHEMA_VERSION,
          modelId,
          createdAt: new Date().toISOString(),
        };
        if (createMeta(config, dir, modelId, meta) === "created") {
          verifyPerms(dir, DIR_MODE);
          verifyPerms(target, FILE_MODE);
          return meta;
        }
        continue; // Lost the create race; re-read the winner's metadata.
      }
      throw new MemoryError(`failed to read memory metadata: ${target}`, { cause: error });
    }
    return parseMeta(raw, target, modelId);
  }

  throw new MemoryError(`failed to initialize memory metadata: ${target}`);
}

/**
 * Open (creating on first use) the memory store for `modelId`. Validates and
 * enforces every store safety invariant; throws {@link ValidationError} for an
 * unusable id and {@link MemoryError} for a corrupt store, a slug collision, or
 * a traversal attempt.
 */
export function openMemoryStore(config: Config, modelId: string): MemoryStore {
  const slug = memorySlug(modelId);
  const dir = resolveStoreDir(config, slug, modelId);
  const meta = loadOrCreateMeta(config, dir, modelId);
  return { modelId, dir, meta };
}

/**
 * Read and validate the current on-disk `meta.json` for an opened store. Unlike
 * {@link openMemoryStore}, this never creates the file — the store must already
 * exist — so callers can observe writes made since the store was opened.
 */
export function readMemoryMeta(dir: string, modelId: string): MemoryMeta {
  const target = join(dir, META_FILE);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error) {
    throw new MemoryError(`failed to read memory metadata: ${target}`, { cause: error });
  }
  return parseMeta(raw, target, modelId);
}

/**
 * Atomically overwrite a store's `meta.json` with `meta`. Intended for updating
 * an existing store (e.g. recording its embedding model) by the single lock
 * holder, so a temp-file + `rename` swap is the correct atomic replacement.
 */
export function writeMemoryMeta(config: Config, dir: string, meta: MemoryMeta): MemoryMeta {
  const validated = MemoryMetaSchema.parse(meta);
  ensureDir(config.stagingDir);
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  const tempFile = join(config.stagingDir, `meta.${process.pid}.${randomUUID()}.tmp`);
  const target = join(dir, META_FILE);

  try {
    writeFileSync(tempFile, json, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
    // Re-verify containment right before swapping the file into the store.
    assertWithinRoot(config, dir, validated.modelId);
    renameSync(tempFile, target);
  } catch (error) {
    tryUnlink(tempFile);
    throw new MemoryError(`failed to write memory metadata: ${target}`, { cause: error });
  }

  verifyPerms(target, FILE_MODE);
  return validated;
}
