import { sanitizeTerminalText } from "./sanitize.js";
import { validateModelPickerChoices } from "./model-picker-choices.js";

const VISIBLE_CHOICES = 20;

export interface AccessibleModelPickerOptions {
  readonly title: string;
  readonly choices: readonly string[];
  readonly readLine: () => Promise<string | null>;
  readonly write: (text: string) => void;
}

/** Run a bounded picker with cooked numbered input and no visual renderer import. */
export async function runAccessibleModelPicker(
  options: AccessibleModelPickerOptions,
): Promise<string | null> {
  const choices = validateModelPickerChoices(options.choices);
  options.write(`${sanitizeTerminalText(options.title, "single_line")}\n`);
  choices.slice(0, VISIBLE_CHOICES).forEach((choice, index) =>
    options.write(
      `${String(index + 1)}. ${sanitizeTerminalText(choice, "action_identifier")}\n`,
    ),
  );
  if (choices.length > VISIBLE_CHOICES) {
    options.write(
      `Showing first ${String(VISIBLE_CHOICES)} of ${String(choices.length)} models. Enter any catalog number directly.\n`,
    );
  }
  options.write("Enter a model number, or q to cancel.\n");
  for (;;) {
    const raw = await options.readLine();
    if (raw === null || raw.trim() === "q") return null;
    const index = Number(raw.trim()) - 1;
    if (Number.isSafeInteger(index) && index >= 0 && index < choices.length) {
      return choices[index] ?? null;
    }
    options.write("No such model. Enter a listed number, or q to cancel.\n");
  }
}
