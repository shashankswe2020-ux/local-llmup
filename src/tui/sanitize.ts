import stringWidth from "string-width";
import { ValidationError } from "../errors.js";

export type TerminalTextContext = "action_identifier" | "single_line" | "multiline";

export const TERMINAL_TEXT_LIMITS = {
  cellBytes: 256,
  detailBytes: 8 * 1024,
  chatVisibleMessageBytes: 64 * 1024,
  frameBytes: 256 * 1024,
  inputBytes: 1024 * 1024,
  retainedMessageBytes: 50 * 1024,
  retainedMessageCount: 200,
} as const;

export interface TerminalTextOptions {
  readonly maxBytes?: number | undefined;
  readonly maxColumns?: number | undefined;
  readonly profile?: "default" | "chat_visible" | undefined;
}

export interface TerminalMessageBuffer {
  append(value: string): void;
  snapshot(): readonly string[];
  bytes(): number;
}

export type SanitizedActionIdentifier =
  | { readonly actionable: true; readonly canonical: string; readonly display: string }
  | { readonly actionable: false; readonly display: string };

export interface TerminalFrameBuilder {
  append(value: string): void;
  build(): string;
  bytes(): number;
}

const ACTION_CHARACTER_RE = /^[A-Za-z0-9._:/-]$/u;
const STRICT_ACTION_CHARACTER_RE = /^[a-z0-9._:/-]$/u;
const DEFAULT_IGNORABLE_RE = /^\p{Default_Ignorable_Code_Point}$/u;
const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const ELLIPSIS = "…";
const ESCAPE_LOOKAHEAD_BYTES = 1024;

