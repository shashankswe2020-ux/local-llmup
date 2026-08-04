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
 */
import { MemoryError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { EmbeddingMeta } from "./store.js";

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
