import { isSafeModelId } from "../backend/net.js";
import { ValidationError } from "../errors.js";
import { sanitizeActionIdentifier } from "./sanitize.js";

const MAX_CHOICES = 1_000;

/** Validate and freeze bounded canonical model-picker choices. */
export function validateModelPickerChoices(choices: readonly string[]): readonly string[] {
  if (choices.length < 1 || choices.length > MAX_CHOICES) {
    throw new ValidationError("model picker requires 1..1000 choices");
  }
  const unique = new Set<string>();
  for (const choice of choices) {
    if (Buffer.byteLength(choice, "utf8") > 8 * 1024) {
      throw new ValidationError("model picker model id exceeds 8192 bytes");
    }
    const validated = sanitizeActionIdentifier(
      choice,
      (value) => isSafeModelId(value) && !value.split("/").includes(".."),
    );
    if (!validated.actionable) throw new ValidationError("model picker received unsafe model id");
    if (unique.has(validated.canonical)) {
      throw new ValidationError("model picker received duplicate model id");
    }
    unique.add(validated.canonical);
  }
  return Object.freeze([...unique]);
}
