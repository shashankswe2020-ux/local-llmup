import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface LockPackage {
  readonly version?: string;
  readonly license?: string;
  readonly engines?: { readonly node?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly hasInstallScript?: boolean;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, LockPackage>;
};

describe("GUI Markdown dependency policy", () => {
  it("pins the audited parser and sanitizer versions", () => {
    expect(manifest.dependencies.marked).toBe("15.0.12");
    expect(manifest.dependencies.dompurify).toBe("3.4.13");

    const marked = lockfile.packages["node_modules/marked"];
    const purify = lockfile.packages["node_modules/dompurify"];
    expect(marked).toMatchObject({ version: "15.0.12", license: "MIT" });
    expect(marked?.engines?.node).toBe(">= 18");
    expect(purify).toMatchObject({
      version: "3.4.13",
      license: "(MPL-2.0 OR Apache-2.0)",
    });
  });

  it("has only the approved script-free production closure", () => {
    const approved = [
      "node_modules/marked",
      "node_modules/dompurify",
      "node_modules/@types/trusted-types",
    ] as const;
    for (const path of approved) {
      expect(lockfile.packages[path]?.hasInstallScript).not.toBe(true);
    }
    expect(lockfile.packages["node_modules/marked"]?.dependencies).toBeUndefined();
    expect(lockfile.packages["node_modules/dompurify"]?.optionalDependencies).toEqual({
      "@types/trusted-types": "^2.0.7",
    });
    expect(lockfile.packages["node_modules/@types/trusted-types"]).toMatchObject({
      version: "2.0.7",
      license: "MIT",
    });
  });
});
