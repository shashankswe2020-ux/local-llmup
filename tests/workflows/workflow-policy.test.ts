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

function extractJob(yaml: string, jobName: string): string {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `(?:^|\\n)  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`,
    "u",
  ).exec(yaml);
  if (match?.[1] === undefined) throw new Error(`workflow job ${jobName} not found`);
  return match[1];
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

  it("enforces the U0b renderer matrix and dependency/package/runtime gates", () => {
    const tui = readWorkflow("tui-compatibility.yml");
    const permissions = parseTopLevelPermissions(tui);
    expect(permissions).toEqual({ contents: "read" });

    const refs = extractUsesRefs(tui);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/@[0-9a-f]{40}$/u);

    const runtimeJob = extractJob(tui, "runtime-proof");
    const packageJob = extractJob(tui, "package-budget");
    for (const os of ["macos-latest", "ubuntu-latest", "windows-latest"]) {
      expect(runtimeJob).toContain(os);
      expect(packageJob).toContain(os);
    }
    for (const version of ["18.x", "20.x", "22.x", "24.x"]) {
      expect(runtimeJob).toContain(version);
    }
    expect(runtimeJob).toContain("fetch-depth: 0");
    expect(runtimeJob).toContain("npm ci --ignore-scripts");
    expect(runtimeJob).toContain("npm run tui:dependency-policy");
    expect(runtimeJob).toContain("npm sbom --omit=dev --sbom-format=cyclonedx");
    expect(runtimeJob).toContain("npm run test:tui-proof");
    expect(runtimeJob).toContain("npm run tui:runtime-budget");
    expect(packageJob).toContain("fetch-depth: 0");
    expect(packageJob).toContain("npm run tui:package-budget");
    expect(packageJob).toContain("npm audit --omit=dev --audit-level=low");
  });

  it("protects publish and release paths with pinned actions and verified artifacts", () => {
    for (const fileName of ["npm-publish.yml", "release.yml"]) {
      const workflow = readWorkflow(fileName);
      for (const ref of extractUsesRefs(workflow)) expect(ref).toMatch(/@[0-9a-f]{40}$/u);
      expect(workflow).toContain("npm ci --ignore-scripts");
      expect(workflow).toContain("npm run tui:dependency-policy");
      expect(workflow).toContain("npm audit --omit=dev --audit-level=low");
      expect(workflow).toContain("npm sbom --omit=dev --sbom-format=cyclonedx");
      expect(workflow).toContain("npm run tui:package-budget");
      expect(workflow).toContain("--dry-run --ignore-scripts --json");
      expect(workflow).toMatch(
        /npm run verify:release-identity -- "\$GITHUB_REF_NAME" (?:pack|artifact)\.json/u,
      );
    }

    const publish = readWorkflow("npm-publish.yml");
    expect(publish).not.toContain("workflow_dispatch:");
    expect(publish).toContain('gh release download "$GITHUB_REF_NAME"');
    expect(publish).not.toContain("npm pack --ignore-scripts");
    expect(publish).toContain(
      'npm publish "${{ steps.artifact.outputs.package_file }}" --access public --ignore-scripts',
    );
    const release = readWorkflow("release.yml");
    expect(release).toContain("npm pack --ignore-scripts");
    expect(release).toContain("softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65");
    expect(release).toContain("tui-production-sbom.json");
  });

  it("pins every CI action by full commit SHA", () => {
    const ci = readWorkflow("ci.yml");
    const refs = extractUsesRefs(ci);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/u);
    }
  });

  it("defines a weekly + manual catalog refresh that writes via a reviewed PR, never pushing to main", () => {
    const refresh = readWorkflow("catalog-refresh.yml");
    expect(refresh).toContain("workflow_dispatch:");
    expect(refresh).toContain("schedule:");
    expect(refresh).toMatch(/cron:\s*['"][^'"]+['"]/u);

    const permissions = parseTopLevelPermissions(refresh);
    // Least privilege for a write pipeline: push a branch, open a PR, file an
    // issue. It never runs anything on the default branch directly.
    expect(permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
    });

    const refs = extractUsesRefs(refresh);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/u);
    }

    // Refreshed catalog lands on a dedicated branch and merges through a PR;
    // there is never a direct push to the protected default branch, and never a
    // force-push (a branch-protection ruleset forbids it).
    expect(refresh).toContain("npm run catalog:refresh");
    expect(refresh).toContain("gh pr create");
    expect(refresh).toContain("catalog/auto-refresh");
    expect(refresh).toMatch(/git push[^\n]*"\$BRANCH"/u);
    expect(refresh).not.toMatch(/git push[^\n]*\bmain\b/u);
    expect(refresh).not.toMatch(/git push\s+--force/u);
    // The refreshed catalog is validated before the PR is opened.
    expect(refresh).toContain("npm test");
  });
});
