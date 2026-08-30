/**
 * Transactional apply and guarded revert for edit proposals (task 32.10).
 *
 * Apply resolves a proposal into exact bytes (re-validating every base hash
 * against the current workspace), stages each result on the same filesystem,
 * verifies the staged hash, then replaces targets in a deterministic order. Any
 * failure rolls back already-replaced files, so the workspace is either fully
 * updated or fully restored. Each apply writes a durable, owner-only record of
 * per-file before/after hashes plus rollback material. Revert restores a file
 * only when its current hash still equals the applied-result hash, so it never
 * overwrites changes the user made after apply.
 *
 * Per the approved rollout, apply is enabled for `update` and `create`; `delete`
 * apply stays disabled until separately gated.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DIR_MODE, FILE_MODE } from "../../config.js";
import { ValidationError } from "../../errors.js";
import { EditProposalSchema, type EditProposalService } from "./edit-proposal.js";
import type { WorkspaceService } from "./service.js";

const APPLY_RECORD_VERSION = 1;

const RecordFileSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["update", "create"]),
  beforeHash: z.string(),
  afterHash: z.string().min(1),
  original: z.string().optional(),
});
const ApplyRecordSchema = z.object({
  schemaVersion: z.literal(APPLY_RECORD_VERSION),
  applicationId: z.string().min(1),
  workspaceId: z.string().min(1),
  createdAt: z.string().min(1),
  files: z.array(RecordFileSchema),
});
type ApplyRecord = z.infer<typeof ApplyRecordSchema>;

export interface AppliedFile {
  readonly path: string;
  readonly op: "update" | "create";
  readonly beforeHash: string;
  readonly afterHash: string;
}
export interface ApplyResult {
  readonly applicationId: string;
  readonly files: readonly AppliedFile[];
}
export interface RevertResult {
  readonly applicationId: string;
  readonly reverted: readonly string[];
  readonly skipped: readonly string[];
}

/** Config and test seams (deterministic clock and a fault-injection hook). */
export interface PatchTransactionDeps {
  readonly recordsDir: string;
  readonly now?: () => string;
  /** Invoked immediately before each target replacement; may throw to inject a fault. */
  readonly beforeReplace?: (abs: string, index: number) => void;
}

interface StagedEntry {
  readonly abs: string;
  readonly stage: string;
  readonly op: "update" | "create";
  readonly original: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class PatchTransactionService {
  private readonly locked = new Set<string>();

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly editProposals: EditProposalService,
    private readonly deps: PatchTransactionDeps,
  ) {}

  /** Apply an update/create proposal transactionally and record the result. */
  apply(input: unknown): ApplyResult {
    const parsed = EditProposalSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("invalid edit proposal");
    }
    const workspaceId = parsed.data.workspaceId;
    const plan = [...this.editProposals.resolvePlan(input)].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (plan.some((file) => file.op === "delete")) {
      throw new ValidationError("delete apply is not enabled");
    }

