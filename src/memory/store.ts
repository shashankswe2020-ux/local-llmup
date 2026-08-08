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
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, sep } from "node:path";
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
    /**
     * Set when memory was captured against a backend that cannot embed, so
     * vectors are intentionally absent (honesty gate — never a fabricated index).
     */
    embeddingUnsupported: z.literal(true).optional(),
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

const MEMORY_SLUG_MAX_LENGTH = 128;
const MEMORY_SLUG_HASH_HEX_LENGTH = 16;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

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
  let slug = modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");

  if (process.platform === "win32") {
    const windowsNormalized = slug.replace(/[. ]+$/g, "");
    const deviceStem = windowsNormalized.split(".")[0] ?? "";
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(deviceStem)) {
      slug = `x-${windowsNormalized}`;
    } else {
      slug = windowsNormalized;
    }
  }

  if (slug.length === 0) {
    throw new ValidationError(`model id has no filesystem-safe slug: ${JSON.stringify(modelId)}`);
  }

  if (slug.length <= MEMORY_SLUG_MAX_LENGTH) {
    return slug;
  }

  const hash = createHash("sha256")
    .update(slug)
    .digest("hex")
    .slice(0, MEMORY_SLUG_HASH_HEX_LENGTH);
  const prefixMaxLength = MEMORY_SLUG_MAX_LENGTH - hash.length - 1;
  const prefix = slug.slice(0, prefixMaxLength).replace(/[-.]+$/, "");

  // Keep the slug bounded while preserving deterministic uniqueness for long ids.
  return prefix.length > 0 ? `${prefix}-${hash}` : hash;
}

/**
 * The absolute store directory for `modelId`, without creating or validating it.
 * `memorySlug` guarantees a single traversal-safe segment inside the memory
 * root, so this is a pure path derivation for callers (e.g. `migrate`) that need
 * a store path before the directory exists.
 */
export function memoryStoreDir(config: Config, modelId: string): string {
  return join(config.memoryDir, memorySlug(modelId));
}

function ensureDir(dir: string): void {
  const created: string[] = [];
  let current = dir;

  while (true) {
    try {
      statSync(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      created.push(current);
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  for (let index = created.length - 1; index >= 0; index -= 1) {
    const path = created[index];
    if (path === undefined) {
      continue;
    }
    try {
      mkdirSync(path, { mode: DIR_MODE });
      chmodSync(path, DIR_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

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
function assertWithinRoot(config: Config, dir: string, modelId: string): string {
  const rootReal = realpathSync(config.memoryDir);
  const dirReal = realpathSync(dir);
  if (!isWithin(rootReal, dirReal)) {
    throw new MemoryError(
      `memory store for ${stripControl(modelId)} resolves outside the memory root`,
    );
  }
  return dirReal;
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
  const unresolvedTarget = join(dir, META_FILE);

  try {
    writeFileSync(tempFile, json, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
  } catch (error) {
    tryUnlink(tempFile);
    throw new MemoryError(`failed to stage memory metadata: ${unresolvedTarget}`, { cause: error });
  }

  // Re-verify containment right before the link and write to the canonical
  // directory path that was just validated.
  const dirReal = assertWithinRoot(config, dir, modelId);
  const target = join(dirReal, META_FILE);

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
    verifyPerms(dir, DIR_MODE);
    verifyPerms(target, FILE_MODE);
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
  const unresolvedTarget = join(dir, META_FILE);

  try {
    writeFileSync(tempFile, json, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
    // Re-verify containment right before swapping the file into the store,
    // and use the validated canonical path as the replacement target.
    const dirReal = assertWithinRoot(config, dir, validated.modelId);
    const target = join(dirReal, META_FILE);
    renameSync(tempFile, target);
    verifyPerms(dirReal, DIR_MODE);
    verifyPerms(target, FILE_MODE);
  } catch (error) {
    tryUnlink(tempFile);
    throw new MemoryError(`failed to write memory metadata: ${unresolvedTarget}`, { cause: error });
  }
  return validated;
}
