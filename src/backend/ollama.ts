/**
 * Ollama backend adapter. v1 wraps the `ollama` CLI/daemon: models are pulled
 * with `spawn(..., { shell: false })` (every argument a discrete array element,
 * plus an explicit `--` end-of-options separator) and their integrity is
 * verified against the catalog's recorded SHA-256 digest.
 *
 * This task (T15) implements `pull`, `isInstalled`, and `installHint`; serve,
 * health, lifecycle, chat, and embedding land in later tasks.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import { BackendError } from "../errors.js";
import type {
  BackendAdapter,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  PullOptions,
  PullProgress,
  PullResult,
  ReadinessOptions,
  ServeHandle,
  ServeOptions,
} from "./adapter.js";
import { assertSafeModelId } from "./net.js";

/** Default binary name resolved from `PATH`. */
const OLLAMA_BINARY = "ollama";

/** Media type of the weights layer in an Ollama image manifest. */
const MODEL_LAYER_MEDIA_TYPE = "application/vnd.ollama.image.model";

/** A lowercase-hex SHA-256 digest (exactly 64 hex chars). */
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Cap on the unflushed line buffer, bounding memory for newline-less output. */
const MAX_LINE_BUFFER_BYTES = 64 * 1024;

/** Minimal readable-stream surface consumed from a spawned process. */
export interface ProcessOutputStream {
  onData(listener: (chunk: string) => void): void;
}

/** Minimal child-process surface the adapter depends on (a testability seam). */
export interface SpawnedProcess {
  readonly stdout: ProcessOutputStream | null;
  readonly stderr: ProcessOutputStream | null;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

/** Spawn a child process with `shell: false`; injected in tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal | undefined },
) => SpawnedProcess;

/** Integrity facts about a freshly pulled model, as observed on disk. */
export interface PullVerification {
  /** Lowercase hex SHA-256 of the weights, or undefined if unobtainable. */
  readonly sha256?: string | undefined;
  /** On-disk size of the weights in bytes, or undefined if unobtainable. */
  readonly sizeBytes?: number | undefined;
}

/** Probe the backend store for the integrity facts of a pulled model. */
export type DigestProbe = (modelId: string) => Promise<PullVerification>;

function adaptStream(stream: Readable | null): ProcessOutputStream | null {
  if (stream === null) return null;
  stream.setEncoding("utf8");
  return {
    onData: (listener) => {
      stream.on("data", (chunk: string) => listener(chunk));
    },
  };
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    signal: options.signal,
  });
  return {
    stdout: adaptStream(child.stdout),
    stderr: adaptStream(child.stderr),
    onClose: (listener) => {
      child.on("close", (code) => listener(code));
    },
    onError: (listener) => {
      child.on("error", (error) => listener(error));
    },
  };
};

/** Turn a raw output line into a progress event. */
function toProgress(line: string): PullProgress {
  return { status: line };
}

/** Split streamed chunks into trimmed lines, treating `\r` and `\n` as breaks. */
function lineConsumer(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
    // Bound memory if a (possibly hostile) stream never emits a newline.
    if (buffer.length > MAX_LINE_BUFFER_BYTES) {
      buffer = buffer.slice(buffer.length - MAX_LINE_BUFFER_BYTES);
    }
  };
}

function wrapSpawnError(binary: string, error: Error): BackendError {
  const code = (error as { code?: unknown }).code;
  if (error.name === "AbortError" || code === "ABORT_ERR") {
    return new BackendError(`${binary} was aborted`, { cause: error });
  }
  if (code === "ENOENT") {
    return new BackendError(`${binary} not found on PATH`, { cause: error });
  }
  return new BackendError(`failed to run ${binary}: ${error.message}`, { cause: error });
}

interface RunProcessOptions {
  readonly onLine?: ((line: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Run a process to completion, returning its exit code. */
function runProcess(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      child = spawn(binary, args, { signal: options.signal });
    } catch (error) {
      reject(wrapSpawnError(binary, error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (options.onLine) {
      const consume = lineConsumer(options.onLine);
      child.stdout?.onData(consume);
      child.stderr?.onData(lineConsumer(options.onLine));
    }
    child.onError((error) => reject(wrapSpawnError(binary, error)));
    child.onClose((code) => resolve(code ?? -1));
  });
}

/** True for a single path segment that cannot escape its parent directory. */
function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
  );
}

/** True when `target` resolves inside `base` (belt-and-suspenders traversal guard). */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel.length > 0 && !rel.startsWith("..");
}

