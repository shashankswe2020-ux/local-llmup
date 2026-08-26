import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const APPROVED_TUI_DEPENDENCIES = {
  ink: "5.2.1",
  react: "18.3.1",
  "string-width": "7.2.0",
  "@types/react": "18.3.12",
} as const;

export const TUI_PACKED_DELTA_LIMIT_BYTES = 250 * 1024;
// Production install delta vs the pre-TUI baseline. Covers ink/react/yoga plus
// the MCP SDK added in 0.9.0; measured ~19.5 MiB on CI, so budget with headroom.
export const TUI_INSTALL_DELTA_LIMIT_BYTES = 24 * 1024 * 1024;

const RUNTIME_ROOTS = ["ink", "react", "string-width"] as const;
const ALLOWED_LICENSES = new Set(["MIT", "ISC", "(MIT OR CC0-1.0)"]);
const NATIVE_ARTIFACT_RE = /\.(?:node|wasm|dll|dylib|exe|so)$/iu;
const EMBEDDED_WASM_RE = /data:application\/octet-stream;base64,AGFzb/u;
const TRUSTED_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const YOGA_WASM_LOADER = "node_modules/yoga-layout/dist/binaries/yoga-wasm-base64-esm.js";
const YOGA_WASM_LOADER_SHA256 = "2cfeda49ae87f57bcd4a5fe433940edefc531a69bd0f83e32759fb5837df205c";
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"] as const;
const PUBLICATION_LIFECYCLE_SCRIPTS = [
  "prepublish",
  "prepublishOnly",
  "prepack",
  "prepare",
  "postpack",
  "publish",
  "postpublish",
] as const;

const PackageJsonSchema = z
  .object({
    dependencies: z.record(z.string()),
    devDependencies: z.record(z.string()).default({}),
    scripts: z.record(z.string()).default({}),
  })
  .passthrough();

const LockPackageSchema = z
  .object({
    version: z.string().optional(),
    license: z.string().optional(),
    dependencies: z.record(z.string()).optional(),
    optionalDependencies: z.record(z.string()).optional(),
    peerDependencies: z.record(z.string()).optional(),
    engines: z.object({ node: z.string().optional() }).passthrough().optional(),
    integrity: z.string().optional(),
    resolved: z.string().optional(),
    hasInstallScript: z.boolean().optional(),
    files: z.array(z.string()).optional(),
  })
  .passthrough();

const LockfileSchema = z
  .object({
    lockfileVersion: z.literal(3),
    packages: z.record(LockPackageSchema),
  })
  .passthrough();

export type LockPackageLike = z.infer<typeof LockPackageSchema>;
export interface LockfileLike {
  readonly lockfileVersion: 3;
  readonly packages: Record<string, LockPackageLike>;
}

export interface PackageBudgetInput {
  readonly baselinePackedBytes: number;
  readonly candidatePackedBytes: number;
  readonly baselineInstallBytes: number;
  readonly candidateInstallBytes: number;
}

function assertSafeByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function lockPathForDependency(
  packages: Readonly<Record<string, LockPackageLike>>,
  fromPath: string,
  dependency: string,
): string | null {
  let current = fromPath;
  for (;;) {
    const nested = posix.join(current, "node_modules", dependency);
    if (packages[nested] !== undefined) return nested;
    const marker = current.lastIndexOf("/node_modules/");
    if (marker < 0) break;
    current = current.slice(0, marker);
  }
  const topLevel = `node_modules/${dependency}`;
  return packages[topLevel] !== undefined ? topLevel : null;
}

export function collectTuiDependencyClosure(lockfile: LockfileLike): readonly string[] {
  const queue = RUNTIME_ROOTS.map((name) => `node_modules/${name}`);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (packagePath === undefined || visited.has(packagePath)) continue;
    const pkg = lockfile.packages[packagePath];
    if (pkg === undefined) throw new Error(`missing locked TUI package ${packagePath}`);
    visited.add(packagePath);
    const dependencyNames = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    for (const dependency of dependencyNames) {
      const dependencyPath = lockPathForDependency(lockfile.packages, packagePath, dependency);
      if (dependencyPath === null && pkg.dependencies?.[dependency] !== undefined) {
        throw new Error(`missing locked dependency ${dependency} required by ${packagePath}`);
      }
      if (dependencyPath !== null) queue.push(dependencyPath);
    }
  }
  return [...visited].sort();
}

