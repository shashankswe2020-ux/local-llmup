/**
 * Shared, ANSI-safe output rendering used by `recommend`, `ls`, and `doctor`.
 * Both renderers strip control characters so untrusted catalog data can never
 * corrupt a terminal (via ANSI escapes) or break table alignment. The table is
 * for humans; `renderJson` emits a stable, machine-parseable shape for `--json`.
 */
import { stripControl } from "./sanitize.js";

/** A table column: its header and optional right alignment (default left). */
export interface Column {
  readonly header: string;
  readonly align?: "left" | "right";
}

/** Two spaces between columns — readable without drawing box characters. */
const COLUMN_GAP = "  ";

/**
 * Render a fixed-width text table. Every header and cell is sanitized before its
 * width is measured, so escape sequences can neither reach the terminal nor
 * inflate a column. Missing cells render empty; trailing spaces are trimmed.
 */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
): string {
  const headers = columns.map((column) => stripControl(column.header));
  const cells = rows.map((row) => columns.map((_, index) => stripControl(row[index] ?? "")));

  const widths = columns.map((_, index) => {
    const headerWidth = headers[index]?.length ?? 0;
    return cells.reduce((max, row) => Math.max(max, row[index]?.length ?? 0), headerWidth);
  });

  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        return columns[index]?.align === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join(COLUMN_GAP)
      .replace(/ +$/u, "");

  return [headers, ...cells].map(renderRow).join("\n");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return stripControl(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[stripControl(key)] = sanitizeValue(nested);
    }
    return result;
  }
  return value;
}

/**
 * Render a value as pretty, two-space-indented JSON with every string (keys and
 * values, at any depth) sanitized. Non-integer-like keys keep their insertion
 * order, so the `--json` shape is stable and contract-testable. Intended for
 * plain JSON-like data (objects, arrays, primitives); class instances such as
 * `Date` are rebuilt as plain objects rather than serialized specially.
 */
export function renderJson(value: unknown): string {
  return JSON.stringify(sanitizeValue(value), null, 2);
}
