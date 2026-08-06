/**
 * Chat memory capture: the producer half of local-llmup's memory system. Where
 * `store.ts` owns a model store's on-disk foundation, this module records what a
 * conversation produces into that store — appending each exchange to
 * `conversation.jsonl`, distilling durable user facts into `facts.json`, and
 * (when an embedder is supplied) chunking + embedding turn content into
 * `embeddings/` with the embedding model + dimension pinned in `meta.json`.
 *
 * Everything written here is first passed through {@link stripControl}: chat
 * content is untrusted (it can carry model- or user-supplied ANSI/BiDi bytes),
 * and a later `migrate`/`chat` render must never replay escape sequences.
 */
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DIR_MODE, FILE_MODE, type Config } from "../config.js";
import { MemoryError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import {
  readMemoryMeta,
  writeMemoryMeta,
  type MemoryStore,
} from "./store.js";

/** Bumped when the `facts.json` layout changes incompatibly. */
export const FACTS_SCHEMA_VERSION = 1 as const;

/**
 * On-disk store layout filenames. Exported so the migration module writes and
 * verifies the exact same artifacts this producer creates, without drift.
 */
export const CONVERSATION_FILE = "conversation.jsonl";
export const FACTS_FILE = "facts.json";
export const EMBEDDINGS_DIR = "embeddings";
export const CHUNKS_FILE = "chunks.jsonl";
export const VECTORS_FILE = "vectors.jsonl";

const FactSchema = z
  .object({
    text: z.string().min(1),
    ts: z.string().min(1),
  })
  .strict();

const FactsFileSchema = z
  .object({
    schemaVersion: z.literal(FACTS_SCHEMA_VERSION),
    facts: z.array(FactSchema),
  })
  .strict();

type FactsFile = z.infer<typeof FactsFileSchema>;

/** One conversational exchange to record: the user prompt and the reply. */
export interface ChatExchange {
  readonly user: string;
  readonly assistant: string;
}

/**
 * Produces embeddings for chat content. The `chat` command wires this to the
 * backend adapter's `embed` with a fixed embedding model; tests can stub it.
 */
export interface CaptureEmbedder {
  /** Embedding model id, pinned into the store's `meta.json` on first use. */
  readonly model: string;
  embed(inputs: readonly string[]): Promise<{
    readonly vectors: readonly (readonly number[])[];
    readonly dimension: number;
  }>;
}

/** Optional dependencies for {@link captureExchange}. */
export interface CaptureOptions {
  /** Clock, injectable for deterministic timestamps in tests. */
  readonly now?: (() => Date) | undefined;
  /** When present, turn content is chunked and embedded into `embeddings/`. */
  readonly embedder?: CaptureEmbedder | undefined;
  /**
   * Set when the serving backend cannot embed. Capture proceeds vector-less —
   * no embedder is consulted, no vectors are fabricated — and the store's
   * `meta.json` is flagged so later reads know the absence is intentional.
   */
  readonly embeddingUnsupported?: boolean | undefined;
}

/** What a single capture wrote. */
export interface CaptureResult {
  /** Turns appended to `conversation.jsonl` (0–2; empty turns are skipped). */
  readonly turnsAppended: number;
  /** New durable facts added to `facts.json` (after de-duplication). */
  readonly factsExtracted: number;
  /** Chunks embedded into `embeddings/` (0 when no embedder is supplied). */
  readonly vectorsEmbedded: number;
}

interface FactRule {
  readonly pattern: RegExp;
  readonly format: (captured: string) => string;
}

// Rule-based v1 extraction: conservative, deterministic patterns that capture
// durable user facts. Model-assisted extraction is deferred (see spec §3.5).
const FACT_RULES: readonly FactRule[] = [
  { pattern: /\b(?:my name is|call me)\s+([^.,;!?\n]+)/gi, format: (v) => `name = ${v}` },
  { pattern: /\bi (?:live|reside) in\s+([^.,;!?\n]+)/gi, format: (v) => `location = ${v}` },
  { pattern: /\bi work (?:as|at)\s+([^.,;!?\n]+)/gi, format: (v) => `occupation = ${v}` },
  {
    pattern: /\bi (?:like|love|prefer|enjoy)\s+([^.,;!?\n]+)/gi,
    format: (v) => `preference = ${v}`,
  },
  { pattern: /\bremember(?: that)?[:\s]+([^.\n]+)/gi, format: (v) => v },
];

/**
 * Extract durable user facts from a message using conservative rules. Returns
 * canonical fact strings, de-duplicated case-insensitively in rule order.
 */
export function extractFacts(text: string): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();

  for (const rule of FACT_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const captured = match[1]?.trim();
      if (captured === undefined || captured.length === 0) {
        continue;
      }
      const fact = rule.format(captured);
      const key = fact.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      facts.push(fact);
    }
  }

  return facts;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup; ignore if the temp file is already gone.
  }
}