function parseVersion(value: string): readonly number[] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function node18SatisfiesBranch(branch: string): boolean {
  const target = [18, 20, 0] as const;
  const trimmed = branch.trim();
  if (trimmed === "*") return true;
  const comparator = /^(>=|>|<=|<|\^)?\s*(\d+(?:\.\d+){0,2})$/u.exec(trimmed);
  if (comparator === null) return false;
  const version = parseVersion(comparator[2] ?? "");
  if (version === null) return false;
  const comparison = compareVersion(target, version);
  switch (comparator[1] ?? "exact-major") {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "^":
      return target[0] === version[0] && comparison >= 0;
    case "exact-major":
      return target[0] === version[0] && comparison >= 0;
  }
}

function assertNode18Compatible(range: string | undefined, packagePath: string): void {
  if (range === undefined) return;
  if (!range.split("||").some(node18SatisfiesBranch)) {
    throw new Error(`${packagePath} engine ${range} does not allow supported Node 18.20`);
  }
}

function assertNoNativeArtifacts(paths: readonly string[]): void {
  const native = paths.find((path) => NATIVE_ARTIFACT_RE.test(path));
  if (native !== undefined) throw new Error(`TUI dependency graph contains native artifact ${native}`);
}

export function normalizeArtifactPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function validateTuiDependencyPolicy(packageJson: unknown, lockfileJson: unknown): void {
  const packageJsonResult = PackageJsonSchema.safeParse(packageJson);
  if (!packageJsonResult.success) throw new Error("invalid package.json for TUI dependency policy");
  const lockfileResult = LockfileSchema.safeParse(lockfileJson);
  if (!lockfileResult.success) throw new Error("invalid package-lock.json for TUI dependency policy");
  const pkg = packageJsonResult.data;
  const lockfile: LockfileLike = lockfileResult.data;

  for (const [name, version] of Object.entries(APPROVED_TUI_DEPENDENCIES)) {
    const actual = name === "@types/react" ? pkg.devDependencies[name] : pkg.dependencies[name];
    if (actual !== version) throw new Error(`${name} must be pinned exactly to ${version}`);
  }
  const publicationScript = PUBLICATION_LIFECYCLE_SCRIPTS.find(
    (script) => pkg.scripts[script] !== undefined,
  );
  if (publicationScript !== undefined) {
    throw new Error(`root publication lifecycle script ${publicationScript} is prohibited`);
  }
  if (
    Object.keys(lockfile.packages).some(
      (packagePath) =>
        packagePath === "node_modules/react-devtools-core" ||
        packagePath.endsWith("/node_modules/react-devtools-core"),
    )
  ) {
    throw new Error("react-devtools-core optional peer must not be installed");
  }

  const closure = collectTuiDependencyClosure(lockfile);
  for (const packagePath of closure) {
    const locked = lockfile.packages[packagePath];
    if (locked === undefined) throw new Error(`missing locked package ${packagePath}`);
    if (locked.hasInstallScript === true) {
      throw new Error(`${packagePath} has an install script`);
    }
    if (locked.license === undefined || !ALLOWED_LICENSES.has(locked.license)) {
      throw new Error(`${packagePath} has unapproved license ${locked.license ?? "unknown"}`);
    }
    if (locked.integrity === undefined || locked.resolved === undefined) {
      throw new Error(`${packagePath} lacks locked provenance metadata`);
    }
    let resolved: URL;
    try {
      resolved = new URL(locked.resolved);
    } catch {
      throw new Error(`${packagePath} has invalid resolved provenance URL`);
    }
    if (resolved.protocol !== "https:" || resolved.origin !== TRUSTED_REGISTRY_ORIGIN) {
      throw new Error(`${packagePath} resolved provenance is outside ${TRUSTED_REGISTRY_ORIGIN}`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(locked.integrity)) {
      throw new Error(`${packagePath} integrity must use SHA-512 SRI`);
    }
    assertNode18Compatible(locked.engines?.node, packagePath);
    assertNoNativeArtifacts(locked.files ?? []);
  }

  const yoga = lockfile.packages["node_modules/yoga-layout"];
  if (yoga?.version !== "3.2.1") throw new Error("yoga-layout must remain pinned to 3.2.1");
}

export function scanInstalledTuiArtifacts(
  root: string,
  closure: readonly string[],
): readonly string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`TUI dependency graph contains symlink ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const relativePath = normalizeArtifactPath(relative(root, path));
        const executable = (statSync(path).mode & 0o111) !== 0;
        if (executable && !/\.(?:c|m)?js$/u.test(relativePath)) {
          throw new Error(`TUI dependency graph contains executable artifact ${relativePath}`);
        }
        files.push(relativePath);
      }
    }
  };
  for (const packagePath of closure) walk(resolve(root, packagePath));
  assertNoNativeArtifacts(files);
  for (const file of files) {
    if (!/\.(?:c|m)?js$/u.test(file)) continue;
    const content = readFileSync(join(root, file), "utf8");
    if (!EMBEDDED_WASM_RE.test(content)) continue;
    if (file !== YOGA_WASM_LOADER) {
      throw new Error(`TUI dependency graph contains unapproved embedded WASM ${file}`);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== YOGA_WASM_LOADER_SHA256) {
      throw new Error(`Yoga embedded WASM loader digest mismatch: ${digest}`);
    }
  }
  return files;
}

export function validateInstalledTuiManifests(
  root: string,
  lockfile: LockfileLike,
  closure: readonly string[],
): void {
  const ManifestSchema = z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
      license: z.string().optional(),
      scripts: z.record(z.string()).optional(),
    })
    .passthrough();
  for (const packagePath of closure) {
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(join(root, packagePath, "package.json"), "utf8")) as unknown,
    );
    const locked = lockfile.packages[packagePath];
    if (locked === undefined || manifest.version !== locked.version) {
      throw new Error(`${packagePath} installed version does not match lockfile`);
    }
    if (manifest.license !== locked.license) {
      throw new Error(`${packagePath} installed license does not match lockfile`);
    }
    const lifecycle = INSTALL_LIFECYCLE_SCRIPTS.filter(
      (script) => manifest.scripts?.[script] !== undefined,
    );
    if (lifecycle.length > 0) {
      throw new Error(`${packagePath} installed manifest has lifecycle script ${lifecycle[0]}`);
    }
  }
}

export function validateTuiPackageBudget(input: PackageBudgetInput): void {
  assertSafeByteCount(input.baselinePackedBytes, "baseline packed bytes");
  assertSafeByteCount(input.candidatePackedBytes, "candidate packed bytes");
  assertSafeByteCount(input.baselineInstallBytes, "baseline install bytes");
  assertSafeByteCount(input.candidateInstallBytes, "candidate install bytes");
  const packedDelta = input.candidatePackedBytes - input.baselinePackedBytes;
  const installDelta = input.candidateInstallBytes - input.baselineInstallBytes;
  if (packedDelta > TUI_PACKED_DELTA_LIMIT_BYTES) {
    throw new Error(`TUI packed delta ${packedDelta} exceeds ${TUI_PACKED_DELTA_LIMIT_BYTES}`);
  }
  if (installDelta > TUI_INSTALL_DELTA_LIMIT_BYTES) {
    throw new Error(`TUI install delta ${installDelta} exceeds ${TUI_INSTALL_DELTA_LIMIT_BYTES}`);
  }
}

export function runTuiDependencyPolicy(root = process.cwd()): void {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as unknown;
  const lockfileJson = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as unknown;
  validateTuiDependencyPolicy(packageJson, lockfileJson);
  const lockfile = LockfileSchema.parse(lockfileJson);
  const closure = collectTuiDependencyClosure(lockfile);
  validateInstalledTuiManifests(root, lockfile, closure);
  const files = scanInstalledTuiArtifacts(root, closure);
  process.stdout.write(`TUI dependency policy passed (${String(files.length)} files scanned).\n`);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) runTuiDependencyPolicy();
