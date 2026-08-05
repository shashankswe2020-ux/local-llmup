/**
 * Memory migration logic: the pure, disk-free half of `local-llmup migrate`.
 *
 * Given a source model's in-memory store contents and a target model's context
 * window + embedding space, this module computes a {@link MigrationPlan}: the
 * turns to carry (summarizing/truncating the oldest when the target context is
 * smaller — never dropping the system prompt or facts), the facts carried
 * byte-identically, and the embedding index either reused as-is or re-embedded
 * for the target's vector space. Staging the plan to disk atomically is the
 * separate concern of the staging half (see T26).
 *
 * `migrate` reaches the backend only through injected callbacks — a
 * {@link Summarizer} (target model if running, else a deterministic fallback)
 * and a {@link MigrationEmbedder} — so this module never imports an adapter and
 * stays trivially testable.
 *
 * The staging half ({@link writeMigration}) materializes a plan onto disk with
 * crash safety: the full target store is built in a same-filesystem staging
 * directory, swapped into place with a single `rename`, verified, and only then
 * — under `--move` — is the source deleted. Any failure leaves both the source
 * and the original target intact.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, basename, join, resolve, sep } from "node:path";
import { z } from "zod";
import { DIR_MODE, FILE_MODE, type Config } from "../config.js";
import { MemoryError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import {
  CHUNKS_FILE,
  CONVERSATION_FILE,
  EMBEDDINGS_DIR,
  FACTS_FILE,
  VECTORS_FILE,
} from "./capture.js";
import {
  MEMORY_META_FILE,
  MEMORY_SCHEMA_VERSION,
  memoryStoreDir,
  readMemoryMeta,
  type EmbeddingMeta,
  type MemoryMeta,
} from "./store.js";

/** Persona filename in a store; written only when the source has a system prompt. */
const SYSTEM_FILE = "system.md";

/** One conversation turn (as stored in `conversation.jsonl`). */
export interface ConversationTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly ts: string;
}

/** A source chunk of embedded text, linked to its vector by `id`. */
export interface EmbeddingChunk {
  readonly id: string;
  readonly text: string;
  readonly ts: string;
}

/** A source embedding vector, linked to its chunk by `id`. */
export interface EmbeddingVector {
  readonly id: string;
  readonly vector: readonly number[];
}

/** The source store's embedding index plus the model/dimension it was built with. */
export interface SourceEmbedding {
  readonly meta: EmbeddingMeta;
  readonly chunks: readonly EmbeddingChunk[];
  readonly vectors: readonly EmbeddingVector[];
}

/** The source model's loaded, validated memory contents. */
export interface SourceMemory {
  readonly turns: readonly ConversationTurn[];
  /** `system.md` content, or `undefined` when the source has no persona. */
  readonly systemPrompt: string | undefined;
  /** Raw `facts.json` bytes, carried through unchanged (`""` when absent). */
  readonly factsText: string;
  /** The source embedding index, or `undefined` when none was captured. */
  readonly embedding: SourceEmbedding | undefined;
}

/**
 * Produces embeddings in the target model's vector space. Wired by the command
 * to the backend adapter's `embed` with the target's embedding model; the
 * declared {@link dimension} is that space's fixed width.
 */
export interface MigrationEmbedder {
  readonly model: string;
  readonly dimension: number;
  embed(inputs: readonly string[]): Promise<{
    readonly vectors: readonly (readonly number[])[];
    readonly dimension: number;
  }>;
}

/** Summarizes overflow (oldest) turns into a compact prior-context string. */
export type Summarizer = (turns: readonly ConversationTurn[]) => Promise<string>;

/** Inputs to {@link planMigration}. */
export interface MigrationInput {
  readonly source: SourceMemory;
  /** Target model's context window, in tokens. */
  readonly targetContextLength: number;
  /** Target embedder; absent → the source index is reused as-is. */
  readonly targetEmbedder?: MigrationEmbedder | undefined;
  /** Summarizer; absent → deterministic truncation fallback. */
  readonly summarizer?: Summarizer | undefined;
}

/** How the conversation history was fit to the target context window. */
export type RemapStrategy = "none" | "summarize" | "truncate";

/** How the embedding index was carried to the target vector space. */
export type EmbeddingStrategy = "none" | "reuse" | "reembed";