    const root = this.workspace.rootPath(workspaceId);
    return this.withLock(root, () => {
      // Stage every result and verify its hash before touching any target.
      const staged: StagedEntry[] = [];
      for (const file of plan) {
        if (file.newText === null) {
          continue;
        }
        const { abs } = this.workspace.resolveContainedPath(workspaceId, file.path);
        const original = file.op === "update" ? readFileSync(abs, "utf8") : null;
        if (file.op === "update" && sha256(original ?? "") !== file.beforeHash) {
          throw new ValidationError(`stale edit base for ${file.path}; re-read before editing`);
        }
        const stage = `${abs}.llmup-stage-${randomUUID()}`;
        writeFileSync(stage, file.newText, { mode: FILE_MODE });
        if (sha256(readFileSync(stage, "utf8")) !== file.resultHash) {
          rmSync(stage, { force: true });
          throw new ValidationError(`staged content hash mismatch for ${file.path}`);
        }
        staged.push({ abs, stage, op: file.op as "update" | "create", original });
      }

      const replaced: StagedEntry[] = [];
      try {
        staged.forEach((entry, index) => {
          this.deps.beforeReplace?.(entry.abs, index);
          renameSync(entry.stage, entry.abs);
          replaced.push(entry);
        });
      } catch (error) {
        this.rollback(replaced);
        for (const entry of staged) {
          rmSync(entry.stage, { force: true });
        }
        throw error instanceof Error ? error : new ValidationError("apply failed");
      }

      // Deletes are rejected above, so plan and staged are 1:1 in path order.
      const record: ApplyRecord = {
        schemaVersion: APPLY_RECORD_VERSION,
        applicationId: randomUUID(),
        workspaceId,
        createdAt: this.deps.now?.() ?? new Date().toISOString(),
        files: plan.map((file, index) => ({
          path: file.path,
          op: file.op as "update" | "create",
          beforeHash: file.beforeHash,
          afterHash: file.resultHash,
          ...(file.op === "update" ? { original: staged[index]?.original ?? "" } : {}),
        })),
      };
      this.writeRecord(record);
      return {
        applicationId: record.applicationId,
        files: record.files.map((file) => ({
          path: file.path,
          op: file.op,
          beforeHash: file.beforeHash,
          afterHash: file.afterHash,
        })),
      };
    });
  }

  /** Restore each file to its pre-apply state, but only where unchanged since. */
  revert(input: unknown): RevertResult {
    const parsed = z.object({ applicationId: z.string().min(1).max(128) }).safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("invalid revert request");
    }
    const record = this.readRecord(parsed.data.applicationId);
    const root = this.workspace.rootPath(record.workspaceId);
    return this.withLock(root, () => {
      const reverted: string[] = [];
      const skipped: string[] = [];
      // Reverse order mirrors apply so multi-file reverts unwind cleanly.
      for (const file of [...record.files].reverse()) {
        const { abs } = this.workspace.resolveContainedPath(record.workspaceId, file.path);
        if (this.currentHash(abs) !== file.afterHash) {
          skipped.push(file.path); // changed since apply — never clobber
          continue;
        }
        if (file.op === "create") {
          rmSync(abs, { force: true });
          reverted.push(file.path);
          continue;
        }
        const stage = `${abs}.llmup-stage-${randomUUID()}`;
        writeFileSync(stage, file.original ?? "", { mode: FILE_MODE });
        if (sha256(readFileSync(stage, "utf8")) !== file.beforeHash) {
          rmSync(stage, { force: true });
          skipped.push(file.path);
          continue;
        }
        renameSync(stage, abs);
        reverted.push(file.path);
      }
      return { applicationId: record.applicationId, reverted, skipped };
    });
  }

  private currentHash(abs: string): string {
    try {
      return sha256(readFileSync(abs, "utf8"));
    } catch {
      return "";
    }
  }

  private rollback(replaced: readonly StagedEntry[]): void {
    for (const entry of [...replaced].reverse()) {
      try {
        if (entry.op === "create") {
          rmSync(entry.abs, { force: true });
        } else {
          writeFileSync(entry.abs, entry.original ?? "", { mode: FILE_MODE });
        }
      } catch {
        // Best-effort rollback; the record was never written so state is inert.
      }
    }
  }

  private writeRecord(record: ApplyRecord): void {
    mkdirSync(this.deps.recordsDir, { recursive: true, mode: DIR_MODE });
    const file = join(this.deps.recordsDir, `${record.applicationId}.json`);
    writeFileSync(file, JSON.stringify(record), { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
  }

  private readRecord(applicationId: string): ApplyRecord {
    if (!/^[0-9a-f-]{1,64}$/iu.test(applicationId)) {
      throw new ValidationError("invalid application id");
    }
    const file = join(this.deps.recordsDir, `${applicationId}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new ValidationError("unknown application id");
    }
    const parsed = ApplyRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new ValidationError("corrupt application record");
    }
    return parsed.data;
  }

  private withLock<T>(root: string, fn: () => T): T {
    if (this.locked.has(root)) {
      throw new ValidationError("another edit transaction is in progress");
    }
    this.locked.add(root);
    try {
      return fn();
    } finally {
      this.locked.delete(root);
    }
  }
}
