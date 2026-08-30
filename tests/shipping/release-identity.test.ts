import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateReleaseIdentity } from "../../scripts/verify-release-identity.js";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as unknown;
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8")) as unknown;

function packed(version = "0.11.1"): unknown {
  return [{ name: "local-llmup", version, filename: `local-llmup-${version}.tgz` }];
}

describe("release identity", () => {
  it("accepts matching immutable tag, manifest, lock root, and packed artifact versions", () => {
    expect(() => validateReleaseIdentity("v0.11.1", packageJson, lockfile, packed())).not.toThrow();
    expect(() =>
      validateReleaseIdentity("v0.11.1", packageJson, lockfile, {
        name: "local-llmup",
        version: "0.11.1",
        filename: "local-llmup-0.11.1.tgz",
      }),
    ).not.toThrow();
  });

  it("rejects a missing tag and every version mismatch", () => {
    expect(() => validateReleaseIdentity("", packageJson, lockfile, packed())).toThrow(/tag/u);
    expect(() => validateReleaseIdentity("v0.11.1", packageJson, lockfile, packed("0.6.0"))).toThrow(
      /version mismatch/u,
    );
    expect(() => validateReleaseIdentity("v0.6.0", packageJson, lockfile, packed("0.11.1"))).toThrow(
      /version mismatch/u,
    );
  });
});