/** Append newline-delimited JSON records, re-asserting owner-only file perms. */
function appendJsonl(path: string, records: readonly unknown[]): void {
  if (records.length === 0) {
    return;
  }
  const data = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  appendFileSync(path, data, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

interface LoadedFacts {
  readonly file: FactsFile;
  readonly existed: boolean;
}

function loadFacts(path: string): LoadedFacts {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: { schemaVersion: FACTS_SCHEMA_VERSION, facts: [] }, existed: false };
    }
    throw new MemoryError(`failed to read facts: ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MemoryError(`facts file is not valid JSON: ${path}`, { cause: error });
  }

  const result = FactsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new MemoryError(`facts file failed validation: ${path}`, { cause: result.error });
  }
  return { file: result.data, existed: true };
}

/**
 * Atomically write JSON to `path` via a temp file in the staging dir (same
 * filesystem as the home dir) plus `rename`, so a torn write can never leave a
 * half-written file that would brick every future read.
 */
function atomicWriteJson(config: Config, path: string, value: unknown): void {
  ensureDir(config.stagingDir);
  const tempFile = join(config.stagingDir, `facts.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    chmodSync(tempFile, FILE_MODE);
    renameSync(tempFile, path);
  } catch (error) {
    tryUnlink(tempFile);
    throw new MemoryError(`failed to write facts: ${path}`, { cause: error });
  }
  chmodSync(path, FILE_MODE);
}

/** A validated embedding result, prepared before any disk write. */
interface PreparedEmbedding {
  readonly model: string;
  readonly dimension: number;
  readonly chunks: readonly string[];
  readonly vectors: readonly (readonly number[])[];
  /** True when the store has no embedding pinned yet and one must be written. */
  readonly needsPin: boolean;
}

/**
 * Record a chat exchange into the model's memory store. Appends the turns,
 * extracts and merges durable facts, and — when an embedder is supplied —
 * embeds the turn content, pinning the embedding model + dimension in
 * `meta.json`. All stored content is stripped of control/ANSI bytes first.
 *
 * The only fallible (network) step, embedding, runs and is fully validated
 * *before* anything touches disk, so an embedder outage or a vector-space
 * mismatch aborts cleanly rather than recording a turn with no matching vector.
 *
 * Intended to be called by the `chat` command while holding the runtime lock,
 * which serializes writes to the store.
 */
export async function captureExchange(
  config: Config,
  store: MemoryStore,
  exchange: ChatExchange,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const clock = options.now ?? ((): Date => new Date());
  const ts = clock().toISOString();

  const user = stripControl(exchange.user);
  const assistant = stripControl(exchange.assistant);

  const turns: { role: "user" | "assistant"; content: string; ts: string }[] = [];
  if (user.length > 0) {
    turns.push({ role: "user", content: user, ts });
  }
  if (assistant.length > 0) {
    turns.push({ role: "assistant", content: assistant, ts });
  }

  // Do the fallible network embedding + all its validation first, so a failure
  // aborts before a single turn is persisted. A backend without embedding
  // support skips this entirely — vectors are intentionally absent, never faked.
  const embeddingUnsupported = options.embeddingUnsupported === true;
  const embedding = embeddingUnsupported
    ? undefined
    : await prepareEmbedding(store, [user, assistant], options.embedder);

  appendJsonl(join(store.dir, CONVERSATION_FILE), turns);
  const factsExtracted = mergeFacts(config, store, user, ts);
  const vectorsEmbedded = embedding === undefined ? 0 : writeEmbedding(config, store, embedding, ts);
  if (embeddingUnsupported) {
    markEmbeddingUnsupported(config, store);
  }

  return { turnsAppended: turns.length, factsExtracted, vectorsEmbedded };
}

