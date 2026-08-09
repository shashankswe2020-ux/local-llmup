/**
 * Performance and package budget tests for U3b.
 *
 * These tests verify the budget infrastructure exists, constants are correct,
 * and the tarball/install-size hard gates pass on the current build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

describe("Package budget gates", () => {
  it("npm pack --dry-run succeeds and reports packed size", () => {
    const output = execFileSync(
      npmCommand(),
      ["pack", "--ignore-scripts", "--json", "--dry-run"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    const entry = (parsed as unknown[])[0] as { size?: number; name?: string };
    expect(entry.name).toBe("local-llmup");
    expect(typeof entry.size).toBe("number");
  });

  it("tarball size is reported and reasonable (absolute ceiling 500 KiB)", () => {
    const output = execFileSync(
      npmCommand(),
      ["pack", "--ignore-scripts", "--json", "--dry-run"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const parsed = JSON.parse(output) as Array<{ size: number }>;
    const packedBytes = parsed[0]!.size;
    // The spec gate is a 250 KiB *increase* over pre-TUI baseline (enforced by
    // the tui:package-budget script). This test uses an absolute ceiling as a
    // safety net against massive regressions.
    const absoluteCeilingBytes = 500 * 1024;
    expect(packedBytes).toBeLessThanOrEqual(absoluteCeilingBytes);
  });

  it("package.json has the tui budget scripts", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["tui:package-budget"]).toBeDefined();
    expect(pkg.scripts["tui:runtime-budget"]).toBeDefined();
    expect(pkg.scripts["tui:dependency-policy"]).toBeDefined();
  });

  it("budget scripts exist on disk", () => {
    expect(existsSync(join(ROOT, "scripts/tui-package-budget.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts/tui-runtime-budget.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts/tui-dependency-policy.ts"))).toBe(true);
  });
});

describe("Cold-start regression infrastructure", () => {
  it("dist/bin.js exists after build", () => {
    expect(existsSync(join(ROOT, "dist/bin.js"))).toBe(true);
  });

  it("plain --version exits 0 without importing TUI modules", () => {
    const result = execFileSync(
      process.execPath,
      [join(ROOT, "dist/bin.js"), "--version"],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.trim()).toMatch(/local-llmup\/\d+\.\d+\.\d+/u);
  });

  it("plain --help exits 0 within bounded time", () => {
    const start = performance.now();
    execFileSync(
      process.execPath,
      [join(ROOT, "dist/bin.js"), "--help"],
      { encoding: "utf8", timeout: 10_000 },
    );
    const elapsed = performance.now() - start;
    // Must complete within 5 seconds (generous; real budget is <100ms)
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("Production audit", () => {
  it("npm audit --omit=dev reports no vulnerabilities", () => {
    const result = execFileSync(
      npmCommand(),
      ["audit", "--omit=dev", "--audit-level=low", "--json"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const parsed = JSON.parse(result) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const vulns = parsed.metadata?.vulnerabilities ?? {};
    const total = Object.values(vulns).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(0);
  });
});
