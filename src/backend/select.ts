/**
 * `select()` resolves which backend {@link BackendAdapter} a serving command
 * should use, splitting on command intent (spec §2.2):
 *
 *  - **create-intent** (`up`): precedence is flag → env → config → auto-detect.
 *  - **attach-intent** (`down`/`switch`/`chat`/`migrate`): the active server's
 *    backend (from `state.active.backend`) dominates, and an explicit
 *    `--backend`/env that conflicts with it is a {@link ValidationError}.
 *
 * Selection is a **serving-path** concern only: the advice commands
 * (`recommend`/`can-run`/`doctor`) never call `select()`, so the `isInstalled()`
 * probe (reached solely by the auto-detect branch) stays off the deterministic
 * advice path.
 */
import { BackendError, ValidationError } from "../errors.js";
import type { Arch, BackendName, Platform } from "../types.js";
import type { BackendAdapter } from "./adapter.js";
import type { BackendRegistry } from "./registry.js";
import { backendSupportsPlatform } from "./platform.js";

/** Environment variable that overrides the backend for a single invocation. */
export const ENV_BACKEND_OVERRIDE = "LOCAL_LLMUP_BACKEND";

/** Whether the command is starting a new server or acting on the active one. */
export type SelectIntent = "create" | "attach";

/** Which input determined the selected backend (for messaging and tests). */
export type SelectSource = "flag" | "env" | "config" | "auto" | "state";

/** Inputs to {@link select}. */
export interface SelectInputs {
  readonly intent: SelectIntent;
  readonly registry: BackendRegistry;
  /** Explicit `--backend` flag value (highest precedence for create-intent). */
  readonly flag?: string | undefined;
  /** Environment map to read {@link ENV_BACKEND_OVERRIDE} from. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The user config's `defaultBackend` (create-intent only). */
  readonly configBackend?: BackendName | undefined;
  /** The active server's backend from state (attach-intent only). */
  readonly activeBackend?: BackendName | undefined;
  /** Platform for auto-detect priority ordering. */
  readonly platform?: Platform | undefined;
  /** Arch for auto-detect priority ordering. */
  readonly arch?: Arch | undefined;
  /** Model-compatible backend names used only by the auto-detect branch. */
  readonly autoCandidates?: readonly BackendName[] | undefined;
}

/** The resolved adapter and the input that determined it. */
export interface SelectResult {
  readonly adapter: BackendAdapter;
  readonly source: SelectSource;
}

/**
 * Auto-detect priority order (spec §10 Q1): on Apple Silicon prefer MLX, then
 * Ollama, then llama.cpp; elsewhere Ollama then llama.cpp. LM Studio is
 * deliberately excluded — it is an attach-only, opt-in backend and is never
 * auto-selected. Exported so `doctor` can report the machine's auto-selected
 * default without duplicating the ordering (it never calls `select()` itself).
 */
export function autoDetectPriority(
  platform: Platform | undefined,
  arch: Arch | undefined,
): readonly BackendName[] {
  return (["mlx", "ollama", "llamacpp"] as const).filter((backend) =>
    backendSupportsPlatform(backend, { platform, arch }),
  );
}

/** True when an adapter with `name` is registered, without throwing. */
function isRegistered(registry: BackendRegistry, name: string): boolean {
  return registry.all().some((adapter) => adapter.name === name);
}

/** Read a trimmed, non-blank backend override from the environment. */
function readEnvBackend(env: NodeJS.ProcessEnv | undefined): string | undefined {
  const raw = env?.[ENV_BACKEND_OVERRIDE]?.trim();
  return raw ? raw : undefined;
}

/** Trim a flag to a non-blank value, or `undefined` when absent/blank. */
function normalizeFlag(flag: string | undefined): string | undefined {
  const trimmed = flag?.trim();
  return trimmed ? trimmed : undefined;
}

