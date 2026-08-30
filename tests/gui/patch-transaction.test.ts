import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../../src/gui/workspace/service.js";
import { EditProposalService } from "../../src/gui/workspace/edit-proposal.js";
import { PatchTransactionService, type PatchTransactionDeps } from "../../src/gui/workspace/patch-transaction.js";
import { ValidationError } from "../../src/errors.js";

describe("PatchTransactionService", () => {
  let dir: string;
  let records: string;
  let workspace: WorkspaceService;
  let proposals: EditProposalService;
  let rootId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmup-patch-"));
    records = mkdtempSync(join(tmpdir(), "llmup-patch-rec-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "one\ntwo\nthree\n");
    workspace = new WorkspaceService();
    proposals = new EditProposalService(workspace);
    rootId = workspace.registerRoot(dir).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(records, { recursive: true, force: true });
  });

  function make(deps: Partial<PatchTransactionDeps> = {}): PatchTransactionService {
    return new PatchTransactionService(workspace, proposals, { recordsDir: records, ...deps });
  }

  function hash(path: string): string {
    return workspace.read(rootId, path).hash;
  }

  it("applies an update writing exactly the reviewed bytes and records hashes", () => {
    const service = make();
    const result = service.apply({
      workspaceId: rootId,
      operations: [{ op: "update", path: "src/app.ts", baseHash: hash("src/app.ts"), hunks: [{ start: 2, end: 2, lines: ["TWO"] }] }],
    });
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(result.files[0]?.op).toBe("update");
    expect(result.files[0]?.beforeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.files[0]?.afterHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync(join(records, `${result.applicationId}.json`))).toBe(true);
  });

  it("applies a create for a new file", () => {
    const service = make();
    service.apply({
      workspaceId: rootId,
      operations: [{ op: "create", path: "src/new.ts", text: "hi\n" }],
    });
    expect(readFileSync(join(dir, "src", "new.ts"), "utf8")).toBe("hi\n");
  });

  it("rejects delete apply (disabled in this rollout)", () => {
    const service = make();
    expect(() =>
      service.apply({ workspaceId: rootId, operations: [{ op: "delete", path: "src/app.ts", baseHash: hash("src/app.ts") }] }),
    ).toThrow(/delete apply is not enabled/u);
    expect(existsSync(join(dir, "src", "app.ts"))).toBe(true);
  });

  it("fails closed on a stale base and writes nothing", () => {
    const service = make();
    expect(() =>
      service.apply({
        workspaceId: rootId,
        operations: [{ op: "update", path: "src/app.ts", baseHash: "stale", hunks: [{ start: 1, end: 1, lines: ["x"] }] }],
      }),
    ).toThrow(ValidationError);
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("rolls back all replaced files when a mid-transaction fault is injected", () => {
    writeFileSync(join(dir, "src", "b.ts"), "b1\nb2\n");
    const service = make({
      beforeReplace: (_abs, index) => {
        if (index === 1) {
          throw new Error("injected mid-transaction failure");
        }
      },
    });
    expect(() =>
      service.apply({
        workspaceId: rootId,
        operations: [
          { op: "update", path: "src/app.ts", baseHash: hash("src/app.ts"), hunks: [{ start: 1, end: 1, lines: ["X"] }] },
          { op: "update", path: "src/b.ts", baseHash: hash("src/b.ts"), hunks: [{ start: 1, end: 1, lines: ["Y"] }] },
        ],
      }),
    ).toThrow(/injected/u);
    // The first replace was rolled back; both files are original.
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toBe("b1\nb2\n");
  });

  it("reverts an applied update when the file is unchanged since apply", () => {
    const service = make();
    const result = service.apply({
      workspaceId: rootId,
      operations: [{ op: "update", path: "src/app.ts", baseHash: hash("src/app.ts"), hunks: [{ start: 2, end: 2, lines: ["TWO"] }] }],
    });
    const revert = service.revert({ applicationId: result.applicationId });
    expect(revert.reverted).toEqual(["src/app.ts"]);
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("skips revert (never clobbers) when the file changed after apply", () => {
    const service = make();
    const result = service.apply({
      workspaceId: rootId,
      operations: [{ op: "update", path: "src/app.ts", baseHash: hash("src/app.ts"), hunks: [{ start: 2, end: 2, lines: ["TWO"] }] }],
    });
    writeFileSync(join(dir, "src", "app.ts"), "user edited\n");
    const revert = service.revert({ applicationId: result.applicationId });
    expect(revert.skipped).toEqual(["src/app.ts"]);
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("user edited\n");
  });

  it("reverts a create by removing the file", () => {
    const service = make();
    const result = service.apply({
      workspaceId: rootId,
      operations: [{ op: "create", path: "src/new.ts", text: "hi\n" }],
    });
    service.revert({ applicationId: result.applicationId });
    expect(existsSync(join(dir, "src", "new.ts"))).toBe(false);
  });

  it("rejects revert for an unknown application id", () => {
    const service = make();
    expect(() => service.revert({ applicationId: "does-not-exist" })).toThrow(ValidationError);
  });
});
