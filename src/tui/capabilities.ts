import { z } from "zod";
import { ValidationError } from "../errors.js";

export type UiMode = "plain" | "json" | "tui" | "accessible";

export type UiModeReason =
  | "json_conflict"
  | "mode_conflict"
  | "forced_plain"
  | "piped_input"
  | "stdin_not_tty"
  | "stdout_not_tty"
  | "stderr_not_tty"
  | "term_missing"
  | "term_invalid"
  | "term_dumb"
  | "ci_environment"
  | "terminal_width"
  | "terminal_height";

export interface UiModeOptions {
  readonly json?: boolean | undefined;
  readonly tui?: boolean | undefined;
  readonly noTui?: boolean | undefined;
  readonly accessible?: boolean | undefined;
  readonly noColor?: boolean | undefined;
  readonly environmentNoColor?: boolean | undefined;
  readonly forceColor?: boolean | undefined;
  readonly pipedInput?: boolean | undefined;
}

export interface TerminalCapabilities {
  readonly stdinTty: boolean;
  readonly stdoutTty: boolean;
  readonly stderrTty: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly colorDepth: 1 | 4 | 8 | 24;
  readonly unicode: boolean;
  readonly ci: boolean;
  readonly term: string | null;
}

export interface UiModeSelection {
  readonly mode: UiMode;
  readonly explicit: boolean;
  readonly reason: UiModeReason | null;
  readonly color: boolean;
  readonly unicode: boolean;
}

export interface TerminalCapabilitySources {
  readonly stdin: { readonly isTTY?: boolean | undefined };
  readonly stdout: {
    readonly isTTY?: boolean | undefined;
    readonly columns?: number | undefined;
    readonly rows?: number | undefined;
    readonly getColorDepth?: (() => number) | undefined;
  };
  readonly stderr: { readonly isTTY?: boolean | undefined };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

export class UiModeValidationError extends ValidationError {
  readonly reason: UiModeReason;

  constructor(reason: UiModeReason) {
    super(`interactive UI is incompatible with this invocation (${reason})`);
    this.name = "UiModeValidationError";
    this.reason = reason;
  }
}

const UiModeOptionsSchema = z
  .object({
    json: z.boolean().optional(),
    tui: z.boolean().optional(),
    noTui: z.boolean().optional(),
    accessible: z.boolean().optional(),
    noColor: z.boolean().optional(),
    environmentNoColor: z.boolean().optional(),
    forceColor: z.boolean().optional(),
    pipedInput: z.boolean().optional(),
  })
  .strict();

const TerminalCapabilitiesSchema = z
  .object({
    stdinTty: z.boolean(),
    stdoutTty: z.boolean(),
    stderrTty: z.boolean(),
    columns: z.number().int().min(0).max(10_000),
    rows: z.number().int().min(0).max(10_000),
    colorDepth: z.union([z.literal(1), z.literal(4), z.literal(8), z.literal(24)]),
    unicode: z.boolean(),
    ci: z.boolean(),
    term: z.string().max(256).nullable(),
  })
  .strict();

const VISUAL_MIN_COLUMNS = 60;
const VISUAL_MIN_ROWS = 16;
const ACCESSIBLE_MIN_COLUMNS = 40;
const ACCESSIBLE_MIN_ROWS = 10;
const TERMINAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

const REASON_ORDER: readonly UiModeReason[] = [
  "piped_input",
  "stdin_not_tty",
  "stdout_not_tty",
  "stderr_not_tty",
  "term_missing",
  "term_invalid",
  "term_dumb",
  "ci_environment",
  "terminal_width",
  "terminal_height",
];

const RECOGNIZED_CI_VALUES = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITLAB_CI: "true",
  TF_BUILD: "True",
  BUILDKITE: "true",
} as const;

export function detectCiEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  for (const [name, value] of Object.entries(RECOGNIZED_CI_VALUES)) {
    if (env[name] === value) return true;
  }
  return Object.prototype.hasOwnProperty.call(env, "JENKINS_URL");
}

export function detectNoColorEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
}

function safeDimension(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 10_000
    ? value
    : 0;
}

function safeColorDepth(getColorDepth: (() => number) | undefined): 1 | 4 | 8 | 24 {
  if (getColorDepth === undefined) return 1;
  try {
    const depth = getColorDepth();
    return depth === 4 || depth === 8 || depth === 24 ? depth : 1;
  } catch {
    return 1;
  }
}

function supportsUnicode(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  term: string | null,
): boolean {
  if (term === null || !TERMINAL_NAME_RE.test(term) || term.toLowerCase() === "dumb") return false;
  if (platform === "win32") {
    return env.WT_SESSION !== undefined || env.TERM_PROGRAM === "vscode";
  }
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  return locale !== undefined && /utf-?8/iu.test(locale);
}

