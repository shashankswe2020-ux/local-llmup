import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ChatScreenStyle {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly columns: number;
}

export type ChatScreenState =
  | { readonly type: "idle" }
  | { readonly type: "pending" }
  | { readonly type: "error"; readonly message: string };

export function ChatScreen({
  modelId,
  endpoint,
  messages,
  state,
  draftError,
  style,
  onSubmit,
  onExit,
}: {
  readonly modelId: string;
  readonly endpoint: string;
  readonly messages: readonly ChatMessage[];
  readonly state: ChatScreenState;
  readonly draftError: string | null;
  readonly style: ChatScreenStyle;
  readonly onSubmit: (text: string) => void;
  readonly onExit: () => void;
}): JSX.Element {
  const { exit } = useApp();
  const [draft, setDraft] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onExit();
      exit();
      return;
    }
    // Ctrl+C on empty draft exits
    if (key.ctrl && input === "c") {
      if (draft.length === 0) {
        onExit();
        exit();
        return;
      }
      // Ctrl+C on non-empty draft clears it
      setDraft("");
      return;
    }
    // Enter submits
    if (key.return && !key.ctrl) {
      if (draft.trim().length === 0) return;
      if (state.type === "pending") return;
      if (draftError !== null) return;
      onSubmit(draft);
      setDraft("");
      return;
    }
    // Ctrl+J inserts newline
    if (key.ctrl && input === "j") {
      setDraft((prev) => prev + "\n");
      return;
    }
    // Backspace
    if (key.backspace || key.delete) {
      setDraft((prev) => prev.slice(0, -1));
      return;
    }
    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      setDraft((prev) => prev + input);
    }
  });

  const width = Math.max(40, style.columns);
  const separator = style.unicode ? "─".repeat(width) : "-".repeat(width);
  const maxVisible = 10;
  const visibleMessages = messages.slice(-maxVisible);

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text bold>{`local-llmup / chat / ${modelId}`}</Text>
        <Text dimColor>{endpoint}</Text>
      </Box>
      <Text>{separator}</Text>

      {visibleMessages.map((msg, index) => (
        <Box key={`${String(index)}:${msg.role}`} flexDirection="row">
          <Text bold={msg.role === "user"} {...(style.color && msg.role === "assistant" ? { color: "green" } : {})}>
            {msg.role === "user" ? "> " : "  "}
            {msg.content.slice(0, 500)}
          </Text>
        </Box>
      ))}

      {state.type === "pending" ? (
        <Text dimColor>{style.unicode ? "⏳ Waiting for response…" : "... Waiting for response..."}</Text>
      ) : null}

      <Text>{separator}</Text>

      {draftError !== null ? <Text color="red">{draftError}</Text> : null}

      <Box>
        <Text>{style.unicode ? "▸ " : "> "}</Text>
        <Text>{draft.length > 0 ? draft.split("\n").slice(-3).join("\n") : ""}</Text>
        {draft.length === 0 ? <Text dimColor>(type message, Enter to send, Esc to exit)</Text> : null}
      </Box>

      <Text dimColor>
        Enter Send {style.unicode ? "·" : "|"} Ctrl+J Newline {style.unicode ? "·" : "|"} Ctrl+C Clear/Exit {style.unicode ? "·" : "|"} Esc Exit
      </Text>
    </Box>
  );
}
