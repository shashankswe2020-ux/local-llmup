export interface UiKey {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly pageUp: boolean;
  readonly pageDown: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly tab: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
}

export type UiKeyAction =
  | "move_up"
  | "move_down"
  | "page_up"
  | "page_down"
  | "first"
  | "last"
  | "search"
  | "accept"
  | "toggle"
  | "focus_next"
  | "focus_previous"
  | "back"
  | "help"
  | "quit"
  | "cancel";

export interface UiKeyContext {
  readonly textInputFocused?: boolean | undefined;
}

export interface UiKeyDecoder {
  decode(input: string, key: UiKey, context?: UiKeyContext): UiKeyAction | null;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// eslint-disable-next-line no-control-regex -- detects OSC/DCS/SOS/PM/APC introducers
const TERMINAL_STRING_START_RE = /^\u001b(?:\]|P|X|\^|_)/u;
const C1_TERMINAL_STRING_START_RE = /^[\u0090\u0098\u009d-\u009f]/u;
const MAX_ESCAPE_SEQUENCE_BYTES = 64;
// eslint-disable-next-line no-control-regex -- raw input guard must recognize terminal controls
const RAW_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

function knownSequenceAction(input: string): UiKeyAction | null {
  if (input === "\u001b[5~") return "page_up";
  if (input === "\u001b[6~") return "page_down";
  if (input === "\u001b[H" || input === "\u001bOH") return "first";
  if (input === "\u001b[F" || input === "\u001bOF") return "last";
  return null;
}

function isCompleteFiniteEscape(input: string): boolean {
  return (
    // eslint-disable-next-line no-control-regex -- recognizes a complete CSI sequence
    /^\u001b\[[0-9;?]*[ -/]*[@-~]$/u.test(input) ||
    // eslint-disable-next-line no-control-regex -- recognizes a complete ESC Fe sequence
    /^\u001b[@-Z\\-_]$/u.test(input)
  );
}

/** Decode only documented actions while suppressing paste and control-sequence contents. */
export function createUiKeyDecoder(): UiKeyDecoder {
  let pasted = false;
  let terminalString = false;
  let terminalStringAllowsBel = false;
  let terminalEscape = false;
  let pasteEndMatch = 0;
  let pendingSequence = "";

  const consumePasted = (input: string, start = 0): void => {
    for (let index = start; index < input.length; index += 1) {
      const character = input[index] ?? "";
      if (character === PASTE_END[pasteEndMatch]) pasteEndMatch += 1;
      else pasteEndMatch = character === PASTE_END[0] ? 1 : 0;
      if (pasteEndMatch === PASTE_END.length) {
        pasted = false;
        pasteEndMatch = 0;
      }
    }
  };

  const consumeTerminalString = (input: string, start = 0): void => {
    for (let index = start; index < input.length; index += 1) {
      const character = input[index] ?? "";
      if (character === "\u0007" && terminalStringAllowsBel) {
        terminalString = false;
        terminalStringAllowsBel = false;
        terminalEscape = false;
        continue;
      }
      if (character === "\u009c") {
        terminalString = false;
        terminalEscape = false;
        continue;
      }
      if (terminalEscape) {
        if (character === "\\") {
          terminalString = false;
          terminalStringAllowsBel = false;
        }
        terminalEscape = character === "\u001b";
        continue;
      }
      terminalEscape = character === "\u001b";
    }
  };

  const beginPaste = (input: string, contentStart: number): UiKeyAction | null => {
    pasted = true;
    pasteEndMatch = 0;
    pendingSequence = "";
    consumePasted(input, contentStart);
    return null;
  };

  const beginTerminalString = (
    input: string,
    contentStart: number,
    allowsBel: boolean,
  ): UiKeyAction | null => {
    terminalString = true;
    terminalStringAllowsBel = allowsBel;
    terminalEscape = false;
    pendingSequence = "";
    consumeTerminalString(input, contentStart);
    return null;
  };

  const consumeEscapeSequence = (input: string): UiKeyAction | null => {
    if (input.startsWith(PASTE_START)) return beginPaste(input, PASTE_START.length);
    if (TERMINAL_STRING_START_RE.test(input)) {
      return beginTerminalString(input, 2, input[1] === "]");
    }
    if (C1_TERMINAL_STRING_START_RE.test(input)) {
      return beginTerminalString(input, 1, input[0] === "\u009d");
    }
    if (Buffer.byteLength(input, "utf8") > MAX_ESCAPE_SEQUENCE_BYTES) {
      pendingSequence = "";
      return null;
    }
    const known = knownSequenceAction(input);
    if (known !== null) {
      pendingSequence = "";
      return known;
    }
    if (
      PASTE_START.startsWith(input) ||
      PASTE_END.startsWith(input) ||
      // eslint-disable-next-line no-control-regex -- retains only incomplete CSI/SS3 prefixes
      /^\u001b(?:\[[0-9;?]*[ -/]*|O?)$/u.test(input)
    ) {
      pendingSequence = input;
      return null;
    }
    if (isCompleteFiniteEscape(input)) {
      pendingSequence = "";
      return null;
    }
    pendingSequence = "";
    return null;
  };

  return {
    decode: (input: string, key: UiKey, context: UiKeyContext = {}): UiKeyAction | null => {
      if (pasted) {
        consumePasted(input);
        return null;
      }
      if (terminalString) {
        consumeTerminalString(input);
        return null;
      }
      if (pendingSequence.length > 0) {
        if (PASTE_START.startsWith(pendingSequence)) {
          const needed = PASTE_START.slice(pendingSequence.length);
          if (input.startsWith(needed)) return beginPaste(input, needed.length);
        }
        if (
          pendingSequence === "\u001b" &&
          input.length > 0 &&
          "]PX^_".includes(input[0] ?? "")
        ) {
          return beginTerminalString(input, 1, input[0] === "]");
        }
        if (
          Buffer.byteLength(pendingSequence, "utf8") + Buffer.byteLength(input, "utf8") >
          MAX_ESCAPE_SEQUENCE_BYTES
        ) {
          pendingSequence = "";
          return null;
        }
        return consumeEscapeSequence(`${pendingSequence}${input}`);
      }

      if (input === "\u001b" && key.escape) return "back";
      if (input.startsWith("\u001b")) return consumeEscapeSequence(input);
      if (input.startsWith("\u009b") || input.startsWith("\u008f")) {
        if (Buffer.byteLength(input, "utf8") > MAX_ESCAPE_SEQUENCE_BYTES) return null;
        const normalized = `${input[0] === "\u009b" ? "\u001b[" : "\u001bO"}${input.slice(1)}`;
        return consumeEscapeSequence(normalized);
      }
      if (C1_TERMINAL_STRING_START_RE.test(input)) {
        return beginTerminalString(input, 1, input[0] === "\u009d");
      }
      if ((key.ctrl && input === "c") || input === "\u0003") return "cancel";
      if (RAW_CONTROL_RE.test(input)) return null;

      if (context.textInputFocused === true) return null;
      if (key.upArrow || input === "k") return "move_up";
      if (key.downArrow || input === "j") return "move_down";
      if (key.pageUp) return "page_up";
      if (key.pageDown) return "page_down";
      if (key.escape) return "back";
      if (input === "/") return "search";
      if (key.return) return "accept";
      if (input === " ") return "toggle";
      if (key.tab && key.shift) return "focus_previous";
      if (key.tab) return "focus_next";
      if (input === "?") return "help";
      if (input === "q") return "quit";
      return null;
    },
  };
}
