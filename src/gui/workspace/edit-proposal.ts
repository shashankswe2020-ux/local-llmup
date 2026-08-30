/**
 * Structured edit proposals and server-generated review diffs (task 32.9).
 *
 * A proposal is a bounded set of create/update/delete operations expressed as
 * relative paths, base hashes, and non-overlapping hunks. The service validates
 * every operation against the *current* workspace snapshot and produces a review
 * diff, but never writes: viewing or approving a proposal mutates zero files.
 * Stale bases, overlaps, out-of-range hunks, denied/binary/oversized targets,
 * and malformed input all fail closed before any review is produced. The model
 * patch text is never piped to a shell or `git apply`.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import { isDeniedPath, normalizeRelativePath } from "./policy.js";
import type { WorkspaceService } from "./service.js";

const MAX_EDIT_OPS = 20;
const MAX_HUNKS_PER_FILE = 100;
const MAX_HUNK_LINES = 2000;
const MAX_NEW_FILE_BYTES = 512 * 1024;
const CONTEXT_LINES = 3;

/** A single replacement: replace base lines `start`..`end` (1-based, inclusive) with `lines`. */
const HunkSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().nonnegative(),
  lines: z.array(z.string()).max(MAX_HUNK_LINES),
});

const EditOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update"),
    path: z.string().min(1).max(1024),
    baseHash: z.string().min(1).max(128),
    hunks: z.array(HunkSchema).min(1).max(MAX_HUNKS_PER_FILE),
  }),
  z.object({
    op: z.literal("create"),
    path: z.string().min(1).max(1024),
    text: z.string().max(MAX_NEW_FILE_BYTES),
  }),
  z.object({
    op: z.literal("delete"),
    path: z.string().min(1).max(1024),
    baseHash: z.string().min(1).max(128),
  }),
]);

export const EditProposalSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  operations: z.array(EditOperationSchema).min(1).max(MAX_EDIT_OPS),
});
export type EditProposal = z.infer<typeof EditProposalSchema>;
export type EditOperation = z.infer<typeof EditOperationSchema>;

export type DiffLineType = "context" | "add" | "del";
export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
}
export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

/** One reviewed file: the op, before/after hashes, counts, hunks, and warnings. */
export interface ProposalReviewFile {
  readonly path: string;
  readonly op: "update" | "create" | "delete";
  readonly baseHash?: string;
  readonly resultHash: string;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
  readonly warnings: readonly string[];
}

export interface ProposalReview {
  readonly proposalId: string;
  readonly files: readonly ProposalReviewFile[];
  readonly warnings: readonly string[];
}

/** A fully validated file plan carrying the exact bytes to write (task 32.10). */
export interface ResolvedEditFile {
  readonly path: string;
  readonly op: "update" | "create" | "delete";
  readonly beforeHash: string;
  readonly resultHash: string;
  /** The resulting file bytes, or `null` for a delete. */
  readonly newText: string | null;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
  readonly warnings: readonly string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Split content into lines, preserving a trailing newline as a trailing "". */
function splitLines(content: string): string[] {
  return content.split("\n");
}

/** Validates edit proposals into inert review diffs and apply plans (no writes). */
export class EditProposalService {
  constructor(private readonly workspace: WorkspaceService) {}

  /** Validate every operation against the current workspace and build a diff. */
  review(input: unknown): ProposalReview {
    const resolved = this.resolvePlan(input);
    const files: ProposalReviewFile[] = resolved.map((file) => ({
      path: file.path,
      op: file.op,
      ...(file.op === "create" ? {} : { baseHash: file.beforeHash }),
      resultHash: file.resultHash,
      added: file.added,
      removed: file.removed,
      hunks: file.hunks,
      warnings: file.warnings,
    }));
    const warnings = files.some((file) => file.warnings.length > 0)
      ? ["some files reported warnings; review carefully"]
      : [];
    return { proposalId: randomUUID(), files, warnings };
  }

  /** Validate and resolve a proposal into the exact bytes to write per file. */
  resolvePlan(input: unknown): ResolvedEditFile[] {
    const parsed = EditProposalSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(`invalid edit proposal: ${parsed.error.issues[0]?.message ?? "bad request"}`);
    }
    const { workspaceId, operations } = parsed.data;
    const seen = new Set<string>();
    const files: ResolvedEditFile[] = [];
    for (const op of operations) {
      const rel = normalizeRelativePath(op.path);
      if (rel === "" || isDeniedPath(rel)) {
        throw new ValidationError(`path is not editable: ${op.path}`);
      }
      if (seen.has(rel)) {
        throw new ValidationError(`duplicate edit target: ${rel}`);
      }
      seen.add(rel);
      if (op.op === "create") {
        files.push(this.resolveCreate(workspaceId, rel, op.text));
      } else if (op.op === "delete") {
        files.push(this.resolveDelete(workspaceId, rel, op.baseHash));
      } else {
        files.push(this.resolveUpdate(workspaceId, rel, op.baseHash, op.hunks));
      }
    }
    return files;
  }

