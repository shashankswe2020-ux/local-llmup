import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateTuiPackageBudget,
} from "./tui-dependency-policy.js";

const PRE_TUI_COMMIT = "3984ae63faf2349eac9e73ba048e7a92ce5d77a6";

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function directoryBytes(directory: string): number {
  let bytes = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) bytes += statSync(child).size;
    }
  };
  walk(directory);
  return bytes;
}

function candidatePackedBytes(root: string): number {
  const output = execFileSync(
    npmCommand(),
    ["pack", "--ignore-scripts", "--json", "--dry-run"],
    {
    cwd: root,
    encoding: "utf8",
    },
  );
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new Error("npm pack returned an invalid manifest");
  }
  const size = (parsed[0] as { size?: unknown }).size;
  if (typeof size !== "number") throw new Error("npm pack manifest lacks packed size");
  return size;
}

export function runTuiPackageBudget(root = process.cwd()): void {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "local-llmup-tui-budget-"));
  const baseline = join(temporaryRoot, "baseline");
  const candidate = join(temporaryRoot, "candidate");
  const baselineCache = join(temporaryRoot, "baseline-cache");
  const candidateCache = join(temporaryRoot, "candidate-cache");
  try {
    execFileSync("git", ["worktree", "add", "--detach", baseline, PRE_TUI_COMMIT], {
      cwd: root,
      stdio: "ignore",
    });
    mkdirSync(candidate);
    for (const file of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "README.md",
      "LICENSE",
      ".npmignore",
    ]) {
      copyFileSync(join(root, file), join(candidate, file));
    }
    for (const directory of ["src", "data"]) {
      cpSync(join(root, directory), join(candidate, directory), { recursive: true });
    }

    execFileSync(
      npmCommand(),
      ["ci", "--omit=dev", "--ignore-scripts", "--cache", baselineCache],
      { cwd: baseline, stdio: "ignore" },
    );
    execFileSync(
      npmCommand(),
      ["ci", "--omit=dev", "--ignore-scripts", "--cache", candidateCache],
      { cwd: candidate, stdio: "ignore" },
    );
    const baselineInstallBytes = directoryBytes(join(baseline, "node_modules"));
    const candidateInstallBytes = directoryBytes(join(candidate, "node_modules"));

    rmSync(join(baseline, "node_modules"), { recursive: true, force: true });
    rmSync(join(candidate, "node_modules"), { recursive: true, force: true });
    execFileSync(npmCommand(), ["ci", "--ignore-scripts", "--cache", baselineCache], {
      cwd: baseline,
      stdio: "ignore",
    });
    execFileSync(npmCommand(), ["run", "build"], { cwd: baseline, stdio: "ignore" });
    execFileSync(npmCommand(), ["ci", "--ignore-scripts", "--cache", candidateCache], {
      cwd: candidate,
      stdio: "ignore",
    });
    execFileSync(npmCommand(), ["run", "build"], { cwd: candidate, stdio: "ignore" });
    const baselinePacked = candidatePackedBytes(baseline);
    const candidatePacked = candidatePackedBytes(candidate);
    validateTuiPackageBudget({
      baselinePackedBytes: baselinePacked,
      candidatePackedBytes: candidatePacked,
      baselineInstallBytes,
      candidateInstallBytes,
    });
    process.stdout.write(
      `TUI package budget passed (packed ${String(candidatePacked - baselinePacked)} bytes, install ${String(candidateInstallBytes - baselineInstallBytes)} bytes).\n`,
    );
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", baseline], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      // The final recursive cleanup handles a worktree that was never registered.
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) runTuiPackageBudget();