/** The embedding artifacts the target store should contain. */
export interface MigrationEmbeddingPlan {
  readonly meta: EmbeddingMeta;
  readonly chunks: readonly EmbeddingChunk[];
  readonly vectors: readonly EmbeddingVector[];
}

/** Human/summary counters printed after a migration. */
export interface MigrationSummary {
  readonly turnsCarried: number;
  readonly turnsSummarized: number;
  readonly vectorsReembedded: number;
  readonly strategy: RemapStrategy;
  readonly embeddingStrategy: EmbeddingStrategy;
}

/** The computed result of a migration, ready to stage to the target store. */
export interface MigrationPlan {
  readonly turns: readonly ConversationTurn[];
  readonly systemPrompt: string | undefined;
  readonly factsText: string;
  readonly embedding: MigrationEmbeddingPlan | undefined;
  readonly summary: MigrationSummary;
}

/** Rough token estimate (~4 chars/token); good enough for a fit heuristic. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Token budget reserved for the prepended prior-summary turn during a remap.
 * The summary is bounded to this so `system + facts + kept turns + summary`
 * provably fits the target context window (the summarizer's raw output is
 * otherwise unbounded and could re-overflow the very window we are fitting to).
 */
export const SUMMARY_TOKEN_BUDGET = 256;

/** Cap a summary turn's content to {@link SUMMARY_TOKEN_BUDGET} tokens. */
function boundSummaryContent(content: string): string {
  const maxChars = SUMMARY_TOKEN_BUDGET * 4;
  return content.length > maxChars ? content.slice(0, maxChars) : content;
}

/**
 * Decide how the source embedding index maps onto the target vector space.
 *
 * The vector space is defined by `(model, dimension)`: identical spaces can be
 * copied verbatim, any difference requires re-embedding, and a store with no
 * source index has nothing to carry. When there is no target embedder we cannot
 * re-embed, so the source index is reused (and its space becomes the target's).
 */
export function decideEmbeddingStrategy(
  source: EmbeddingMeta | undefined,
  target: { readonly model: string; readonly dimension: number } | undefined,
): EmbeddingStrategy {
  if (source === undefined) {
    return "none";
  }
  if (target === undefined) {
    return "reuse";
  }
  return source.model === target.model && source.dimension === target.dimension
    ? "reuse"
    : "reembed";
}

interface ContextRemap {
  readonly turns: readonly ConversationTurn[];
  readonly strategy: RemapStrategy;
  readonly turnsCarried: number;
  readonly turnsSummarized: number;
}

/**
 * Fit the conversation history to the target context window. The system prompt
 * and facts are reserved first and never dropped; if the remaining budget holds
 * every turn, all are carried verbatim. Otherwise the most recent turns that
 * fit are kept and the older overflow is folded into a single leading summary
 * turn — via the {@link Summarizer} when available, else a deterministic marker.
 */
async function planContextRemap(
  turns: readonly ConversationTurn[],
  systemPrompt: string | undefined,
  factsText: string,
  targetContextLength: number,
  summarizer: Summarizer | undefined,
): Promise<ContextRemap> {
  const reserved = estimateTokens(systemPrompt ?? "") + estimateTokens(factsText);
  const totalTurnCost = turns.reduce((sum, t) => sum + estimateTokens(t.content), 0);

  // Everything fits: carry the history unchanged.
  if (reserved + totalTurnCost <= targetContextLength) {
    return { turns, strategy: "none", turnsCarried: turns.length, turnsSummarized: 0 };
  }

  // Keep the newest turns that fit the remaining budget; older turns overflow.
  // A summary turn is prepended, so reserve its bounded budget up front too.
  const available = Math.max(0, targetContextLength - reserved - SUMMARY_TOKEN_BUDGET);
  let running = 0;
  let keptCount = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens((turns[i] as ConversationTurn).content);
    if (running + cost > available) {
      break;
    }
    running += cost;
    keptCount += 1;
  }

  const kept = turns.slice(turns.length - keptCount);
  const overflow = turns.slice(0, turns.length - keptCount);
  if (overflow.length === 0) {
    return { turns, strategy: "none", turnsCarried: turns.length, turnsSummarized: 0 };
  }

  const summaryTs = (overflow[0] as ConversationTurn).ts;
  let summaryTurn: ConversationTurn;
  let strategy: RemapStrategy;
  if (summarizer !== undefined) {
    const summary = stripControl(await summarizer(overflow));
    summaryTurn = {
      role: "system",
      content: boundSummaryContent(`Summary of prior conversation: ${summary}`),
      ts: summaryTs,
    };
    strategy = "summarize";
  } else {
    summaryTurn = {
      role: "system",
      content: `[${overflow.length} earlier turns omitted during migration]`,
      ts: summaryTs,
    };
    strategy = "truncate";
  }

  return {
    turns: [summaryTurn, ...kept],
    strategy,
    turnsCarried: kept.length,
    turnsSummarized: overflow.length,
  };
}

