/**
 * A chat harness routes a single turn to a local or remote LLM provider. The
 * harness layer is intentionally separate from the local backend lifecycle in
 * `src/backend/` so the CLI, GUI, and future routing workers can share the same
 * contracts without coupling to transport specifics.
 */
import { z } from "zod";
import { stripControl } from "../sanitize.js";

/** Canonical built-in harness names in stable registration order. */
export const HARNESS_NAMES = ["local", "claude", "openai", "openai-compatible"] as const;

/** Stable valid harness names. */
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** A message payload accepted by any harness implementation. */
export interface HarnessMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Inputs for a single harness round trip. */
export interface HarnessChatRequest {
  readonly model: string;
  readonly messages: readonly HarnessMessage[];
  readonly signal?: AbortSignal | undefined;
}

/** A chat harness routes one prompt to a provider and yields streaming chunks. */
export interface ChatHarness {
  /** Stable provider identifier used by the registry and memory metadata. */
  readonly name: HarnessName;
  /** Human-readable explanation when the harness is unavailable. */
  readonly unavailableHint: string;
  /** Whether the harness is usable in the current runtime environment. */
  isAvailable(): Promise<boolean>;
  /** Yield chunks for a single user turn as the provider streams results. */
  chat(request: HarnessChatRequest): AsyncIterable<string>;
  /** Convenience method for non-streaming callers to collect the full reply. */
  chatSync(request: HarnessChatRequest): Promise<string>;
}

/** Type guard for harness names. */
export function isHarnessName(value: string): value is HarnessName {
  return HARNESS_NAMES.includes(value as HarnessName);
}

const harnessSchema = z.enum(HARNESS_NAMES);

/** Parse and validate a harness name at the command boundary. */
export function parseHarnessName(raw: string): HarnessName {
  const parsed = harnessSchema.safeParse(stripControl(raw).trim());
  if (!parsed.success) {
    throw new Error(`--harness must be one of ${HARNESS_NAMES.join("|")}: ${stripControl(raw)}`);
  }
  return parsed.data;
}

/** Build a minimal harness implementation for registry bootstrap and tests. */
export function createStaticHarness(name: HarnessName, unavailableHint: string): ChatHarness {
  return {
    name,
    unavailableHint,
    async isAvailable(): Promise<boolean> {
      return false;
    },
    async *chat(_request: HarnessChatRequest): AsyncIterable<string> {
      yield "";
    },
    async chatSync(_request: HarnessChatRequest): Promise<string> {
      return "";
    },
  };
}
