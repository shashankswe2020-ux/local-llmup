import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PackageSchema = z.object({ name: z.literal("local-llmup"), version: z.string().regex(VERSION_RE) });
const LockfileSchema = z.object({
  packages: z.record(z.unknown()).refine((packages) => packages[""] !== undefined),
});
const RootLockPackageSchema = PackageSchema;
const PackedArtifactSchema = z.object({
  name: z.literal("local-llmup"),
  version: z.string().regex(VERSION_RE),
  filename: z.string().min(1),
});
const PackSchema = z.union([PackedArtifactSchema, z.array(PackedArtifactSchema).length(1)]);

export function validateReleaseIdentity(
  tag: string,
  packageJson: unknown,
  lockfileJson: unknown,
  packedJson: unknown,
): string {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    throw new Error("release tag must be an immutable v<semver> tag");
  }
  const manifest = PackageSchema.parse(packageJson);
  const lockfile = LockfileSchema.parse(lockfileJson);
  const lockRoot = RootLockPackageSchema.parse(lockfile.packages[""]);
  const parsedPack = PackSchema.parse(packedJson);
  const packed = Array.isArray(parsedPack) ? parsedPack[0] : parsedPack;
  if (packed === undefined) throw new Error("packed artifact manifest is empty");
  const tagVersion = tag.slice(1);
  const versions = [tagVersion, manifest.version, lockRoot.version, packed.version];
  if (!versions.every((version) => version === tagVersion)) {
    throw new Error(`release version mismatch: ${versions.join(" != ")}`);
  }
  const expectedFile = `local-llmup-${tagVersion}.tgz`;
  if (packed.filename !== expectedFile) {
    throw new Error(`packed filename mismatch: expected ${expectedFile}`);
  }
  return packed.filename;
}

export function runReleaseIdentityCheck(
  tag: string | undefined,
  packManifestPath: string | undefined,
): void {
  if (tag === undefined || packManifestPath === undefined) {
    throw new Error("usage: verify-release-identity <vSemver-tag> <pack.json>");
  }
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
  const filename = validateReleaseIdentity(
    tag,
    readJson("package.json"),
    readJson("package-lock.json"),
    readJson(packManifestPath),
  );
  process.stdout.write(`Release identity verified: ${tag} -> ${filename}\n`);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) runReleaseIdentityCheck(process.argv[2], process.argv[3]);