interface EmbeddingResult {
  readonly embedding: MigrationEmbeddingPlan | undefined;
  readonly strategy: EmbeddingStrategy;
  readonly reembedded: number;
}

/** Reuse or re-embed the source index for the target vector space. */
async function planEmbedding(
  source: SourceEmbedding | undefined,
  embedder: MigrationEmbedder | undefined,
): Promise<EmbeddingResult> {
  if (source === undefined || source.chunks.length === 0) {
    return { embedding: undefined, strategy: "none", reembedded: 0 };
  }

  const target =
    embedder === undefined ? undefined : { model: embedder.model, dimension: embedder.dimension };
  const strategy = decideEmbeddingStrategy(source.meta, target);

  if (strategy === "reuse") {
    return {
      embedding: { meta: source.meta, chunks: source.chunks, vectors: source.vectors },
      strategy: "reuse",
      reembedded: 0,
    };
  }

  // strategy === "reembed": a differing target space requires new vectors. An
  // embedder is guaranteed present here (a missing one yields "reuse"), but
  // guard explicitly rather than cast so the invariant fails loudly if broken.
  if (embedder === undefined) {
    throw new MemoryError("re-embed requires a target embedder");
  }
  const texts = source.chunks.map((chunk) => chunk.text);
  const result = await embedder.embed(texts);
  if (result.dimension !== embedder.dimension) {
    throw new MemoryError(
      `re-embed produced dimension ${result.dimension}, expected ${embedder.dimension}`,
    );
  }
  if (result.vectors.length !== texts.length) {
    throw new MemoryError(
      `re-embed returned ${result.vectors.length} vectors for ${texts.length} chunks`,
    );
  }

  const vectors: EmbeddingVector[] = source.chunks.map((chunk, i) => {
    const vector = result.vectors[i] as readonly number[];
    if (vector.length !== embedder.dimension) {
      throw new MemoryError(
        `re-embedded vector ${i} has ${vector.length} dimensions, expected ${embedder.dimension}`,
      );
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new MemoryError(`re-embedded vector ${i} contains a non-finite component`);
    }
    return { id: chunk.id, vector };
  });

  return {
    embedding: {
      meta: { model: embedder.model, dimension: embedder.dimension },
      chunks: source.chunks,
      vectors,
    },
    strategy: "reembed",
    reembedded: source.chunks.length,
  };
}

/**
 * Compute a full {@link MigrationPlan} from source memory and target parameters:
 * remap the context window (summarize/truncate/none) and carry the embedding
 * index (reuse/re-embed/none). Facts and the system prompt pass through
 * unchanged; the only fallible work — summarization and re-embedding — happens
 * here so a failure aborts before the staging half touches disk.
 */
export async function planMigration(input: MigrationInput): Promise<MigrationPlan> {
  const { source } = input;
  const remap = await planContextRemap(
    source.turns,
    source.systemPrompt,
    source.factsText,
    input.targetContextLength,
    input.summarizer,
  );
  const embed = await planEmbedding(source.embedding, input.targetEmbedder);

  return {
    turns: remap.turns,
    systemPrompt: source.systemPrompt,
    factsText: source.factsText,
    embedding: embed.embedding,
    summary: {
      turnsCarried: remap.turnsCarried,
      turnsSummarized: remap.turnsSummarized,
      vectorsReembedded: embed.reembedded,
      strategy: remap.strategy,
      embeddingStrategy: embed.strategy,
    },
  };
}

// ---------------------------------------------------------------------------
// Loading: read a source model's on-disk store into a validated SourceMemory.
// ---------------------------------------------------------------------------

const StoredTurnSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
    ts: z.string(),
  })
  .strict();

const StoredChunkSchema = z
  .object({ id: z.string(), text: z.string(), ts: z.string() })
  .strict();

