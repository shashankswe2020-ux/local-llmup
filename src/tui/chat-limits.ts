/**
 * Chat draft validation limits.
 *
 * These limits bound user input before it reaches the backend or memory layer.
 * The domain chat validates these independently of any UI — piped, accessible,
 * or visual TUI paths all share the same hard limits.
 */

// ─── Hard limits from spec §5.6 ───────────────────────────────────────────

/** Maximum draft size in UTF-8 bytes. */
export const DRAFT_MAX_BYTES = 32_768;

/** Maximum draft grapheme clusters. */
export const DRAFT_MAX_GRAPHEMES = 8_192;

/** Maximum draft line count. */
export const DRAFT_MAX_LINES = 256;

/** Maximum response body bytes before memory capture rejects it. */
export const RESPONSE_MAX_BYTES = 1_048_576;

// ─── Validation ────────────────────────────────────────────────────────────

export type DraftValidationError =
  | { readonly type: "bytes"; readonly actual: number; readonly limit: number }
  | { readonly type: "graphemes"; readonly actual: number; readonly limit: number }
  | { readonly type: "lines"; readonly actual: number; readonly limit: number };

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Count grapheme clusters using the built-in Intl.Segmenter.
 */
function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of graphemeSegmenter.segment(text)) {
    count += 1;
  }
  return count;
}

/**
 * Truncate text to at most `maxGraphemes` grapheme clusters.
 * Safe for multi-byte/multi-code-point characters.
 */
export function truncateGraphemeSafe(text: string, maxGraphemes: number): string {
  const segments = graphemeSegmenter.segment(text);
  let result = "";
  let count = 0;
  for (const segment of segments) {
    if (count >= maxGraphemes) break;
    result += segment.segment;
    count += 1;
  }
  return result;
}

/**
 * Validate a draft against the hard limits. Returns `null` when valid, or the
 * first violated limit.
 */
export function validateDraft(draft: string): DraftValidationError | null {
  const byteLength = Buffer.byteLength(draft, "utf8");
  if (byteLength > DRAFT_MAX_BYTES) {
    return { type: "bytes", actual: byteLength, limit: DRAFT_MAX_BYTES };
  }

  const graphemeCount = countGraphemes(draft);
  if (graphemeCount > DRAFT_MAX_GRAPHEMES) {
    return { type: "graphemes", actual: graphemeCount, limit: DRAFT_MAX_GRAPHEMES };
  }

  // Count lines: split by \n; a string with no newline is 1 line.
  const lineCount = draft.split("\n").length;
  if (lineCount > DRAFT_MAX_LINES) {
    return { type: "lines", actual: lineCount, limit: DRAFT_MAX_LINES };
  }

  return null;
}

/**
 * Format a draft validation error into a user-facing message.
 */
export function formatDraftError(error: DraftValidationError): string {
  switch (error.type) {
    case "bytes":
      return `Draft exceeds ${String(error.limit)} byte limit (${String(error.actual)} bytes)`;
    case "graphemes":
      return `Draft exceeds ${String(error.limit)} grapheme limit (${String(error.actual)} graphemes)`;
    case "lines":
      return `Draft exceeds ${String(error.limit)} line limit (${String(error.actual)} lines)`;
  }
}

/**
 * Validate a response body size before memory capture.
 * Returns true if the response is within limits.
 */
export function isResponseWithinLimits(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= RESPONSE_MAX_BYTES;
}

/**
 * Format the session-end summary emitted to stdout by auto-TUI chat.
 */
export function formatChatSessionSummary(turns: number, memoryWarnings: number): string {
  const turnLabel = turns === 1 ? "1 turn" : `${String(turns)} turns`;
  const warningLabel =
    memoryWarnings === 0
      ? "0 memory warnings"
      : memoryWarnings === 1
        ? "1 memory warning"
        : `${String(memoryWarnings)} memory warnings`;
  return `Chat session ended: ${turnLabel}, ${warningLabel}.\n`;
}
