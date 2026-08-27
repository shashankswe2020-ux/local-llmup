import { execFileSync } from "node:child_process";

/**
 * Recent, cross-platform-buildable commit used as a last-resort baseline when
 * the change's real base ref cannot be resolved (e.g. a shallow checkout).
 */
export const FALLBACK_BASELINE_COMMIT = "296d439c93ed411104b1fc87381615f5ddeb226c";

export function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

interface RunNpmOptions {
  readonly cwd: string;
  readonly stdio?: "ignore";
  readonly encoding?: "utf8";
}

/** Run npm portably; Windows must launch the npm.cmd shim through a shell. */
export function runNpm(args: readonly string[], options: RunNpmOptions): string {
  const result = execFileSync(npmCommand(), [...args], {
    cwd: options.cwd,
    shell: process.platform === "win32",
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
    ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
  });
  return typeof result === "string" ? result : "";
}

function tryGit(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the commit to measure a change against: the merge-base with the
 * target branch, so each change is judged only against what it modifies rather
 * than against all accumulated history. Falls back to the parent commit and
 * finally a recent buildable commit. An explicit override wins for local runs.
 */
export function resolveBaselineCommit(root: string): string {
  const override = process.env["LLMUP_BUDGET_BASELINE"]?.trim();
  if (override !== undefined && override.length > 0) return override;
  const head = tryGit(root, ["rev-parse", "HEAD"]);
  for (const args of [
    ["merge-base", "HEAD", "origin/main"],
    ["rev-parse", "HEAD^"],
  ]) {
    const commit = tryGit(root, args);
    if (commit !== undefined && commit.length > 0 && commit !== head) return commit;
  }
  return FALLBACK_BASELINE_COMMIT;
}
