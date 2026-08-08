import { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdin, type Instance } from "ink";
import { sanitizeTerminalText } from "./sanitize.js";
import { validateModelPickerChoices } from "./model-picker-choices.js";
import { createUiKeyDecoder, type UiKey } from "./keys.js";

export interface ModelPickerOptions {
  readonly title: string;
  readonly choices: readonly string[];
  readonly stdin: NodeJS.ReadStream;
  readonly stderr: NodeJS.WriteStream;
  readonly unicode: boolean;
}

export interface ModelPickerSession {
  unmount(): void;
  waitForDecision(): Promise<string | null>;
}

const VISIBLE_CHOICES = 10;

function PickerApp({
  title,
  choices,
  unicode,
  decide,
}: {
  readonly title: string;
  readonly choices: readonly string[];
  readonly unicode: boolean;
  readonly decide: (choice: string | null) => void;
}): JSX.Element {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const [selected, setSelected] = useState(0);
  const decoder = useRef(createUiKeyDecoder());
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      decide(null);
      exit();
      return;
    }
    if (key.escape) {
      if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
      escapeTimer.current = setTimeout(() => {
        escapeTimer.current = null;
        decide(null);
        exit();
      }, 50);
      return;
    }
    if (key.upArrow || input === "k") setSelected((index) => Math.max(0, index - 1));
    else if (key.downArrow || input === "j") {
      setSelected((index) => Math.min(choices.length - 1, index + 1));
    } else if (key.return) {
      decide(choices[selected] ?? null);
      exit();
    }
  });
  useEffect(() => {
    const emptyKey: UiKey = {
      upArrow: false,
      downArrow: false,
      pageUp: false,
      pageDown: false,
      return: false,
      escape: false,
      tab: false,
      shift: false,
      ctrl: false,
    };
    const handleHomeEnd = (chunk: Buffer | string): void => {
      const sequence = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const action = decoder.current.decode(sequence, emptyKey);
      if (action === "first" || action === "last") {
        if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
        escapeTimer.current = null;
        setSelected(action === "first" ? 0 : choices.length - 1);
      }
    };
    stdin?.on("data", handleHomeEnd);
    return () => {
      stdin?.removeListener("data", handleHomeEnd);
      if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
    };
  });
  const offset = Math.max(
    0,
    Math.min(selected - Math.floor(VISIBLE_CHOICES / 2), choices.length - VISIBLE_CHOICES),
  );
  const visible = choices.slice(offset, offset + VISIBLE_CHOICES);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{`${String(choices.length)} offline catalog model(s)`}</Text>
      {visible.map((choice, index) => {
        const absolute = offset + index;
        const display = sanitizeTerminalText(choice, "action_identifier");
        return <Text key={choice} bold={absolute === selected}>{`${absolute === selected ? ">" : " "} ${display}`}</Text>;
      })}
      <Text>{`${unicode ? "↑↓" : "Up/Down"} Navigate · Enter Select · q/Esc Cancel`}</Text>
    </Box>
  );
}

/** Mount a bounded offline visual model picker. */
export function mountModelPicker(options: ModelPickerOptions): ModelPickerSession {
  const choices = validateModelPickerChoices(options.choices);
  const title = sanitizeTerminalText(options.title, "single_line");
  let settled = false;
  let resolveDecision: ((choice: string | null) => void) | undefined;
  const decision = new Promise<string | null>((resolve) => {
    resolveDecision = resolve;
  });
  const decide = (choice: string | null): void => {
    if (settled) return;
    settled = true;
    resolveDecision?.(choice);
  };
  const instance: Instance = render(
    <PickerApp title={title} choices={choices} unicode={options.unicode} decide={decide} />,
    {
      stdin: options.stdin,
      stdout: options.stderr,
      stderr: options.stderr,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  let unmounted = false;
  const inkExit = instance.waitUntilExit();
  const exitBeforeDecision = inkExit.then(() => {
    if (!settled) throw new Error("model picker exited before a decision");
    return null;
  });
  return {
    unmount: (): void => {
      if (unmounted) return;
      unmounted = true;
      decide(null);
      instance.unmount();
      instance.cleanup();
    },
    waitForDecision: async (): Promise<string | null> => {
      try {
        return await Promise.race([decision, exitBeforeDecision]);
      } finally {
        instance.cleanup();
      }
    },
  };
}
