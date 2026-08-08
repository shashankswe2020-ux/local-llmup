import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_TUI_DEPENDENCIES,
  TUI_INSTALL_DELTA_LIMIT_BYTES,
  TUI_PACKED_DELTA_LIMIT_BYTES,
  scanInstalledTuiArtifacts,
  normalizeArtifactPath,
  validateInstalledTuiManifests,
  validateTuiDependencyPolicy,
  validateTuiPackageBudget,
  type LockfileLike,
} from "../../scripts/tui-dependency-policy.js";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("U0b TUI dependency policy", () => {
  it("accepts the exact approved package and lockfile graph", () => {
    expect(() =>
      validateTuiDependencyPolicy(readJson("package.json"), readJson("package-lock.json")),
    ).not.toThrow();
  });

  it("rejects root publication lifecycle scripts", () => {
    const pkg = readJson("package.json") as {
      dependencies: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(() =>
      validateTuiDependencyPolicy(
        { ...pkg, scripts: { ...pkg.scripts, prepublishOnly: "node mutate.js" } },
        readJson("package-lock.json"),
      ),
    ).toThrow(/publication lifecycle/u);
  });

  it("normalizes Windows artifact paths before allowlist comparison", () => {
    expect(normalizeArtifactPath("node_modules\\yoga-layout\\dist\\payload.mjs")).toBe(
      "node_modules/yoga-layout/dist/payload.mjs",
    );
  });

  it("rejects version drift, install scripts, native artifacts, and React DevTools", () => {
    const pkg = readJson("package.json") as { dependencies: Record<string, string> };
    const lock = structuredClone(readJson("package-lock.json")) as LockfileLike;

    expect(() =>
      validateTuiDependencyPolicy(
        { ...pkg, dependencies: { ...pkg.dependencies, ink: "5.2.2" } },
        lock,
      ),
    ).toThrow(/ink.*5\.2\.1/u);

    lock.packages["node_modules/ink"] = {
      ...lock.packages["node_modules/ink"],
      hasInstallScript: true,
    };
    expect(() => validateTuiDependencyPolicy(pkg, lock)).toThrow(/install script/u);

    lock.packages["node_modules/ink"] = {
      ...lock.packages["node_modules/ink"],
      hasInstallScript: false,
      files: ["binding.node"],
    };
    expect(() => validateTuiDependencyPolicy(pkg, lock)).toThrow(/native artifact/u);

    lock.packages["node_modules/ink"] = {
      ...lock.packages["node_modules/ink"],
      files: [],
    };
    lock.packages["node_modules/react-devtools-core"] = {
      version: "5.0.0",
      license: "MIT",
    };
    expect(() => validateTuiDependencyPolicy(pkg, lock)).toThrow(/react-devtools-core/u);
  });

  it("rejects untrusted provenance, weak integrity, and a Node 20-only engine", () => {
    const pkg = readJson("package.json") as { dependencies: Record<string, string> };
    const original = readJson("package-lock.json") as LockfileLike;

    const untrusted = structuredClone(original);
    untrusted.packages["node_modules/ink"] = {
      ...untrusted.packages["node_modules/ink"],
      resolved: "https://example.test/ink.tgz",
    };
    expect(() => validateTuiDependencyPolicy(pkg, untrusted)).toThrow(/outside/u);

    const weak = structuredClone(original);
    weak.packages["node_modules/ink"] = {
      ...weak.packages["node_modules/ink"],
      integrity: "sha1-abc",
    };
    expect(() => validateTuiDependencyPolicy(pkg, weak)).toThrow(/SHA-512/u);

    const engine = structuredClone(original);
    engine.packages["node_modules/ink"] = {
      ...engine.packages["node_modules/ink"],
      engines: { node: "^20.0.0" },
    };
    expect(() => validateTuiDependencyPolicy(pkg, engine)).toThrow(/Node 18/u);
  });

  it("traverses installed optional dependencies and rejects nested React DevTools", () => {
    const pkg = readJson("package.json") as { dependencies: Record<string, string> };
    const lock = structuredClone(readJson("package-lock.json")) as LockfileLike;
    lock.packages["node_modules/ink"] = {
      ...lock.packages["node_modules/ink"],
      optionalDependencies: { optional_probe: "1.0.0" },
    };
    lock.packages["node_modules/optional_probe"] = {
      version: "1.0.0",
      license: "MIT",
      resolved: "https://registry.npmjs.org/optional_probe/-/optional_probe-1.0.0.tgz",
      integrity: "sha1-YWJj",
      dependencies: { react_devtools_probe: "1.0.0" },
    };
    lock.packages["node_modules/react_devtools_probe"] = {
      version: "1.0.0",
      license: "MIT",
      resolved: "https://registry.npmjs.org/react_devtools_probe/-/react_devtools_probe-1.0.0.tgz",
      integrity: "sha512-YWJj",
    };
    expect(() => validateTuiDependencyPolicy(pkg, lock)).toThrow(/SHA-512/u);

    const nested = structuredClone(readJson("package-lock.json")) as LockfileLike;
    nested.packages["node_modules/ink/node_modules/react-devtools-core"] = {
      version: "5.0.0",
      license: "MIT",
    };
    expect(() => validateTuiDependencyPolicy(pkg, nested)).toThrow(/react-devtools-core/u);
  });

  it("rejects package and production-install deltas above their hard limits", () => {
    expect(() =>
      validateTuiPackageBudget({
        baselinePackedBytes: 100,
        candidatePackedBytes: 100 + TUI_PACKED_DELTA_LIMIT_BYTES + 1,
        baselineInstallBytes: 100,
        candidateInstallBytes: 100 + TUI_INSTALL_DELTA_LIMIT_BYTES + 1,
      }),
    ).toThrow(/packed delta/u);

    expect(() =>
      validateTuiPackageBudget({
        baselinePackedBytes: 100,
        candidatePackedBytes: 100,
        baselineInstallBytes: 100,
        candidateInstallBytes: 100 + TUI_INSTALL_DELTA_LIMIT_BYTES + 1,
      }),
    ).toThrow(/install delta/u);
  });

  it("rejects lifecycle scripts and unapproved embedded WASM in installed files", () => {
    const root = mkdtempSync(join(tmpdir(), "llmup-tui-policy-"));
    const packagePath = "node_modules/probe";
    const directory = join(root, packagePath);
    mkdirSync(directory, { recursive: true });
    const lock: LockfileLike = {
      lockfileVersion: 3,
      packages: {
        [packagePath]: { version: "1.0.0", license: "MIT" },
      },
    };
    try {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "probe",
          version: "1.0.0",
          license: "MIT",
          scripts: { postinstall: "node install.js" },
        }),
      );
      expect(() => validateInstalledTuiManifests(root, lock, [packagePath])).toThrow(
        /lifecycle script/u,
      );

      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name: "probe", version: "1.0.0", license: "MIT" }),
      );
      writeFileSync(
        join(directory, "payload.mjs"),
        'const payload = "data:application/octet-stream;base64,AGFzbAAAA";',
      );
      expect(() => scanInstalledTuiArtifacts(root, [packagePath])).toThrow(/embedded WASM/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps exact approved versions centralized", () => {
    expect(APPROVED_TUI_DEPENDENCIES).toEqual({
      ink: "5.2.1",
      react: "18.3.1",
      "string-width": "7.2.0",
      "@types/react": "18.3.12",
    });
  });
});
