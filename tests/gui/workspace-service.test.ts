import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../../src/gui/workspace/service.js";
import { ValidationError } from "../../src/errors.js";

describe("WorkspaceService", () => {
  let dir: string;
  let service: WorkspaceService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmup-ws-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "line one\nline two\nline three\n");
    writeFileSync(join(dir, "README.md"), "# hello\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "junk.js"), "noise");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    service = new WorkspaceService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a directory and returns an opaque id and name", () => {
    const root = service.registerRoot(dir);
    expect(root.id).toMatch(/[0-9a-f-]{36}/u);
    expect(root.name.length).toBeGreaterThan(0);
    expect(service.has(root.id)).toBe(true);
  });

  it("creates and registers an explicitly requested empty workspace directory", () => {
    const service = new WorkspaceService();
    const createdPath = join(dir, "calculator-workspace");

    const root = service.createRoot(createdPath);

    expect(root.name).toBe("calculator-workspace");
    expect(service.has(root.id)).toBe(true);
    expect(service.tree(root.id)).toEqual({ path: "", entries: [] });
  });

  it("rejects non-existent and non-directory roots", () => {
    expect(() => service.registerRoot(join(dir, "missing"))).toThrow(ValidationError);
    expect(() => service.registerRoot(join(dir, "README.md"))).toThrow(ValidationError);
    expect(() => service.registerRoot("")).toThrow(ValidationError);
  });

  it("lists one directory level, hiding ignored and denied entries", () => {
    const { id } = service.registerRoot(dir);
    const { entries } = service.tree(id);
    const names = entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".env");
    // Directories sort before files.
    expect(entries[0]?.type).toBe("dir");
  });

  it("reads a bounded snapshot with a stable hash", () => {
    const { id } = service.registerRoot(dir);
    const snapshot = service.read(id, "src/index.ts");
    expect(snapshot.content).toBe("line one\nline two\nline three\n");
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.size).toBeGreaterThan(0);
  });

  it("reads a line range", () => {
    const { id } = service.registerRoot(dir);
    const snapshot = service.read(id, "src/index.ts", { startLine: 2, endLine: 3 });
    expect(snapshot.content).toBe("line two\nline three");
    expect(snapshot.range).toEqual({ startLine: 2, endLine: 3 });
  });

  it("fails closed on traversal, denied, and missing reads", () => {
    const { id } = service.registerRoot(dir);
    expect(() => service.read(id, "../secret")).toThrow(ValidationError);
    expect(() => service.read(id, ".env")).toThrow(ValidationError);
    expect(() => service.read(id, ".git/config")).toThrow(ValidationError);
    expect(() => service.read(id, "src/missing.ts")).toThrow(ValidationError);
  });

  it("rejects symlinked reads and unknown workspaces", () => {
    const outside = mkdtempSync(join(tmpdir(), "llmup-outside-"));
    writeFileSync(join(outside, "target.txt"), "secret");
    try {
      symlinkSync(join(outside, "target.txt"), join(dir, "link.txt"));
    } catch {
      return; // platform without symlink permission
    }
    const { id } = service.registerRoot(dir);
    expect(() => service.read(id, "link.txt")).toThrow(ValidationError);
    expect(() => service.tree("no-such-id")).toThrow(ValidationError);
    rmSync(outside, { recursive: true, force: true });
  });

  it("revokes a root", () => {
    const { id } = service.registerRoot(dir);
    service.revoke(id);
    expect(service.has(id)).toBe(false);
    expect(() => service.read(id, "README.md")).toThrow(ValidationError);
  });

  describe("search", () => {
    it("matches files by relative path, excluding ignored/denied/binary", () => {
      writeFileSync(join(dir, "src", "logo.png"), "binarydata");
      const { id } = service.registerRoot(dir);
      const page = service.search(id, "index");
      expect(page.results.map((r) => r.path)).toEqual(["src/index.ts"]);

      const all = service.search(id, "");
      const paths = all.results.map((r) => r.path);
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("README.md");
      expect(paths).not.toContain("node_modules/junk.js");
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain("src/logo.png");
    });

    it("paginates with an opaque cursor", () => {
      mkdirSync(join(dir, "pkg"));
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(dir, "pkg", `mod${i}.ts`), "x");
      }
      const { id } = service.registerRoot(dir);
      const first = service.search(id, "mod", { limit: 2 });
      expect(first.results).toHaveLength(2);
      expect(first.nextCursor).toBe("2");
      const second = service.search(id, "mod", { limit: 2, cursor: first.nextCursor ?? undefined });
      expect(second.results).toHaveLength(2);
      expect(second.results[0]?.path).not.toBe(first.results[0]?.path);
    });

    it("returns sorted, stable results", () => {
      const { id } = service.registerRoot(dir);
      const page = service.search(id, "");
      const paths = page.results.map((r) => r.path);
      expect([...paths].sort()).toEqual(paths);
    });

    it("rejects an unknown workspace", () => {
      expect(() => service.search("no-such-id", "x")).toThrow(ValidationError);
    });
  });

  describe("gitContext", () => {
    it("returns a bounded, hashed snapshot from a fixed argument vector", () => {
      const calls: string[][] = [];
      const svc = new WorkspaceService({
        runGit: (args) => {
          calls.push([...args]);
          return { stdout: " M src/index.ts\n?? new.ts\n", stderr: "", code: 0, failedToStart: false };
        },
      });
      const { id } = svc.registerRoot(dir);
      const snapshot = svc.gitContext(id, "status");
      expect(snapshot.available).toBe(true);
      expect(snapshot.content).toContain("src/index.ts");
      expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(snapshot.label).toBe("git status");
      // Fixed vector: -C <root> status ... (no shell, no user interpolation).
      expect(calls[0]?.[0]).toBe("-C");
      expect(calls[0]).toContain("status");
    });

    it("reports git-not-found honestly when the binary cannot start", () => {
      const svc = new WorkspaceService({
        runGit: () => ({ stdout: "", stderr: "", code: null, failedToStart: true }),
      });
      const { id } = svc.registerRoot(dir);
      const snapshot = svc.gitContext(id, "diff");
      expect(snapshot.available).toBe(false);
      expect(snapshot.reason).toBe("git-not-found");
    });

    it("reports a non-repository root honestly", () => {
      const svc = new WorkspaceService({
        runGit: () => ({
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
          code: 128,
          failedToStart: false,
        }),
      });
      const { id } = svc.registerRoot(dir);
      const snapshot = svc.gitContext(id, "status");
      expect(snapshot.available).toBe(false);
      expect(snapshot.reason).toBe("not-a-repository");
    });

    it("reports no-changes when clean", () => {
      const svc = new WorkspaceService({
        runGit: () => ({ stdout: "\n", stderr: "", code: 0, failedToStart: false }),
      });
      const { id } = svc.registerRoot(dir);
      const snapshot = svc.gitContext(id, "diff");
      expect(snapshot.available).toBe(false);
      expect(snapshot.reason).toBe("no-changes");
    });

    it("truncates oversized output", () => {
      const big = `${"x".repeat(200 * 1024)}\n`;
      const svc = new WorkspaceService({
        runGit: () => ({ stdout: big, stderr: "", code: 0, failedToStart: false }),
      });
      const { id } = svc.registerRoot(dir);
      const snapshot = svc.gitContext(id, "diff");
      expect(snapshot.available).toBe(true);
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.content.length).toBeLessThan(big.length);
    });

    it("rejects an unknown workspace", () => {
      const svc = new WorkspaceService({
        runGit: () => ({ stdout: "x", stderr: "", code: 0, failedToStart: false }),
      });
      expect(() => svc.gitContext("no-such-id", "status")).toThrow(ValidationError);
    });
  });
});
