/**
 * Shared sanitizer for any string that reaches a terminal, a log, or JSON
 * output. Stripping escape and control bytes here (rather than at each call
 * site) means catalog data, error messages, and rendered tables can never smug-
 * gle ANSI colors, cursor moves, or Trojan-Source BiDi tricks to a user.
 */

// CSI sequences and standalone Fe escapes (`ESC` followed by a single byte).
// eslint-disable-next-line no-control-regex -- sanitizer must match escape bytes
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
// C0/C1 control characters and DEL.
// eslint-disable-next-line no-control-regex -- sanitizer must match control bytes
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// BiDi overrides, zero-width, and line/paragraph separators (Trojan-Source class).
const BIDI_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g;

/** Remove ANSI escapes, control characters, and BiDi/zero-width codepoints. */
export function stripControl(value: string): string {
  return value.replace(ANSI_RE, "").replace(CONTROL_RE, "").replace(BIDI_RE, "");
}