/** Capture one conservative terminal snapshot before renderer loading. */
export function captureTerminalCapabilities(
  sources: TerminalCapabilitySources = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    platform: process.platform,
  },
): TerminalCapabilities {
  const rawTerm = sources.env.TERM;
  const term =
    typeof rawTerm !== "string" || rawTerm.length === 0
      ? null
      : rawTerm.length <= 256
        ? rawTerm
        : "?";
  return TerminalCapabilitiesSchema.parse({
    stdinTty: sources.stdin.isTTY === true,
    stdoutTty: sources.stdout.isTTY === true,
    stderrTty: sources.stderr.isTTY === true,
    columns: safeDimension(sources.stdout.columns),
    rows: safeDimension(sources.stdout.rows),
    colorDepth: safeColorDepth(sources.stdout.getColorDepth),
    unicode: supportsUnicode(sources.env, sources.platform, term),
    ci: detectCiEnvironment(sources.env),
    term,
  });
}

function ineligibilityReason(
  options: UiModeOptions,
  capabilities: TerminalCapabilities,
  accessible: boolean,
): UiModeReason | null {
  const failed = new Set<UiModeReason>();
  if (options.pipedInput === true) failed.add("piped_input");
  if (!capabilities.stdinTty) failed.add("stdin_not_tty");
  if (!capabilities.stdoutTty) failed.add("stdout_not_tty");
  if (!capabilities.stderrTty) failed.add("stderr_not_tty");
  if (capabilities.term === null || capabilities.term.length === 0) failed.add("term_missing");
  else if (!TERMINAL_NAME_RE.test(capabilities.term)) failed.add("term_invalid");
  else if (capabilities.term.toLowerCase() === "dumb") failed.add("term_dumb");
  if (capabilities.ci) failed.add("ci_environment");
  const minimumColumns = accessible ? ACCESSIBLE_MIN_COLUMNS : VISUAL_MIN_COLUMNS;
  const minimumRows = accessible ? ACCESSIBLE_MIN_ROWS : VISUAL_MIN_ROWS;
  if (capabilities.columns < minimumColumns) failed.add("terminal_width");
  if (capabilities.rows < minimumRows) failed.add("terminal_height");
  return REASON_ORDER.find((reason) => failed.has(reason)) ?? null;
}

function selection(
  mode: UiMode,
  explicit: boolean,
  reason: UiModeReason | null,
  options: UiModeOptions,
  capabilities: TerminalCapabilities,
): UiModeSelection {
  const color =
    mode === "tui" &&
    options.noColor !== true &&
    options.environmentNoColor !== true &&
    capabilities.colorDepth > 1;
  return {
    mode,
    explicit,
    reason,
    color,
    unicode: mode === "tui" && capabilities.unicode,
  };
}

/** Resolve one deterministic presentation mode before any command-domain work. */
export function resolveUiMode(
  rawOptions: UiModeOptions,
  rawCapabilities: TerminalCapabilities,
): UiModeSelection {
  const parsedOptions = UiModeOptionsSchema.safeParse(rawOptions);
  if (!parsedOptions.success) {
    throw new ValidationError("invalid interactive UI mode options", {
      cause: parsedOptions.error,
    });
  }
  const parsedCapabilities = TerminalCapabilitiesSchema.safeParse(rawCapabilities);
  if (!parsedCapabilities.success) {
    throw new ValidationError("invalid terminal capabilities", {
      cause: parsedCapabilities.error,
    });
  }
  const options = parsedOptions.data;
  const capabilities = parsedCapabilities.data;

  if (options.json === true && (options.tui === true || options.accessible === true)) {
    throw new UiModeValidationError("json_conflict");
  }
  if (options.noTui === true && (options.tui === true || options.accessible === true)) {
    throw new UiModeValidationError("mode_conflict");
  }
  if (options.json === true) return selection("json", true, null, options, capabilities);
  if (options.noTui === true) {
    return selection("plain", true, "forced_plain", options, capabilities);
  }

  const accessible = options.accessible === true;
  const reason = ineligibilityReason(options, capabilities, accessible);
  const explicit = options.tui === true || accessible;
  if (reason !== null) {
    if (explicit) throw new UiModeValidationError(reason);
    return selection("plain", false, reason, options, capabilities);
  }
  return selection(accessible ? "accessible" : "tui", explicit, null, options, capabilities);
}

/** Capture terminal and environment policy atomically, then resolve mode. */
export function resolveUiModeFromSources(
  options: UiModeOptions,
  sources?: TerminalCapabilitySources,
): UiModeSelection {
  const effectiveOptions: UiModeOptions = {
    ...options,
    environmentNoColor:
      options.environmentNoColor === true ||
      detectNoColorEnvironment(sources?.env ?? process.env),
  };
  return resolveUiMode(effectiveOptions, captureTerminalCapabilities(sources));
}