const StoredVectorSchema = z
  .object({ id: z.string(), vector: z.array(z.number()) })
  .strict();

/** Read and validate newline-delimited JSON records, tolerating a missing file. */
function readJsonlRecords<T>(path: string, schema: z.ZodType<T>, label: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new MemoryError(`failed to read ${label}: ${path}`, { cause: error });
  }

  const records: T[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new MemoryError(`${label} line ${i + 1} is not valid JSON: ${path}`, { cause: error });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new MemoryError(`${label} line ${i + 1} failed validation: ${path}`, {
        cause: result.error,
      });
    }
    records.push(result.data);
  }
  return records;
}

/** Read a file's raw bytes, returning `undefined` when it does not exist. */
function readOptionalFile(path: string, label: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new MemoryError(`failed to read ${label}: ${path}`, { cause: error });
  }
}

/**
 * Load and validate the memory store for `modelId` into a {@link SourceMemory}.
 * Requires the store to already exist — {@link readMemoryMeta} throws if it does
 * not, and enforces that the store's recorded owner matches `modelId`, so a slug
 * collision can never migrate another model's memory. `facts.json` is read as
 * raw bytes so it can be carried through byte-identically.
 */
export function loadSourceMemory(config: Config, modelId: string): SourceMemory {
  const dir = memoryStoreDir(config, modelId);
  const meta = readMemoryMeta(dir, modelId);

  const turns = readJsonlRecords(join(dir, CONVERSATION_FILE), StoredTurnSchema, "conversation");
  const systemPrompt = readOptionalFile(join(dir, SYSTEM_FILE), "system prompt");
  const factsText = readOptionalFile(join(dir, FACTS_FILE), "facts") ?? "";

  let embedding: SourceEmbedding | undefined;
  if (meta.embedding !== undefined) {
    const chunks = readJsonlRecords(
      join(dir, EMBEDDINGS_DIR, CHUNKS_FILE),
      StoredChunkSchema,
      "chunks",
    );
    const vectors = readJsonlRecords(
      join(dir, EMBEDDINGS_DIR, VECTORS_FILE),
      StoredVectorSchema,
      "vectors",
    );
    embedding = { meta: meta.embedding, chunks, vectors };
  }

  return { turns, systemPrompt, factsText, embedding };
}

// ---------------------------------------------------------------------------
// Staging: materialize a plan onto disk atomically, with rollback safety.
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

/**
 * fsync a directory entry so a rename/create is durable across power loss. Some
 * platforms (notably Windows) reject `open`/`fsync` on a directory; treat that
 * as a best-effort no-op rather than failing the migration.
 */
function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Directory fsync unsupported on this platform; nothing more we can do.
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a staged file with owner-only perms, re-asserting them after write and
 * fsyncing so the bytes are durable before the staging dir is renamed into place.
 */
function writeStagedFile(path: string, data: string): void {
  const fd = openSync(path, "w", FILE_MODE);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, FILE_MODE);
}

function toJsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/** Read the target's existing `createdAt` so a migration preserves store age. */
function readExistingCreatedAt(targetDir: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(targetDir, MEMORY_META_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { readonly createdAt?: unknown };
    return typeof parsed.createdAt === "string" ? parsed.createdAt : undefined;
  } catch {
    // Corrupt meta: fall back to a fresh timestamp rather than aborting.
    return undefined;
  }
}

/** Count non-empty JSONL lines, treating a missing file as zero records. */
function countJsonlLines(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  return raw.split("\n").filter((line) => line.length > 0).length;
}

/** A staged, not-yet-committed migration sitting in the staging directory. */
export interface StagedMigration {
  /** Absolute path to the fully-built target store, awaiting commit. */
  readonly stagedDir: string;
  /** Absolute path the staged store will be swapped into on commit. */
  readonly targetDir: string;
  /**
   * Atomically swap the staged store into the target directory. An optional
   * post-swap `verify` runs before the previous target is discarded, so a
   * verification failure rolls the original target back into place. On any
   * failure the staged directory is cleaned up before the error propagates.
   * Single-use: calling twice, or after {@link StagedMigration.cleanup}, throws.
   */
  commit(verify?: (targetDir: string) => void): void;
  /** Discard the staged store without touching the target. Idempotent. */
  cleanup(): void;
}

