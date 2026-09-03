import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Update state surfaced to the browser and desktop UI. */
export type UpdateState = "current" | "update-available" | "unknown";

const STABLE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/u;
const LATEST_RELEASE_URL =
  "https://api.github.com/repos/shashankswe2020-ux/local-llmup/releases/latest";
const RELEASES_URL = "https://github.com/shashankswe2020-ux/local-llmup/releases";
const UPDATE_TIMEOUT_MS = 3_000;
const LatestReleaseSchema = z.object({ tag_name: z.string() });

export type UpdateStatus = {
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly state: UpdateState;
  readonly releaseUrl: string | null;
};

export interface UpdateStatusOptions {
  readonly currentVersion?: string | undefined;
  readonly fetchLatest?: typeof fetch | undefined;
}

function parseStableVersion(value: string): readonly [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    : null;
}

/** Compare an installed package version with a stable release tag. */
export function compareReleaseVersions(current: string, latestTag: string): UpdateState {
  const installed = parseStableVersion(current);
  const latest = parseStableVersion(latestTag);
  if (installed === null || latest === null) {
    return "unknown";
  }
  for (let index = 0; index < installed.length; index += 1) {
    const installedPart = installed[index] ?? 0;
    const latestPart = latest[index] ?? 0;
    if (latestPart > installedPart) {
      return "update-available";
    }
    if (latestPart < installedPart) {
      return "current";
    }
  }
  return "current";
}

function packageVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = z
      .object({ version: z.string() })
      .safeParse(JSON.parse(readFileSync(packagePath, "utf8")));
    return parsed.success ? parsed.data.version : "unknown";
  } catch {
    return "unknown";
  }
}

function unknownStatus(currentVersion: string): UpdateStatus {
  return {
    currentVersion,
    latestVersion: null,
    state: "unknown",
    releaseUrl: null,
  };
}

/** Fetch and validate the latest published GitHub release without throwing. */
export async function getUpdateStatus(options: UpdateStatusOptions = {}): Promise<UpdateStatus> {
  const currentVersion = options.currentVersion ?? packageVersion();
  const fetchLatest = options.fetchLatest ?? fetch;
  try {
    const response = await fetchLatest(LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return unknownStatus(currentVersion);
    }
    const parsed = LatestReleaseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return unknownStatus(currentVersion);
    }
    const state = compareReleaseVersions(currentVersion, parsed.data.tag_name);
    if (state === "unknown") {
      return unknownStatus(currentVersion);
    }
    const latestVersion = parsed.data.tag_name.replace(/^v/u, "");
    return {
      currentVersion,
      latestVersion,
      state,
      releaseUrl: state === "update-available" ? RELEASES_URL : null,
    };
  } catch {
    return unknownStatus(currentVersion);
  }
}