  private resolveCreate(workspaceId: string, rel: string, text: string): ResolvedEditFile {
    if (text.includes("\0")) {
      throw new ValidationError(`refusing to create binary content: ${rel}`);
    }
    // A create must not clobber an existing file.
    let exists = true;
    try {
      this.workspace.read(workspaceId, rel);
    } catch {
      exists = false;
    }
    if (exists) {
      throw new ValidationError(`file already exists: ${rel}`);
    }
    const lines = splitLines(text);
    return {
      path: rel,
      op: "create",
      beforeHash: "",
      resultHash: sha256(text),
      newText: text,
      added: lines.length,
      removed: 0,
      hunks: [{ header: `@@ +1,${lines.length} @@`, lines: lines.map((line) => ({ type: "add", text: line })) }],
      warnings: [],
    };
  }

  private resolveDelete(workspaceId: string, rel: string, baseHash: string): ResolvedEditFile {
    const snapshot = this.workspace.read(workspaceId, rel);
    if (snapshot.hash !== baseHash) {
      throw new ValidationError(`stale edit base for ${rel}; re-read before editing`);
    }
    const lines = splitLines(snapshot.content);
    return {
      path: rel,
      op: "delete",
      beforeHash: baseHash,
      resultHash: "",
      newText: null,
      added: 0,
      removed: lines.length,
      hunks: [{ header: `@@ -1,${lines.length} @@`, lines: lines.map((line) => ({ type: "del", text: line })) }],
      warnings: [],
    };
  }

  private resolveUpdate(
    workspaceId: string,
    rel: string,
    baseHash: string,
    hunks: readonly z.infer<typeof HunkSchema>[],
  ): ResolvedEditFile {
    const snapshot = this.workspace.read(workspaceId, rel);
    if (snapshot.hash !== baseHash) {
      throw new ValidationError(`stale edit base for ${rel}; re-read before editing`);
    }
    const baseLines = splitLines(snapshot.content);
    const sorted = [...hunks].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const hunk of sorted) {
      if (hunk.end < hunk.start - 1) {
        throw new ValidationError(`invalid hunk range in ${rel}`);
      }
      if (hunk.end > baseLines.length || hunk.start > baseLines.length + 1) {
        throw new ValidationError(`hunk out of range in ${rel}`);
      }
      if (hunk.start <= cursor) {
        throw new ValidationError(`overlapping hunks in ${rel}`);
      }
      cursor = hunk.end;
      if (hunk.lines.some((line) => line.includes("\0"))) {
        throw new ValidationError(`refusing to write binary content: ${rel}`);
      }
    }

    // Apply hunks from the bottom up so earlier line numbers stay valid.
    const result = [...baseLines];
    let added = 0;
    let removed = 0;
    for (const hunk of [...sorted].reverse()) {
      const deleteCount = Math.max(0, hunk.end - hunk.start + 1);
      result.splice(hunk.start - 1, deleteCount, ...hunk.lines);
      added += hunk.lines.length;
      removed += deleteCount;
    }
    const newText = result.join("\n");
    if (Buffer.byteLength(newText, "utf8") > MAX_NEW_FILE_BYTES) {
      throw new ValidationError(`edited file too large: ${rel}`);
    }

    const warnings: string[] = [];
    if (added + removed > MAX_HUNK_LINES) {
      warnings.push("large change; review carefully");
    }
    return {
      path: rel,
      op: "update",
      beforeHash: baseHash,
      resultHash: sha256(newText),
      newText,
      added,
      removed,
      hunks: sorted.map((hunk) => this.buildUpdateHunk(baseLines, hunk)),
      warnings,
    };
  }

  private buildUpdateHunk(baseLines: readonly string[], hunk: z.infer<typeof HunkSchema>): DiffHunk {
    const deleteCount = Math.max(0, hunk.end - hunk.start + 1);
    const before = baseLines.slice(Math.max(0, hunk.start - 1 - CONTEXT_LINES), hunk.start - 1);
    const removedLines = baseLines.slice(hunk.start - 1, hunk.start - 1 + deleteCount);
    const afterStart = hunk.start - 1 + deleteCount;
    const after = baseLines.slice(afterStart, afterStart + CONTEXT_LINES);
    const lines: DiffLine[] = [
      ...before.map((text) => ({ type: "context" as const, text })),
      ...removedLines.map((text) => ({ type: "del" as const, text })),
      ...hunk.lines.map((text) => ({ type: "add" as const, text })),
      ...after.map((text) => ({ type: "context" as const, text })),
    ];
    const header = `@@ -${hunk.start},${deleteCount} +${hunk.start},${hunk.lines.length} @@`;
    return { header, lines };
  }
}
