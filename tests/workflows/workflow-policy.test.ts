import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config";

function readWorkflow(fileName: string): string {
  return readFileSync(join(process.cwd(), ".github", "workflows", fileName), "utf8");
}

function extractUsesRefs(yaml: string): string[] {
  const refs: string[] = [];
  const regex = /^\s*uses:\s*([^\s]+)\s*$/gmu;
  let match = regex.exec(yaml);
  while (match !== null) {
    refs.push(match[1]);
    match = regex.exec(yaml);
  }
  return refs;
}

function parseTopLevelPermissions(yaml: string): Record<string, string> {
  const capture = /^permissions:\n((?: {2}[^\n]+\n)+)/mu.exec(yaml);
  if (capture === null) return {};

  const permissions: Record<string, string> = {};
  for (const line of capture[1].split("\n")) {
    if (!line.startsWith("  ")) continue;
    const parts = line.trim().split(":");
    if (parts.length < 2) continue;
    const key = parts[0]?.trim();
    const value = parts.slice(1).join(":").trim();
    if (key !== undefined && key.length > 0) {
      permissions[key] = value;
    }
  }
  return permissions;
}

describe("T30 coverage gate", () => {
  it("keeps coverage thresholds at agreed policy levels", () => {
    const thresholds = vitestConfig.test?.coverage?.thresholds;
    expect(thresholds).toBeDefined();
    expect(typeof thresholds).toBe("object");
    const root = thresholds as Record<string, unknown>;
    expect(root.lines).toBe(70);

    const gated = [
      "src/ranking/**",
      "src/hardware/**",
      "src/catalog/**",
      "src/memory/**",
      "src/backend/**",
      "src/state/**",
    ];
    for (const key of gated) {
      const target = root[key] as { lines?: number; branches?: number } | undefined;
      expect(target?.lines).toBe(80);
      expect(target?.branches).toBe(80);
    }
  });

  it("runs coverage in CI via the test:cov script", () => {
    const ci = readWorkflow("ci.yml");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("npm run lint");
    expect(ci).not.toContain("run: npm test");
    expect(ci).toContain("npm run build");
    expect(ci).toMatch(/run:\s*npm run test:cov\b/u);
  });
});

describe("T30 workflow hardening", () => {
  it("enforces minimal top-level permissions for CI", () => {
    const ci = readWorkflow("ci.yml");
    const permissions = parseTopLevelPermissions(ci);
    expect(permissions).toEqual({ contents: "read" });
  });

  it("pins every CI action by full commit SHA", () => {
    const ci = readWorkflow("ci.yml");
    const refs = extractUsesRefs(ci);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/u);
    }
  });

  it("defines weekly + manual catalog refresh with minimal permissions and no protected-branch push", () => {
    const refresh = readWorkflow("catalog-refresh.yml");
    expect(refresh).toContain("workflow_dispatch:");
    expect(refresh).toContain("schedule:");
    expect(refresh).toMatch(/cron:\s*['"][^'"]+['"]/u);

    const permissions = parseTopLevelPermissions(refresh);
    expect(permissions).toEqual({ contents: "read" });

    const refs = extractUsesRefs(refresh);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/u);
    }

    expect(refresh).not.toMatch(/\bgit\s+push\b/u);
    expect(refresh).toContain("npm run catalog:refresh:dry-run");
    expect(refresh).toContain("git diff --exit-code -- data/models.json");
  });
});