/**
 * Build a plan's complete target store in a fresh same-filesystem staging
 * directory. Nothing outside the staging directory is touched until
 * {@link StagedMigration.commit} renames it into place.
 */
export function stageMigration(
  config: Config,
  targetDir: string,
  targetModelId: string,
  plan: MigrationPlan,
  now?: (() => Date) | undefined,
): StagedMigration {
  ensureDir(config.stagingDir);
  const stagedDir = join(config.stagingDir, `migrate.${process.pid}.${randomUUID()}`);
  ensureDir(stagedDir);
  let consumed = false;

  try {
    const clock = now ?? ((): Date => new Date());
    const createdAt = readExistingCreatedAt(targetDir) ?? clock().toISOString();
    const meta: MemoryMeta = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      modelId: targetModelId,
      createdAt,
      ...(plan.embedding !== undefined ? { embedding: plan.embedding.meta } : {}),
    };
    writeStagedFile(join(stagedDir, MEMORY_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
    writeStagedFile(join(stagedDir, CONVERSATION_FILE), toJsonl(plan.turns));

    if (plan.systemPrompt !== undefined) {
      writeStagedFile(join(stagedDir, SYSTEM_FILE), plan.systemPrompt);
    }
    // facts.json is carried byte-identically; only materialize it when present.
    if (plan.factsText.length > 0) {
      writeStagedFile(join(stagedDir, FACTS_FILE), plan.factsText);
    }
    if (plan.embedding !== undefined) {
      const embeddingsDir = join(stagedDir, EMBEDDINGS_DIR);
      ensureDir(embeddingsDir);
      writeStagedFile(join(embeddingsDir, CHUNKS_FILE), toJsonl(plan.embedding.chunks));
      writeStagedFile(join(embeddingsDir, VECTORS_FILE), toJsonl(plan.embedding.vectors));
    }
  } catch (error) {
    rmSync(stagedDir, { recursive: true, force: true });
    throw new MemoryError(`failed to stage migration for ${stripControl(targetModelId)}`, {
      cause: error,
    });
  }

  return {
    stagedDir,
    targetDir,
    commit(verify?: (targetDir: string) => void): void {
      if (consumed) {
        throw new MemoryError("staged migration has already been committed or cleaned up");
      }
      consumed = true;
      try {
        commitStaged(stagedDir, targetDir, verify);
      } catch (error) {
        // A committed staging dir is already gone; a failed swap leaves it behind.
        rmSync(stagedDir, { recursive: true, force: true });
        throw error;
      }
    },
    cleanup(): void {
      consumed = true;
      rmSync(stagedDir, { recursive: true, force: true });
    },
  };
}

/**
 * Swap the staged store into `targetDir`. The previous target (if any) is moved
 * aside to a same-directory backup first, so a failed rename or a failed
 * `verify` restores it exactly. The parent directory is fsynced after the swap
 * so the rename survives power loss, and the backup is discarded only once the
 * swap and verification both succeed.
 *
 * If restoring the backup itself fails, the original data survives under the
 * backup path; the thrown error names that path so it can be recovered by hand.
 */
function commitStaged(
  stagedDir: string,
  targetDir: string,
  verify?: (targetDir: string) => void,
): void {
  const parent = dirname(targetDir);
  const backup = join(parent, `.migrate-bak.${basename(targetDir)}.${randomUUID()}`);
  const targetExisted = existsSync(targetDir);
  if (targetExisted) {
    renameSync(targetDir, backup);
  }

  try {
    renameSync(stagedDir, targetDir);
    if (verify !== undefined) {
      verify(targetDir);
    }
  } catch (error) {
    // Undo the swap and restore the original target so a failure is a no-op.
    try {
      rmSync(targetDir, { recursive: true, force: true });
      if (targetExisted) {
        renameSync(backup, targetDir);
      }
    } catch (restoreError) {
      // The original store still exists under `backup`; surface where, and keep
      // the root cause chained so the real failure isn't masked.
      throw new MemoryError(
        `failed to commit migration to ${stripControl(targetDir)} and could not restore the ` +
          `original store; the previous data is preserved at ${stripControl(backup)}`,
        { cause: error instanceof Error ? error : restoreError },
      );
    }
    throw error instanceof MemoryError
      ? error
      : new MemoryError(`failed to commit migration to ${stripControl(targetDir)}`, {
          cause: error,
        });
  }

  fsyncDir(parent);

  if (targetExisted) {
    rmSync(backup, { recursive: true, force: true });
  }
}

/** Inputs for {@link writeMigration}. */
export interface MigrateWriteParams {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly targetModelId: string;
  readonly plan: MigrationPlan;
}

/** Options for {@link writeMigration}. */
export interface MigrateWriteOptions {
  /** Delete the source store after a fully-committed, verified target write. */
  readonly move?: boolean | undefined;
  /** Post-copy integrity check; defaults to {@link verifyMigration}. */
  readonly verify?: ((targetDir: string, plan: MigrationPlan) => void) | undefined;
  /** Clock for the target's `createdAt` when no prior store exists. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Materialize a {@link MigrationPlan} onto disk with crash and rollback safety:
 * stage the full target store on the same filesystem, atomically swap it into
 * place, verify it, and — only under `--move` and only after all of that
 * succeeds — delete the source. Any failure leaves both the source and the
 * original target untouched.
 */
export function writeMigration(
  config: Config,
  params: MigrateWriteParams,
  options: MigrateWriteOptions = {},
): void {
  if (options.move === true) {
    assertMovableSource(params.sourceDir, params.targetDir);
  }

  const staged = stageMigration(
    config,
    params.targetDir,
    params.targetModelId,
    params.plan,
    options.now,
  );
  const verify = options.verify ?? verifyMigration;

  try {
    staged.commit((dir) => verify(dir, params.plan));
  } catch (error) {
    staged.cleanup();
    throw error;
  }

  if (options.move === true) {
    rmSync(params.sourceDir, { recursive: true, force: true });
  }
}

/**
 * Refuse a `--move` when the source overlaps the target. Deleting an overlapping
 * source after the commit would erase the freshly-written target (or an ancestor
 * containing it) — irreversible with `rmSync(force)`. Two model ids can slugify
 * to the same directory, so this must live in the reusable module, not only in
 * the command layer.
 */
function assertMovableSource(sourceDir: string, targetDir: string): void {
  const src = resolve(sourceDir);
  const tgt = resolve(targetDir);
  if (src === tgt || tgt.startsWith(src + sep) || src.startsWith(tgt + sep)) {
    throw new MemoryError(
      `refusing to move: source ${stripControl(src)} overlaps target ${stripControl(tgt)}`,
    );
  }
}

/**
 * Post-copy integrity check: the committed target must contain exactly the
 * plan's turns, byte-identical facts, and matching embedding record counts.
 * Throws {@link MemoryError} on any discrepancy so the caller can roll back.
 */
export function verifyMigration(targetDir: string, plan: MigrationPlan): void {
  const turnCount = countJsonlLines(join(targetDir, CONVERSATION_FILE));
  if (turnCount !== plan.turns.length) {
    throw new MemoryError(
      `migration verify failed: conversation has ${turnCount} turns, expected ${plan.turns.length}`,
    );
  }

  if (plan.factsText.length > 0) {
    let facts: string;
    try {
      facts = readFileSync(join(targetDir, FACTS_FILE), "utf8");
    } catch (error) {
      throw new MemoryError("migration verify failed: facts.json is missing", { cause: error });
    }
    if (facts !== plan.factsText) {
      throw new MemoryError("migration verify failed: facts.json bytes differ from the source");
    }
  }

  if (plan.embedding !== undefined) {
    const vectorCount = countJsonlLines(join(targetDir, EMBEDDINGS_DIR, VECTORS_FILE));
    if (vectorCount !== plan.embedding.vectors.length) {
      throw new MemoryError(
        `migration verify failed: ${vectorCount} vectors, expected ${plan.embedding.vectors.length}`,
      );
    }
    const chunkCount = countJsonlLines(join(targetDir, EMBEDDINGS_DIR, CHUNKS_FILE));
    if (chunkCount !== plan.embedding.chunks.length) {
      throw new MemoryError(
        `migration verify failed: ${chunkCount} chunks, expected ${plan.embedding.chunks.length}`,
      );
    }
  }

  try {
    const metaRaw = readFileSync(join(targetDir, MEMORY_META_FILE), "utf8");
    JSON.parse(metaRaw);
  } catch (error) {
    throw new MemoryError("migration verify failed: meta.json is missing or invalid", {
      cause: error,
    });
  }
}
