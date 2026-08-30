/**
 * Local tool policy for the GUI agent loop (task 32.8, Gate 3).
 *
 * MCP connector metadata is untrusted, so risk is classified locally and every
 * call requires approval by default. A session may grant an exact tool
 * (connector + name + input schema, bound to the policy version) so repeated
 * calls of the same tool are not re-prompted; any change to those identities —
 * or a session/workspace switch — invalidates the grant because the key or the
 * whole store changes.
 */
import { createHash } from "node:crypto";

/** Risk classes in ascending severity; unknown is treated as the strongest. */
export type ToolRisk = "read-only" | "process-network" | "workspace-mutation" | "unknown";

/** A user decision for one proposed tool call. */
export type ToolDecision = "approve-once" | "allow-session" | "deny";

/** Bumped when classification or redaction changes so old grants re-prompt. */
export const TOOL_POLICY_VERSION = 1;

/** Cap on redacted argument/result text surfaced to the UI. */
const MAX_REDACTED_CHARS = 2 * 1024;

const MUTATION_WORDS = new Set([
  "write", "create", "delete", "remove", "edit", "apply", "patch", "move",
  "rename", "mkdir", "rmdir", "chmod", "put", "update", "insert", "drop",
]);
const PROCESS_NET_WORDS = new Set([
  "exec", "execute", "run", "shell", "command", "spawn", "fetch", "http",
  "https", "request", "curl", "wget", "download", "upload", "network", "socket", "ssh",
]);
const READ_ONLY_WORDS = new Set([
  "read", "get", "list", "search", "find", "show", "view", "cat", "status",
  "diff", "log", "query", "describe", "inspect", "lookup",
]);

const SECRET_KEY_RE = /(token|secret|key|password|passwd|pwd|auth|credential|cookie|session|bearer|api[-_]?key)/iu;

/** Split a name/description into lowercase word tokens (snake_case + camelCase). */
function wordTokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Classify a tool's risk from its untrusted name/description. Anything that is
 * not clearly read-only defaults upward, and no signal at all is `unknown`.
 */
export function classifyToolRisk(tool: { readonly name: string; readonly description?: string | undefined }): ToolRisk {
  const tokens = wordTokens(`${tool.name} ${tool.description ?? ""}`);
  if (tokens.some((token) => MUTATION_WORDS.has(token))) {
    return "workspace-mutation";
  }
  if (tokens.some((token) => PROCESS_NET_WORDS.has(token))) {
    return "process-network";
  }
  if (tokens.some((token) => READ_ONLY_WORDS.has(token))) {
    return "read-only";
  }
  return "unknown";
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 4) {
    return "[…]";
  }
  if (typeof value === "string") {
    // Long opaque strings are likely secrets/blobs; keep a bounded preview.
    return value.length > 256 ? `${value.slice(0, 64)}… [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** Produce a bounded, secret-redacted view of tool arguments for the UI/audit. */
export function redactToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(args, 0);
  return redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

/** Produce a bounded, secret-redacted preview of a tool result string. */
export function redactToolResult(text: string): { readonly text: string; readonly truncated: boolean } {
  const masked = text.replace(
    /\b([A-Za-z0-9_-]{24,})\b/gu,
    (match) => (looksLikeSecret(match) ? "[redacted]" : match),
  );
  if (masked.length <= MAX_REDACTED_CHARS) {
    return { text: masked, truncated: false };
  }
  return { text: `${masked.slice(0, MAX_REDACTED_CHARS)}…`, truncated: true };
}

function looksLikeSecret(token: string): boolean {
  const hasMixed = /[A-Za-z]/u.test(token) && /[0-9]/u.test(token);
  return hasMixed && token.length >= 24;
}

/**
 * Stable key for a session tool grant. Binds connector, tool name, and input
 * schema to the policy version, so a schema/connector/policy change re-prompts.
 */
export function toolGrantKey(input: {
  readonly connectorId: string;
  readonly name: string;
  readonly schema?: Record<string, unknown> | undefined;
}): string {
  const schemaHash = createHash("sha256")
    .update(JSON.stringify(input.schema ?? {}))
    .digest("hex")
    .slice(0, 16);
  return `${TOOL_POLICY_VERSION}:${input.connectorId}:${input.name}:${schemaHash}`;
}
