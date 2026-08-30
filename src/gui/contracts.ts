/**
 * Versioned contracts for the chat panel workspace experience (task 32.1).
 *
 * These schemas are additive: they describe the run state machine, the
 * streamed SSE event union currently emitted by {@link GuiServer}, and the
 * structured error envelope. Legacy routes keep their existing shapes during
 * preview; new work validates against the schemas here so both the server and
 * the extracted client modules share one source of truth.
 */
import { z } from "zod";

/** Schema version stamped on new events and persisted documents. */
export const GUI_SCHEMA_VERSION = 1;

/**
 * Run lifecycle states. Mirrors the plan's state machine:
 *
 *   queued -> assembling-context
 *     -> awaiting-disclosure | awaiting-tool-approval | running
 *     -> stopping
 *     -> completed | cancelled | failed
 */
export const RUN_STATES = [
  "queued",
  "assembling-context",
  "awaiting-disclosure",
  "awaiting-tool-approval",
  "running",
  "stopping",
  "completed",
  "cancelled",
  "failed",
] as const;

export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

/** Mutually exclusive terminal states. A run reaches exactly one of these. */
export const TERMINAL_RUN_STATES = ["completed", "cancelled", "failed"] as const;
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["assembling-context", "cancelled", "failed"],
  "assembling-context": [
    "awaiting-disclosure",
    "awaiting-tool-approval",
    "running",
    "cancelled",
    "failed",
  ],
  "awaiting-disclosure": ["awaiting-tool-approval", "running", "cancelled", "failed"],
  "awaiting-tool-approval": ["running", "cancelled", "failed"],
  running: ["awaiting-tool-approval", "stopping", "completed", "failed"],
  stopping: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

/** True when `state` admits no further transitions. */
export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
}

/** True when a run may move from `from` to `to`. Invalid pairs fail closed. */
export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

// --- Streamed SSE events (current wire shapes, retained during preview) ------

export const DeltaEventSchema = z.object({
  type: z.literal("delta"),
  content: z.string(),
});

export const ToolEventSchema = z.object({
  type: z.literal("tool"),
  phase: z.enum(["proposed", "approval-required", "start", "done", "denied"]),
  callId: z.string().min(1),
  name: z.string().min(1),
  connector: z.string().optional(),
  risk: z.enum(["read-only", "process-network", "workspace-mutation", "unknown"]).optional(),
  arguments: z.record(z.unknown()).optional(),
  result: z.string().optional(),
  resultTruncated: z.boolean().optional(),
  isError: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const DoneEventSchema = z.object({
  type: z.literal("done"),
  turnsAppended: z.number().int().nonnegative(),
  factsExtracted: z.number().int().nonnegative(),
  vectorsEmbedded: z.number().int().nonnegative(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

// --- Workspace context attachments (task 32.6) -------------------------------

/** Upper bounds for `@file` context so a request stays small and predictable. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_CONTEXT_BYTES = 256 * 1024;

/** Bounds for explicitly pasted/imported context and Git output (task 32.7). */
export const MAX_CONTEXT_SOURCES = 10;
export const MAX_PASTED_CONTEXT_BYTES = 64 * 1024;

/** Kinds of context that appear in the ledger. Files come from `@file` refs. */
export const CONTEXT_SOURCE_KINDS = ["file", "terminal", "diagnostics", "git"] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

/** A client-supplied reference the server re-reads into an immutable snapshot. */
export const WorkspaceAttachmentRefSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type WorkspaceAttachmentRef = z.infer<typeof WorkspaceAttachmentRefSchema>;

/**
 * A non-file context source the user attached explicitly. Terminal and
 * diagnostic text is pasted/imported by the user (never executed); a Git source
 * is computed read-only from a registered workspace root.
 */
export const ContextSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal"),
    label: z.string().max(120).optional(),
    content: z.string().min(1).max(MAX_PASTED_CONTEXT_BYTES),
  }),
  z.object({
    kind: z.literal("diagnostics"),
    label: z.string().max(120).optional(),
    content: z.string().min(1).max(MAX_PASTED_CONTEXT_BYTES),
  }),
  z.object({
    kind: z.literal("git"),
    workspaceId: z.string().min(1).max(128),
    mode: z.enum(["status", "diff"]),
  }),
]);
export type ContextSourceRef = z.infer<typeof ContextSourceRefSchema>;

const LineRangeSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

/**
 * A resolved manifest entry recording exactly the context the model saw. It
 * carries no content — only the auditable identity (kind, label/path, hash,
 * size, range, truncation) plus whether it was included under the byte budget.
 * `kind` and `label` are optional for backward compatibility with file-only
 * entries, where `kind` defaults to `file` and the label falls back to `path`.
 */
export const AttachmentManifestEntrySchema = z.object({
  kind: z.enum(CONTEXT_SOURCE_KINDS).optional(),
  label: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  hash: z.string().min(1),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  included: z.boolean(),
  range: LineRangeSchema.optional(),
});
export type AttachmentManifestEntry = z.infer<typeof AttachmentManifestEntrySchema>;

/** Streamed once per run, before deltas, so the client can show a context ledger. */
export const ContextEventSchema = z.object({
  type: z.literal("context"),
  attachments: z.array(AttachmentManifestEntrySchema),
});

/**
 * Streamed instead of any content when workspace context is bound for an
 * external (cloud) provider and no disclosure has been recorded for this
 * session/provider/context set. The run sends nothing until the user confirms.
 */
export const DisclosureRequiredEventSchema = z.object({
  type: z.literal("disclosure-required"),
  provider: z.string().min(1),
  model: z.string().min(1),
  items: z.array(AttachmentManifestEntrySchema),
  totalBytes: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
});

// --- Edit proposal review (task 32.9) ----------------------------------------

const DiffLineSchema = z.object({
  type: z.enum(["context", "add", "del"]),
  text: z.string(),
});
const DiffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(DiffLineSchema),
});
export const ProposalReviewFileSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["update", "create", "delete"]),
  baseHash: z.string().optional(),
  resultHash: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  hunks: z.array(DiffHunkSchema),
  warnings: z.array(z.string()),
});
export const ProposalReviewSchema = z.object({
  proposalId: z.string().min(1),
  files: z.array(ProposalReviewFileSchema),
  warnings: z.array(z.string()),
});
export type ProposalReviewContract = z.infer<typeof ProposalReviewSchema>;

/** Streamed when the model/tool proposes edits; the review is inert (no writes). */
export const EditEventSchema = z.object({
  type: z.literal("edit"),
  review: ProposalReviewSchema,
  /** Present when the client may apply this proposal (echoed for a stateless apply). */
  workspaceId: z.string().min(1).optional(),
  operations: z.array(z.record(z.unknown())).optional(),
});

export const GuiSseEventSchema = z.discriminatedUnion("type", [
  DeltaEventSchema,
  ToolEventSchema,
  ContextEventSchema,
  DisclosureRequiredEventSchema,
  EditEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
]);
export type GuiSseEvent = z.infer<typeof GuiSseEventSchema>;

/** Parse an already-decoded SSE `data:` payload; returns `undefined` when invalid. */
export function parseGuiSseEvent(input: unknown): GuiSseEvent | undefined {
  const parsed = GuiSseEventSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/** Serialize an event into a single SSE frame terminated by a blank line. */
export function serializeSseEvent(event: GuiSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Structured error body returned by JSON routes. */
export const StructuredErrorSchema = z.object({
  error: z.string().min(1),
  code: z.string().min(1).max(64).optional(),
});
export type StructuredError = z.infer<typeof StructuredErrorSchema>;
