/**
 * Minimal YAML-frontmatter reader/writer for library documents (agents and
 * skills), following the Claude Code / Codex convention of a `---` fenced
 * `key: value` header above a markdown body. Only the flat scalar subset the
 * library needs (`name`, `description`, `enabled`) is supported — this is
 * deliberately not a general YAML parser, which keeps the runtime dependency
 * surface limited to `cac`, `zod`, and `systeminformation`.
 */

/** A parsed document: its flat frontmatter map plus the markdown body. */
export interface ParsedDocument {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

const FENCE = "---";
const KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

/** Strip a UTF-8 BOM if present so the opening fence can be detected. */
function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/** Decode a single scalar value, unwrapping matching single/double quotes. */
function decodeValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Encode a scalar value, quoting only when the plain form would be ambiguous. */
function encodeValue(value: string): string {
  if (value.length > 0 && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9 _.\-/]*$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parse a document into its frontmatter map and body. A document without a
 * leading `---` fence has empty frontmatter and its whole content as the body.
 * A frontmatter block that is opened but never closed is treated as body text
 * (fail-soft: never throws).
 */
export function parseDocument(input: string): ParsedDocument {
  const text = stripBom(input);
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    return { frontmatter: {}, body: text };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FENCE) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { frontmatter: {}, body: text };
  }

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < close; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    const match = KEY_RE.exec(line);
    if (match) {
      frontmatter[match[1] as string] = decodeValue(match[2] as string);
    }
  }

  const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return { frontmatter, body };
}

/**
 * Serialize a frontmatter map and body back into a fenced document. Keys are
 * emitted in the given object's insertion order. An empty frontmatter map
 * yields the body alone.
 */
export function serializeDocument(
  frontmatter: Readonly<Record<string, string>>,
  body: string,
): string {
  const keys = Object.keys(frontmatter);
  const trimmedBody = body.replace(/\s+$/, "");
  if (keys.length === 0) {
    return trimmedBody.length > 0 ? `${trimmedBody}\n` : "";
  }
  const header = keys.map((key) => `${key}: ${encodeValue(frontmatter[key] as string)}`).join("\n");
  return `${FENCE}\n${header}\n${FENCE}\n\n${trimmedBody}\n`;
}
