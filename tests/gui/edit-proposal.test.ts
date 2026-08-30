import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../../src/gui/workspace/service.js";
import { EditProposalService } from "../../src/gui/workspace/edit-proposal.js";
import { ValidationError } from "../../src/errors.js";

describe("EditProposalService", () => {
  let dir: string;
  let workspace: WorkspaceService;
  let service: EditProposalService;
  let rootId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmup-edit-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    workspace = new WorkspaceService();
    service = new EditProposalService(workspace);
    rootId = workspace.registerRoot(dir).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseHash(path: string): string {
    return workspace.read(rootId, path).hash;
  }

  it("builds an update diff with add/remove counts and hunks, mutating nothing", () => {
    const before = workspace.read(rootId, "src/app.ts").hash;
    const review = service.review({
      workspaceId: rootId,
      operations: [
        {
          op: "update",
          path: "src/app.ts",
          baseHash: baseHash("src/app.ts"),
          hunks: [{ start: 2, end: 2, lines: ["TWO", "TWO.5"] }],
        },
      ],
    });
    expect(review.files).toHaveLength(1);
    const file = review.files[0];
    expect(file?.op).toBe("update");
    expect(file?.added).toBe(2);
    expect(file?.removed).toBe(1);
    expect(file?.resultHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(file?.hunks[0]?.lines.some((l) => l.type === "add" && l.text === "TWO")).toBe(true);
    // Viewing changed nothing.
    expect(workspace.read(rootId, "src/app.ts").hash).toBe(before);
  });

  it("rejects a stale base hash", () => {
    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [
          { op: "update", path: "src/app.ts", baseHash: "deadbeef", hunks: [{ start: 1, end: 1, lines: ["x"] }] },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects overlapping and out-of-range hunks", () => {
    const hash = baseHash("src/app.ts");
    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [
          {
            op: "update",
            path: "src/app.ts",
            baseHash: hash,
            hunks: [
              { start: 1, end: 2, lines: ["a"] },
              { start: 2, end: 3, lines: ["b"] },
            ],
          },
        ],
      }),
    ).toThrow(/overlapping/u);

    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [
          { op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 99, end: 99, lines: ["z"] }] },
        ],
      }),
    ).toThrow(/out of range/u);
  });

  it("rejects denied paths and duplicate targets", () => {
    const hash = baseHash("src/app.ts");
    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [{ op: "update", path: ".env", baseHash: "x", hunks: [{ start: 1, end: 1, lines: ["a"] }] }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [
          { op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 1, end: 1, lines: ["a"] }] },
          { op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 2, end: 2, lines: ["b"] }] },
        ],
      }),
    ).toThrow(/duplicate/u);
  });

  it("reviews a create for a new path and rejects clobbering an existing file", () => {
    const review = service.review({
      workspaceId: rootId,
      operations: [{ op: "create", path: "src/new.ts", text: "hello\nworld\n" }],
    });
    expect(review.files[0]?.op).toBe("create");
    expect(review.files[0]?.added).toBe(3);
    expect(review.files[0]?.removed).toBe(0);

    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [{ op: "create", path: "src/app.ts", text: "x" }],
      }),
    ).toThrow(/already exists/u);
  });

  it("reviews a delete with a matching base and all lines removed", () => {
    const review = service.review({
      workspaceId: rootId,
      operations: [{ op: "delete", path: "src/app.ts", baseHash: baseHash("src/app.ts") }],
    });
    expect(review.files[0]?.op).toBe("delete");
    expect(review.files[0]?.removed).toBe(5);
    expect(review.files[0]?.resultHash).toBe("");
  });

  it("rejects a symlinked update target (fails closed via workspace read)", () => {
    const outside = mkdtempSync(join(tmpdir(), "llmup-edit-out-"));
    writeFileSync(join(outside, "target.txt"), "secret");
    try {
      symlinkSync(join(outside, "target.txt"), join(dir, "link.txt"));
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [{ op: "update", path: "link.txt", baseHash: "x", hunks: [{ start: 1, end: 1, lines: ["a"] }] }],
      }),
    ).toThrow(ValidationError);
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects malformed proposals", () => {
    expect(() => service.review({ workspaceId: rootId, operations: [] })).toThrow(ValidationError);
    expect(() => service.review({ operations: [] })).toThrow(ValidationError);
    expect(() =>
      service.review({
        workspaceId: rootId,
        operations: [{ op: "update", path: "src/app.ts", baseHash: baseHash("src/app.ts"), hunks: [{ start: 2, end: 0, lines: ["x"] }] }],
      }),
    ).toThrow(ValidationError);
  });
});