/**
 * Parse `name`, `namespace/name`, or `registry/namespace/name` (with `:tag`) into
 * a manifest path. Returns `undefined` if any segment is unsafe or the resulting
 * path would escape `<modelsDir>/manifests` — the model id is untrusted here.
 */
function resolveManifestPath(modelsDir: string, modelId: string): string | undefined {
  let registry = "registry.ollama.ai";
  let namespace = "library";
  let remainder = modelId;

  const segments = modelId.split("/");
  if (segments.length === 3) {
    [registry, namespace, remainder] = segments as [string, string, string];
  } else if (segments.length === 2) {
    [namespace, remainder] = segments as [string, string];
  }

  const colon = remainder.lastIndexOf(":");
  const name = colon === -1 ? remainder : remainder.slice(0, colon);
  const tag = colon === -1 ? "latest" : remainder.slice(colon + 1);

  if (![registry, namespace, name, tag].every(isSafePathSegment)) return undefined;

  const manifestsRoot = join(modelsDir, "manifests");
  const path = join(manifestsRoot, registry, namespace, name, tag);
  return isWithin(manifestsRoot, path) ? path : undefined;
}

interface ModelLayer {
  readonly hex: string;
}

/** Extract the (validated) weights-layer digest from a parsed manifest, if present. */
function findModelLayer(parsed: unknown): ModelLayer | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const layers = (parsed as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return undefined;

  for (const layer of layers) {
    if (typeof layer !== "object" || layer === null) continue;
    const entry = layer as { mediaType?: unknown; digest?: unknown };
    if (entry.mediaType !== MODEL_LAYER_MEDIA_TYPE) continue;
    if (typeof entry.digest !== "string") continue;
    if (!entry.digest.startsWith("sha256:")) continue;
    const hex = entry.digest.slice("sha256:".length);
    // The digest is interpolated into a blob path — reject anything but 64 hex.
    if (!SHA256_HEX.test(hex)) continue;
    return { hex };
  }
  return undefined;
}

function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Options for the default filesystem-backed digest probe. */
export interface DefaultDigestProbeOptions {
  readonly modelsDir?: string | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
  readonly hashFile?: ((path: string) => Promise<string>) | undefined;
  readonly statFile?: ((path: string) => Promise<{ size: number }>) | undefined;
}

/**
 * Build the default {@link DigestProbe} that reads Ollama's content-addressed
 * store: it resolves the model's manifest, locates the weights layer, hashes the
 * referenced blob, and reports its size. Any missing manifest/layer/blob yields
 * an empty result (treated as "digest unavailable" by the caller).
 */
export function createDefaultDigestProbe(options: DefaultDigestProbeOptions = {}): DigestProbe {
  const modelsDir =
    options.modelsDir ?? process.env["OLLAMA_MODELS"] ?? join(homedir(), ".ollama", "models");
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const hashFile = options.hashFile ?? sha256File;
  const statFile = options.statFile ?? (async (path: string) => ({ size: (await fsStat(path)).size }));

  return async (modelId: string): Promise<PullVerification> => {
    const manifestPath = resolveManifestPath(modelsDir, modelId);
    if (manifestPath === undefined) return {};

    let raw: string;
    try {
      raw = await readFile(manifestPath);
    } catch {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }

    const layer = findModelLayer(parsed);
    if (layer === undefined) return {};

    // `layer.hex` is validated as 64 hex chars, so it cannot traverse.
    const blobPath = join(modelsDir, "blobs", `sha256-${layer.hex}`);

    let sha256: string | undefined;
    try {
      sha256 = await hashFile(blobPath);
    } catch {
      sha256 = undefined;
    }

    // Only trust an actually-measured on-disk size; never the (untrusted)
    // manifest-declared size, which an attacker could forge to match.
    let sizeBytes: number | undefined;
    try {
      sizeBytes = (await statFile(blobPath)).size;
    } catch {
      sizeBytes = undefined;
    }

    return { sha256, sizeBytes };
  };
}

