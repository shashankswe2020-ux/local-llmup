/**
 * Sanitize multiline text crossing the browser GUI boundary.
 *
 * Unlike the terminal-oriented `stripControl`, this preserves line feeds and
 * tabs so Markdown, code, and pasted diagnostics retain their structure.
 */

// Preserve HT (09) and LF (0A); CR is normalized before this expression runs.
// eslint-disable-next-line no-control-regex -- sanitizer must match control bytes
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const INVISIBLE_RE = /[\u00ad\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/u;

type ScannerState = "text" | "escape" | "escape-intermediate" | "csi" | "control-string" | "control-string-escape";

const CONTROL_STRING_STARTERS = new Set(["]", "P", "X", "^", "_"]);

function isEscapeIntermediate(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x20 && code <= 0x2f;
}

function isEscapeFinal(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x30 && code <= 0x7e;
}

function isCsiFinal(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function isC1ControlStringStarter(character: string): boolean {
  return character === "\u0090" || character === "\u0098" || character === "\u009d" || character === "\u009e" || character === "\u009f";
}

/** Normalize newlines and remove controls that are unsafe in browser text. */
export function sanitizeGuiText(value: string): string {
  const sanitizer = new GuiTextStreamSanitizer();
  return sanitizer.push(value) + sanitizer.flush();
}

/**
 * Preserve sanitizer correctness when CRLF or ANSI escapes cross chunk
 * boundaries. Call {@link flush} once after the provider stream completes.
 */
export class GuiTextStreamSanitizer {
  private state: ScannerState = "text";
  private pendingCarriageReturn = false;
  private controlStringAllowsBell = false;

  push(chunk: string): string {
    let output = "";
    let offset = 0;
    if (this.pendingCarriageReturn) {
      output += "\n";
      this.pendingCarriageReturn = false;
      if (chunk.startsWith("\n")) {
        offset = 1;
      }
    }

    for (const character of chunk.slice(offset)) {
      if (this.pendingCarriageReturn) {
        output += "\n";
        this.pendingCarriageReturn = false;
        if (character === "\n") {
          continue;
        }
      }
      if (this.state === "control-string") {
        if ((character === "\u0007" && this.controlStringAllowsBell) || character === "\u009c") {
          this.state = "text";
          this.controlStringAllowsBell = false;
        } else if (character === "\u001b") {
          this.state = "control-string-escape";
        }
        continue;
      }
      if (this.state === "control-string-escape") {
        this.state = character === "\\" ? "text" : character === "\u001b" ? "control-string-escape" : "control-string";
        continue;
      }
      if (this.state === "csi") {
        if (isCsiFinal(character)) {
          this.state = "text";
        }
        continue;
      }
      if (this.state === "escape-intermediate") {
        if (isEscapeFinal(character)) {
          this.state = "text";
        }
        continue;
      }
      if (this.state === "escape") {
        if (character === "[") {
          this.state = "csi";
        } else if (CONTROL_STRING_STARTERS.has(character)) {
          this.state = "control-string";
          this.controlStringAllowsBell = character === "]";
        } else if (isEscapeIntermediate(character)) {
          this.state = "escape-intermediate";
        } else {
          this.state = "text";
        }
        continue;
      }
      if (character === "\u001b") {
        this.state = "escape";
        continue;
      }
      if (character === "\u009b") {
        this.state = "csi";
        continue;
      }
      if (isC1ControlStringStarter(character)) {
        this.state = "control-string";
        this.controlStringAllowsBell = character === "\u009d";
        continue;
      }
      if (character === "\r") {
        this.pendingCarriageReturn = true;
        continue;
      }
      if (UNSAFE_CONTROL_RE.test(character) || INVISIBLE_RE.test(character)) {
        continue;
      }
      output += character;
    }
    return output;
  }

  flush(): string {
    const remaining = this.pendingCarriageReturn ? "\n" : "";
    this.pendingCarriageReturn = false;
    this.state = "text";
    this.controlStringAllowsBell = false;
    return remaining;
  }
}