/** Flag a store's `meta.json` so a later read knows vectors are absent by design. */
function markEmbeddingUnsupported(config: Config, store: MemoryStore): void {
  const meta = readMemoryMeta(store.dir, store.modelId);
  if (meta.embeddingUnsupported === true && meta.embedding === undefined) {
    return;
  }
  // The flag wins: drop any now-orphaned index descriptor so meta.json can never
  // claim both a vector space and that vectors are absent.
  const { embedding: _dropped, ...rest } = meta;
  writeMemoryMeta(config, store.dir, { ...rest, embeddingUnsupported: true });
}

/** Merge newly-extracted facts from the user turn into `facts.json`. */
function mergeFacts(config: Config, store: MemoryStore, userContent: string, ts: string): number {
  const path = join(store.dir, FACTS_FILE);
  const { file, existed } = loadFacts(path);
  const existing = new Set(file.facts.map((fact) => fact.text.toLowerCase()));

  let added = 0;
  for (const text of extractFacts(userContent)) {
    const key = text.toLowerCase();
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    file.facts.push({ text, ts });
    added += 1;
  }

  // Only rewrite when something changed, or to materialize the file on first use.
  if (added > 0 || !existed) {
    atomicWriteJson(config, path, file);
  }
  return added;
}

/**
 * Embed the exchange content and validate it fully — vector count, per-vector
 * dimension, and vector-space compatibility with any already-pinned model —
 * without writing anything. Returns `undefined` when there is nothing to embed.
 */
async function prepareEmbedding(
  store: MemoryStore,
  contents: readonly string[],
  embedder: CaptureEmbedder | undefined,
): Promise<PreparedEmbedding | undefined> {
  if (embedder === undefined) {
    return undefined;
  }
  const chunks = contents.filter((content) => content.length > 0);
  if (chunks.length === 0) {
    return undefined;
  }

  const result = await embedder.embed(chunks);
  if (result.vectors.length !== chunks.length) {
    throw new MemoryError(
      `embedder returned ${result.vectors.length} vectors for ${chunks.length} chunks`,
    );
  }
  result.vectors.forEach((vector, i) => {
    if (vector.length !== result.dimension) {
      throw new MemoryError(
        `embedding vector ${i} has ${vector.length} dimensions, expected ${result.dimension}`,
      );
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new MemoryError(`embedding vector ${i} contains a non-finite component`);
    }
  });

  // A store's vector space is fixed on first embed; mixing a different model or
  // dimension would silently corrupt similarity search, so reject up front.
  const meta = readMemoryMeta(store.dir, store.modelId);
  const current = meta.embedding;
  if (current !== undefined && (current.model !== embedder.model || current.dimension !== result.dimension)) {
    throw new MemoryError(
      `embedding mismatch: store uses ${stripControl(current.model)}/${current.dimension}, ` +
        `refusing to write ${stripControl(embedder.model)}/${result.dimension}`,
    );
  }

  return {
    model: embedder.model,
    dimension: result.dimension,
    chunks,
    vectors: result.vectors,
    needsPin: current === undefined,
  };
}

/** Persist a prepared embedding: pin meta on first use, then append artifacts. */
function writeEmbedding(
  config: Config,
  store: MemoryStore,
  embedding: PreparedEmbedding,
  ts: string,
): number {
  if (embedding.needsPin) {
    const meta = readMemoryMeta(store.dir, store.modelId);
    writeMemoryMeta(config, store.dir, {
      ...meta,
      embedding: { model: embedding.model, dimension: embedding.dimension },
    });
  }

  const dir = join(store.dir, EMBEDDINGS_DIR);
  ensureDir(dir);

  const chunkRecords: { id: string; text: string; ts: string }[] = [];
  const vectorRecords: { id: string; vector: readonly number[] }[] = [];
  for (let i = 0; i < embedding.chunks.length; i += 1) {
    const id = randomUUID();
    // Length-checked in prepareEmbedding: chunks and vectors are the same length.
    const text = embedding.chunks[i] as string;
    const vector = embedding.vectors[i] as readonly number[];
    chunkRecords.push({ id, text, ts });
    vectorRecords.push({ id, vector });
  }
  appendJsonl(join(dir, CHUNKS_FILE), chunkRecords);
  appendJsonl(join(dir, VECTORS_FILE), vectorRecords);

  return embedding.chunks.length;
}
