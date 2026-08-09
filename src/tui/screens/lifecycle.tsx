import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type {
  LifecycleProgressItem,
  LifecycleReviewDecision,
  LifecycleReviewViewModel,
  LifecycleScreen,
} from "../lifecycle-types.js";

export interface LifecycleStyle {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly columns: number;
}

export function LifecycleReviewScreen({
  viewModel,
  style,
  onDecision,
}: {
  readonly viewModel: LifecycleReviewViewModel;
  readonly style: LifecycleStyle;
  readonly onDecision: (decision: LifecycleReviewDecision) => void;
}): JSX.Element {
  const { exit } = useApp();
  const [confirmSelected, setConfirmSelected] = useState(false);
  const decide = (decision: LifecycleReviewDecision): void => {
    onDecision(decision);
    exit();
  };
  useInput((input, key) => {
    if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setConfirmSelected((selected) => !selected);
      return;
    }
    if (key.return) {
      decide(confirmSelected ? { type: "accepted" } : { type: "cancelled" });
      return;
    }
    if (key.escape || input === "q" || (key.ctrl && input === "c")) {
      decide({ type: "cancelled" });
    }
  });

  return (
    <Box flexDirection="column" width={Math.max(40, style.columns)}>
      <Box justifyContent="space-between">
        <Text bold>{`local-llmup / ${viewModel.screen}`}</Text>
        <Text dimColor>{viewModel.destructive ? "Destructive review" : "Review"}</Text>
      </Box>
      <Text>{style.unicode ? "─".repeat(72) : "-".repeat(72)}</Text>
      <Text bold>{viewModel.title}</Text>
      {viewModel.lines.map((line, index) => (
        <Text key={`${String(index)}:${line}`}>{line}</Text>
      ))}
      <Text> </Text>
      <Text inverse={!confirmSelected}>{` Cancel [default] `}</Text>
      <Text inverse={confirmSelected}>{` ${viewModel.confirmLabel} `}</Text>
      <Text dimColor>Tab/Arrows Select · Enter Continue · Esc/q Cancel</Text>
    </Box>
  );
}

function marker(item: LifecycleProgressItem, unicode: boolean): string {
  if (item.type === "completed") return unicode ? "✓" : "OK";
  if (item.type === "failed") return unicode ? "✗" : "FAIL";
  return unicode ? "●" : "..";
}

export function LifecycleProgressScreen({
  screen,
  target,
  subscribe,
  style,
}: {
  readonly screen: LifecycleScreen;
  readonly target: string;
  readonly subscribe: (
    listener: (events: readonly LifecycleProgressItem[]) => void,
  ) => () => void;
  readonly style: LifecycleStyle;
}): JSX.Element {
  const [events, setEvents] = useState<readonly LifecycleProgressItem[]>([]);
  useEffect(() => subscribe(setEvents), [subscribe]);
  return (
    <Box flexDirection="column" width={Math.max(40, style.columns)}>
      <Box justifyContent="space-between">
        <Text bold>{`local-llmup / ${screen} / ${target}`}</Text>
        <Text dimColor>Lifecycle execution in progress</Text>
      </Box>
      <Text>{style.unicode ? "─".repeat(72) : "-".repeat(72)}</Text>
      {events.length === 0 ? <Text>Preparing…</Text> : null}
      {events.map((event, index) => (
        <Text key={`${String(index)}:${event.phase}:${event.type}`}>
          {`${marker(event, style.unicode)} ${event.label}`}
        </Text>
      ))}
    </Box>
  );
}