function isUnsafeCodePoint(codePoint: number): boolean {
  const character = String.fromCodePoint(codePoint);
  return (
    DEFAULT_IGNORABLE_RE.test(character) ||
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

function visibleEscape(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase()}}`;
}

function validateLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new ValidationError(`${label} must be a safe integer in 0..${String(maximum)}`);
  }
  return limit;
}

interface EscapeResult {
  readonly value: string;
  readonly truncated: boolean;
}

function createEscapeAccumulator(limit: number): {
  append(value: string): boolean;
  result(): EscapeResult;
} {
  let output = "";
  let bytes = 0;
  let truncated = false;
  return {
    append: (value: string): boolean => {
      const addedBytes = Buffer.byteLength(value, "utf8");
      if (bytes + addedBytes > limit) {
        truncated = true;
        return false;
      }
      output += value;
      bytes += addedBytes;
      return true;
    },
    result: (): EscapeResult => ({ value: output, truncated }),
  };
}

function escapeProse(value: string, multiline: boolean, bufferLimit: number): EscapeResult {
  const accumulator = createEscapeAccumulator(bufferLimit);
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
      if (!accumulator.append(multiline ? "\n" : "\\n")) break;
      continue;
    }
    if (first === 0x0a) {
      if (!accumulator.append(multiline ? "\n" : "\\n")) break;
      continue;
    }
    if (first === 0x09) {
      if (!accumulator.append("  ")) break;
      continue;
    }
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        const codePoint = (first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000;
        const next = isUnsafeCodePoint(codePoint)
          ? visibleEscape(codePoint)
          : String.fromCodePoint(codePoint);
        if (!accumulator.append(next)) break;
        index += 1;
      } else {
        if (!accumulator.append(visibleEscape(first))) break;
      }
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      if (!accumulator.append(visibleEscape(first))) break;
      continue;
    }
    const next = isUnsafeCodePoint(first) ? visibleEscape(first) : String.fromCodePoint(first);
    if (!accumulator.append(next)) break;
  }
  const result = accumulator.result();
  escaped = result.value.normalize("NFC");
  return { value: escaped, truncated: result.truncated };
}

function escapeActionIdentifier(
  value: string,
  bufferLimit: number,
  strict = false,
): EscapeResult {
  const accumulator = createEscapeAccumulator(bufferLimit);
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        const codePoint = (first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000;
        if (!accumulator.append(visibleEscape(codePoint))) break;
        index += 1;
      } else {
        if (!accumulator.append(visibleEscape(first))) break;
      }
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      if (!accumulator.append(visibleEscape(first))) break;
      continue;
    }
    const character = String.fromCodePoint(first);
    const allowed = strict
      ? STRICT_ACTION_CHARACTER_RE.test(character)
      : ACTION_CHARACTER_RE.test(character);
    if (!accumulator.append(allowed ? character : visibleEscape(first))) break;
  }
  return accumulator.result();
}

function truncateTerminalText(
  value: string,
  maxBytes: number,
  maxColumns: number,
  alreadyTruncated = false,
): string {
  const fits =
    Buffer.byteLength(value, "utf8") <= maxBytes && stringWidth(value) <= maxColumns;
  if (fits && !alreadyTruncated) return value;
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, "utf8");
  const ellipsisColumns = stringWidth(ELLIPSIS);
  if (maxBytes < ellipsisBytes || maxColumns < ellipsisColumns) return "";

  let output = "";
  let bytes = 0;
  let columns = 0;
  for (const segment of terminalTextUnits(value)) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    const segmentColumns = stringWidth(segment);
    if (
      bytes + segmentBytes + ellipsisBytes > maxBytes ||
      columns + segmentColumns + ellipsisColumns > maxColumns
    ) {
      break;
    }
    output += segment;
    bytes += segmentBytes;
    columns += segmentColumns;
  }
  return `${output}${ELLIPSIS}`;
}

function* terminalTextUnits(value: string): Iterable<string> {
  const escapeToken = /\\u\{[0-9A-F]+\}/gu;
  let offset = 0;
  for (const match of value.matchAll(escapeToken)) {
    const index = match.index;
    if (index > offset) {
      for (const part of SEGMENTER.segment(value.slice(offset, index))) yield part.segment;
    }
    const token = match[0];
    if (token !== undefined) yield token;
    offset = index + (token?.length ?? 0);
  }
  if (offset < value.length) {
    for (const part of SEGMENTER.segment(value.slice(offset))) yield part.segment;
  }
}

/** Escape untrusted terminal content visibly, normalize prose, and bound output. */
export function sanitizeTerminalText(
  value: string,
  context: TerminalTextContext,
  options: TerminalTextOptions = {},
): string {
  if (options.profile === "chat_visible" && context !== "multiline") {
    throw new ValidationError("chat_visible profile requires multiline context");
  }
  const hardByteLimit =
    options.profile === "chat_visible"
      ? TERMINAL_TEXT_LIMITS.chatVisibleMessageBytes
      : context === "multiline"
        ? TERMINAL_TEXT_LIMITS.detailBytes
        : TERMINAL_TEXT_LIMITS.cellBytes;
  const defaultBytes = hardByteLimit;
  const inputBytes = Buffer.byteLength(value, "utf8");
  if (inputBytes > TERMINAL_TEXT_LIMITS.inputBytes) {
    throw new ValidationError(
      `terminal text input exceeds ${String(TERMINAL_TEXT_LIMITS.inputBytes)} bytes`,
    );
  }
  const maxBytes = validateLimit(
    options.maxBytes,
    defaultBytes,
    hardByteLimit,
    "terminal text byte limit",
  );
  const maxColumns = validateLimit(
    options.maxColumns,
    10_000,
    10_000,
    "terminal text column limit",
  );
  const bufferLimit = Math.min(
    TERMINAL_TEXT_LIMITS.inputBytes,
    maxBytes + ESCAPE_LOOKAHEAD_BYTES,
  );
  const escaped =
    context === "action_identifier"
      ? escapeActionIdentifier(value, bufferLimit)
      : escapeProse(value, context === "multiline", bufferLimit);
  return truncateTerminalText(escaped.value, maxBytes, maxColumns, escaped.truncated);
}

export function sanitizeActionIdentifier(
  canonical: string,
  isValid: (value: string) => boolean,
): SanitizedActionIdentifier {
  let actionable = false;
  try {
    actionable = isValid(canonical);
  } catch {
    actionable = false;
  }
  const escaped = escapeActionIdentifier(
    canonical,
    TERMINAL_TEXT_LIMITS.cellBytes + ESCAPE_LOOKAHEAD_BYTES,
    !actionable,
  );
  const display = truncateTerminalText(
    escaped.value,
    TERMINAL_TEXT_LIMITS.cellBytes,
    10_000,
    escaped.truncated,
  );
  return actionable ? { actionable: true, canonical, display } : { actionable: false, display };
}

export function assertTerminalFrameSize(frame: string): void {
  const bytes = Buffer.byteLength(frame, "utf8");
  if (bytes > TERMINAL_TEXT_LIMITS.frameBytes) {
    throw new ValidationError(
      `terminal frame exceeds ${String(TERMINAL_TEXT_LIMITS.frameBytes)} bytes`,
    );
  }
}

export function createTerminalFrameBuilder(): TerminalFrameBuilder {
  const chunks: string[] = [];
  let frameBytes = 0;
  return {
    append: (value: string): void => {
      const added = Buffer.byteLength(value, "utf8");
      if (frameBytes + added > TERMINAL_TEXT_LIMITS.frameBytes) {
        throw new ValidationError(
          `terminal frame exceeds ${String(TERMINAL_TEXT_LIMITS.frameBytes)} bytes`,
        );
      }
      chunks.push(value);
      frameBytes += added;
    },
    build: (): string => chunks.join(""),
    bytes: (): number => frameBytes,
  };
}

export function createTerminalMessageBuffer(): TerminalMessageBuffer {
  const messages: string[] = [];
  let retainedBytes = 0;
  return {
    append: (value: string): void => {
      const sanitized = sanitizeTerminalText(value, "multiline");
      messages.push(sanitized);
      retainedBytes += Buffer.byteLength(sanitized, "utf8");
      while (
        messages.length > TERMINAL_TEXT_LIMITS.retainedMessageCount ||
        retainedBytes > TERMINAL_TEXT_LIMITS.retainedMessageBytes
      ) {
        const removed = messages.shift();
        if (removed === undefined) break;
        retainedBytes -= Buffer.byteLength(removed, "utf8");
      }
    },
    snapshot: (): readonly string[] => Object.freeze([...messages]),
    bytes: (): number => retainedBytes,
  };
}