export async function select(inputs: SelectInputs): Promise<SelectResult> {
  const flag = normalizeFlag(inputs.flag);
  const envBackend = readEnvBackend(inputs.env);

  if (inputs.intent === "attach") {
    return selectAttach(inputs.registry, inputs.activeBackend, flag, envBackend);
  }
  return selectCreate(inputs, flag, envBackend);
}

/**
 * Attach-intent: the active server's backend is authoritative. An explicit
 * `--backend`/env that names a different backend cannot silently retarget a
 * running server, so it fails closed.
 */
function selectAttach(
  registry: BackendRegistry,
  activeBackend: BackendName | undefined,
  flag: string | undefined,
  envBackend: string | undefined,
): SelectResult {
  if (activeBackend === undefined) {
    throw new ValidationError("no active server to attach to");
  }

  // Check the flag and env independently so a matching flag cannot mask a
  // conflicting env override (defense-in-depth: neither may silently retarget
  // a running server).
  if (flag !== undefined && flag !== activeBackend) {
    throw attachConflict(activeBackend, "--backend", flag);
  }
  if (envBackend !== undefined && envBackend !== activeBackend) {
    throw attachConflict(activeBackend, ENV_BACKEND_OVERRIDE, envBackend);
  }

  return { adapter: registry.get(activeBackend), source: "state" };
}

/** Build the fail-closed error for an override that conflicts with the active backend. */
function attachConflict(activeBackend: BackendName, via: string, requested: string): ValidationError {
  return new ValidationError(
    `active server uses backend "${activeBackend}"; ${via} "${requested}" cannot change it — stop it first`,
  );
}

/** Create-intent: flag → env → config → auto-detect. */
async function selectCreate(
  inputs: SelectInputs,
  flag: string | undefined,
  envBackend: string | undefined,
): Promise<SelectResult> {
  const { registry } = inputs;

  // Flag and env are explicit user intent: an unknown name is a hard error.
  if (flag !== undefined) {
    return { adapter: registry.get(flag), source: "flag" };
  }
  if (envBackend !== undefined) {
    return { adapter: registry.get(envBackend), source: "env" };
  }

  // Config is a stored preference: a valid name that is not registered in this
  // build (e.g. "llamacpp" before Phase 2) falls through to auto-detect rather
  // than erroring — never pass an unregistered name to registry.get().
  if (inputs.configBackend !== undefined && isRegistered(registry, inputs.configBackend)) {
    return { adapter: registry.get(inputs.configBackend), source: "config" };
  }

  return autoSelect(registry, inputs.platform, inputs.arch, inputs.autoCandidates);
}

/**
 * Rank the **installed** backends by platform priority and pick the first. When
 * none of the auto-eligible backends is installed, fail closed with the install
 * hints for the backends this machine could serve.
 */
async function autoSelect(
  registry: BackendRegistry,
  platform: Platform | undefined,
  arch: Arch | undefined,
  candidates: readonly BackendName[] | undefined,
): Promise<SelectResult> {
  const allowed = candidates === undefined ? undefined : new Set(candidates);
  const installed = await registry.available();
  for (const name of autoDetectPriority(platform, arch)) {
    if (allowed !== undefined && !allowed.has(name)) continue;
    const match = installed.find((adapter) => adapter.name === name);
    if (match !== undefined) {
      return { adapter: match, source: "auto" };
    }
  }
  throw new BackendError(noServableBackendMessage(registry, platform, arch, allowed));
}

/** Compose a fail-closed message listing the install hints for servable backends. */
function noServableBackendMessage(
  registry: BackendRegistry,
  platform: Platform | undefined,
  arch: Arch | undefined,
  allowed: ReadonlySet<BackendName> | undefined,
): string {
  const hints = autoDetectPriority(platform, arch)
    .filter((name) => isRegistered(registry, name))
    .filter((name) => allowed === undefined || allowed.has(name))
    .map((name) => `  ${name}: ${registry.get(name).installHint()}`);
  const body = hints.length > 0 ? `\n${hints.join("\n")}` : "";
  return `no installed backend can serve; install one of:${body}`;
}