/** Options for constructing an {@link OllamaAdapter}. */
export interface OllamaAdapterOptions {
  readonly spawn?: SpawnFn | undefined;
  readonly probe?: DigestProbe | undefined;
  readonly binary?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** Stateless adapter over the Ollama backend. */
export class OllamaAdapter implements BackendAdapter {
  readonly name = "ollama";
  private readonly spawn: SpawnFn;
  private readonly probe: DigestProbe;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: OllamaAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.probe = options.probe ?? createDefaultDigestProbe();
    this.binary = options.binary ?? OLLAMA_BINARY;
    this.platform = options.platform ?? process.platform;
  }

  async isInstalled(): Promise<boolean> {
    try {
      const code = await runProcess(this.spawn, this.binary, ["--version"]);
      return code === 0;
    } catch {
      return false;
    }
  }

  installHint(): string {
    switch (this.platform) {
      case "darwin":
        return "brew install ollama";
      case "linux":
        return "curl -fsSL https://ollama.com/install.sh | sh";
      case "win32":
        return "winget install Ollama.Ollama";
      default:
        return "Install Ollama from https://ollama.com/download";
    }
  }

  async pull(options: PullOptions): Promise<PullResult> {
    // Defence in depth: validate before spawning, keep every argument discrete,
    // and add `--` so a hypothetical leading-dash id cannot become an option.
    assertSafeModelId(options.modelId);

    const onProgress = options.onProgress;
    const code = await runProcess(this.spawn, this.binary, ["pull", "--", options.modelId], {
      onLine: onProgress ? (line) => onProgress(toProgress(line)) : undefined,
      signal: options.signal,
    });

    if (code !== 0) {
      throw new BackendError(`ollama pull failed for ${options.modelId} (exit code ${code})`);
    }

    return this.verifyPull(options);
  }

  private async verifyPull(options: PullOptions): Promise<PullResult> {
    const { sha256, sizeBytes } = await this.probe(options.modelId);
    const expected = options.expectedSha256?.trim().toLowerCase();
    const actual = sha256?.trim().toLowerCase();

    // A catalog digest makes verification mandatory: if we could not compute the
    // downloaded weights' digest, fail closed rather than silently downgrading.
    if (expected !== undefined && expected.length > 0) {
      if (actual === undefined || actual.length === 0) {
        throw new BackendError(
          `cannot verify ${options.modelId}: expected digest ${expected} but no digest was produced for the downloaded weights`,
        );
      }
      if (actual !== expected) {
        throw new BackendError(
          `digest mismatch for ${options.modelId}: expected ${expected}, downloaded ${actual}`,
        );
      }
      return { modelId: options.modelId, digestVerified: true };
    }

    // No catalog digest recorded → size-only fallback. Never fail open: require a
    // measured positive size and reject a mismatch when the expected size is known.
    if (sizeBytes === undefined || sizeBytes <= 0) {
      throw new BackendError(
        `cannot verify ${options.modelId}: the catalog records no digest and no weights were found on disk`,
      );
    }
    if (options.expectedSizeBytes !== undefined && sizeBytes !== options.expectedSizeBytes) {
      throw new BackendError(
        `size mismatch for ${options.modelId}: expected ${options.expectedSizeBytes} bytes, found ${sizeBytes}`,
      );
    }
    return { modelId: options.modelId, digestVerified: false };
  }

  serve(_options?: ServeOptions): Promise<ServeHandle> {
    return Promise.reject(new BackendError("ollama serve is implemented in a later task"));
  }

  waitUntilReady(_options: ReadinessOptions): Promise<void> {
    return Promise.reject(new BackendError("ollama health check is implemented in a later task"));
  }

  stop(_handle: ServeHandle): Promise<void> {
    return Promise.reject(new BackendError("ollama stop is implemented in a later task"));
  }

  chat(_request: ChatRequest): Promise<ChatResult> {
    return Promise.reject(new BackendError("ollama chat is implemented in a later task"));
  }

  embed(_request: EmbedRequest): Promise<EmbedResult> {
    return Promise.reject(new BackendError("ollama embed is implemented in a later task"));
  }
}
