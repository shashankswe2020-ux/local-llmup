import { sanitizeTerminalText } from "./sanitize.js";
import type {
  LifecycleReviewDecision,
  LifecycleReviewViewModel,
} from "./lifecycle-types.js";

export interface AccessibleLifecycleReviewOptions {
  readonly viewModel: LifecycleReviewViewModel;
  readonly readLine: () => Promise<string | null>;
  readonly write: (text: string) => void;
}

/** Run one cooked, numbered confirmation. Empty input and EOF both cancel. */
export async function runAccessibleLifecycleReview(
  options: AccessibleLifecycleReviewOptions,
): Promise<LifecycleReviewDecision> {
  const title = sanitizeTerminalText(options.viewModel.title, "single_line");
  const lines = options.viewModel.lines.map((line) =>
    sanitizeTerminalText(line, "single_line"),
  );
  const confirm = sanitizeTerminalText(options.viewModel.confirmLabel, "single_line");
  options.write(
    `${[`local-llmup / ${options.viewModel.screen} / Accessible`, title, ...lines, "1. Cancel (default)", `2. ${confirm}`, "Choose 1 or 2, then press Enter:"].join("\n")}\n`,
  );
  const answer = await options.readLine();
  return answer?.trim() === "2" ? { type: "accepted" } : { type: "cancelled" };
}
