import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

export interface InferenceUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
}
export type UsageProvider = "openai" | "claude" | "ollama";
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fields = z
  .object({
    prompt_tokens: z.unknown().optional(),
    completion_tokens: z.unknown().optional(),
    input_tokens: z.unknown().optional(),
    output_tokens: z.unknown().optional(),
    cache_read_input_tokens: z.unknown().optional(),
    cache_creation_input_tokens: z.unknown().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.unknown().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
const envelope = z
  .object({
    usage: z.unknown().optional(),
    message: z.object({ usage: z.unknown().optional() }).passthrough().optional(),
    prompt_eval_count: z.unknown().optional(),
    eval_count: z.unknown().optional(),
  })
  .passthrough();
export function emptyInferenceUsage(): InferenceUsage {
  return { inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null };
}
function count(value: unknown): number | null {
  const result = counter.safeParse(value);
  return result.success ? result.data : null;
}
export function parseInferenceUsage(raw: unknown, provider: UsageProvider): InferenceUsage {
  const result = emptyInferenceUsage();
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return result;
  if (provider === "ollama") {
    result.inputTokens = count(parsed.data.prompt_eval_count);
    result.outputTokens = count(parsed.data.eval_count);
    return result;
  }
  const usage = fields.safeParse(parsed.data.usage ?? parsed.data.message?.usage);
  if (!usage.success) return result;
  const data = usage.data;
  if (provider === "claude") {
    const input = count(data.input_tokens);
    const hits = count(data.cache_read_input_tokens);
    const writes = count(data.cache_creation_input_tokens);
    result.outputTokens = count(data.output_tokens);
    if (input !== null && hits !== null && writes !== null) {
      result.inputTokens = count(input + hits + writes);
      if (result.inputTokens !== null) {
        result.cacheHitTokens = hits;
        result.cacheMissTokens = input + writes;
      }
    } else if (
      data.cache_read_input_tokens === undefined &&
      data.cache_creation_input_tokens === undefined
    )
      result.inputTokens = input;
  } else {
    result.inputTokens = count(data.prompt_tokens);
    result.outputTokens = count(data.completion_tokens);
    const hits = count(data.prompt_tokens_details?.cached_tokens);
    if (hits !== null && result.inputTokens !== null && hits <= result.inputTokens) {
      result.cacheHitTokens = hits;
      result.cacheMissTokens = result.inputTokens - hits;
    }
  }
  return result;
}
const context = new AsyncLocalStorage<{ usage: InferenceUsage }>();
export function beginInferenceUsage(): void {
  const store = context.getStore();
  if (store) store.usage = emptyInferenceUsage();
}
export function recordInferenceUsage(raw: unknown, provider: UsageProvider): void {
  const store = context.getStore();
  if (!store) return;
  const usage = parseInferenceUsage(raw, provider);
  for (const key of Object.keys(usage) as (keyof InferenceUsage)[])
    if (usage[key] !== null) store.usage[key] = usage[key];
}
export async function captureInferenceUsage<ResultValue>(
  operation: () => Promise<ResultValue>,
): Promise<{ result: ResultValue; usage: InferenceUsage }> {
  const store = { usage: emptyInferenceUsage() };
  return context.run(store, async () => ({ result: await operation(), usage: store.usage }));
}
