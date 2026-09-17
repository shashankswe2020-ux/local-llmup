import { z } from "zod";
import { ValidationError } from "./errors.js";

export const CONTEXT_CEILING = 10_000_000;
export const ContextTokensSchema = z.number().int().min(1).max(CONTEXT_CEILING);

export function parseContextTokens(raw: string): number {
  const parsed = ContextTokensSchema.safeParse(Number(raw));
  if (!parsed.success) {
    throw new ValidationError(
      `--context must be an integer in 1..${String(CONTEXT_CEILING)}: ${raw}`,
    );
  }
  return parsed.data;
}
