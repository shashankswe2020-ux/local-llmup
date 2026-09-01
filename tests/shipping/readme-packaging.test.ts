import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/cli.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "..", "..");

function readText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("README and publish packaging", () => {
  it("documents the primary one-liner workflows and keeps them aligned with the CLI registry", () => {
    const readme = readText("README.md");
    const oneLinerCommands = ["recommend", "up", "chat", "catalog"];

    for (const name of oneLinerCommands) {
      expect(readme).toContain(name);
    }

    const registryNames = new Set(COMMANDS.map((command) => command.name));
    for (const name of oneLinerCommands) {
      expect(registryNames.has(name)).toBe(true);
    }
  });

  it("declares publish metadata and npm ignore rules for a clean tarball", () => {
    const pkg = JSON.parse(readText("package.json"));
    const npmIgnore = readText(".npmignore");

    expect(pkg.repository).toBeDefined();
    expect(pkg.keywords).toEqual(expect.arrayContaining(["llm", "ollama", "cli"]));
    expect(pkg.homepage).toBeDefined();
    expect(pkg.bugs).toBeDefined();
    expect(pkg.main).toBe("dist/cli.js");
    expect(pkg.types).toBe("dist/cli.d.ts");

    expect(npmIgnore).toContain("tests");
    expect(npmIgnore).toContain(".env");
    expect(npmIgnore).toContain("tokens");
  });

  it("packs only publish-safe files", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const packedFiles = manifest.flatMap((entry) => entry.files.map((file) => file.path));

    expect(packedFiles).toContain("dist/cli.js");
    expect(packedFiles).toContain("data/models.json");
    expect(packedFiles.some((file) => file.startsWith("tests/"))).toBe(false);
    expect(packedFiles.some((file) => file === ".env")).toBe(false);
    expect(packedFiles.some((file) => file === "tokens.json")).toBe(false);
  });

  it("ships a non-root Docker image through GHCR and documents how to pull it", () => {
    const dockerfile = readText("Dockerfile");
    const releaseWorkflow = readText(".github/workflows/release.yml");
    const readme = readText("README.md");
    const site = readText("site/index.html");

    expect(dockerfile).toContain("USER llmup");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/bin.js"]');
    expect(releaseWorkflow).toContain("ghcr.io/${GITHUB_REPOSITORY,,}");
    expect(releaseWorkflow).toContain("docker buildx build");
    expect(releaseWorkflow).toContain("packages: write");
    expect(releaseWorkflow).toContain('index($0, "## " ver " -") == 1');
    expect(readme).toContain("docker pull ghcr.io/shashankswe2020-ux/local-llmup");
    expect(site).toContain("docker pull ghcr.io/shashankswe2020-ux/local-llmup");
  });

  it("uses an explicit filesystem-safe desktop executable name", () => {
    const desktop = JSON.parse(readText("apps/desktop/package.json")) as {
      build?: { executableName?: string; linux?: { artifactName?: string } };
    };

    expect(desktop.build?.executableName).toBe("local-llmup");
    expect(desktop.build?.executableName).toMatch(/^[A-Za-z0-9._ -]+$/u);
    expect(desktop.build?.linux?.artifactName).toBe("local-llmup-${version}.${ext}");
  });
});
