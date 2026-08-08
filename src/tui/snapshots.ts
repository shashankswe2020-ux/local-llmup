import { createHash } from "node:crypto";
import { z } from "zod";
import { ValidationError } from "../errors.js";
import { BACKEND_NAMES, type BackendName } from "../types.js";
import type { SourceMemory } from "../memory/migrate.js";
import type { MemoryMeta } from "../memory/store.js";
import type { RuntimeState, ServerState } from "../state/state.js";
import { freezeDeep } from "../immutable.js";
import type { Config } from "../config.js";
import { loadSourceMemory } from "../memory/migrate.js";
import { memoryStoreDir, readMemoryMeta } from "../memory/store.js";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isSafeModelId } from "../backend/net.js";
import { assertLoopbackEndpoint } from "../backend/adapter.js";
import type { ExpectedProcessIdentity } from "../backend/adapter.js";
import {
  matchesExpectedExecutable,
  probeListenerIdentity,
  type ListenerIdentity,
} from "../backend/listener.js";
import { isDefaultTrustedLmStudioExecutable } from "../backend/lmstudio.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_BYTES = 16 * 1024 * 1024;

export type ConfirmationOperation =
  | "down"
  | "detach"
  | "migrate"
  | "migrate_move"
  | "replace_server";

export interface ConfirmationSnapshot {
  readonly operation: ConfirmationOperation;
  readonly canonicalTargetIds: readonly string[];
  readonly backend: BackendName | null;
  readonly endpoint: string | null;
  readonly ownedByUs: boolean | null;
  readonly processIdentityHash: string | null;
  readonly stateRevisionHash: string;
  readonly sourceStoreIdentityHash: string | null;
  readonly targetStoreIdentityHash: string | null;
}

export class ConfirmationDriftError extends ValidationError {
  readonly current: ConfirmationSnapshot;

  constructor(
    current: ConfirmationSnapshot,
    message = "confirmation target changed; rebuild review before continuing",
  ) {
    super(message);
    this.name = "ConfirmationDriftError";
    this.current = current;
  }
}

const ConfirmationSnapshotSchema = z
  .object({
    operation: z.enum(["down", "detach", "migrate", "migrate_move", "replace_server"]),
    canonicalTargetIds: z
      .array(
        z
          .string()
          .min(1)
          .max(8 * 1024)
          .refine(
            (value) => isSafeModelId(value) && !value.split("/").includes(".."),
            "unsafe canonical target id",
          ),
      )
      .max(4),
    backend: z.enum(BACKEND_NAMES).nullable(),
    endpoint: z
      .string()
      .url()
      .max(2 * 1024)
      .refine((value) => {
        try {
          assertLoopbackEndpoint(value);
          return true;
        } catch {
          return false;
        }
      }, "endpoint must be loopback HTTP")
      .nullable(),
    ownedByUs: z.boolean().nullable(),
    processIdentityHash: z.string().regex(HASH_PATTERN).nullable(),
    stateRevisionHash: z.string().regex(HASH_PATTERN),
    sourceStoreIdentityHash: z.string().regex(HASH_PATTERN).nullable(),
    targetStoreIdentityHash: z.string().regex(HASH_PATTERN).nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const runtimeValues = [snapshot.backend, snapshot.endpoint, snapshot.ownedByUs];
    const runtimePresent = runtimeValues.every((value) => value !== null);
    const runtimeAbsent = runtimeValues.every((value) => value === null);
    if (!runtimePresent && !runtimeAbsent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["backend"],
        message: "runtime identity fields must be all present or all null",
      });
    }
    if (runtimePresent && snapshot.processIdentityHash === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processIdentityHash"],
        message: "active runtime process identity hash is required",
      });
    }
    if (runtimeAbsent && snapshot.processIdentityHash !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processIdentityHash"],
        message: "absent runtime cannot carry process identity",
      });
    }
    if (snapshot.operation === "down" && snapshot.ownedByUs === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownedByUs"],
        message: "down requires an owned runtime",
      });
    }
    if (
      snapshot.operation === "down" &&
      snapshot.canonicalTargetIds.length !== (runtimePresent ? 1 : 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalTargetIds"],
        message: "down target count must match runtime presence",
      });
    }
    if (snapshot.operation === "detach" && snapshot.ownedByUs !== false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownedByUs"],
        message: "detach requires an attached runtime",
      });
    }
    if (snapshot.operation === "detach" && snapshot.canonicalTargetIds.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalTargetIds"],
        message: "detach requires exactly one active target",
      });
    }
    if (
      snapshot.operation === "replace_server" &&
      snapshot.canonicalTargetIds.length !== (runtimePresent ? 2 : 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalTargetIds"],
        message: "server replacement target count must include current runtime when present",
      });
    }
    if (snapshot.operation === "migrate" || snapshot.operation === "migrate_move") {
      if (snapshot.sourceStoreIdentityHash === null) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceStoreIdentityHash"], message: "migration source hash is required" });
      }
      if (snapshot.targetStoreIdentityHash === null) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetStoreIdentityHash"], message: "migration target hash is required" });
      }
      if (snapshot.canonicalTargetIds.length !== 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["canonicalTargetIds"],
          message: "migration requires source and target ids",
        });
      }
      if (
        snapshot.canonicalTargetIds.length === 2 &&
        snapshot.canonicalTargetIds[0] === snapshot.canonicalTargetIds[1]
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["canonicalTargetIds"],
          message: "migration source and target ids must differ",
        });
      }
    } else if (
      snapshot.sourceStoreIdentityHash !== null ||
      snapshot.targetStoreIdentityHash !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceStoreIdentityHash"],
        message: "non-migration snapshots cannot carry store hashes",
      });
    }
  });

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ValidationError("RFC 8785 input contains a lone surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ValidationError("RFC 8785 input contains a lone surrogate");
    }
  }
}

/** Serialize strict I-JSON according to RFC 8785 (JCS). */
export function canonicalizeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const primitiveChecked = (serialized: string): string => {
    if (Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_BYTES) {
      throw new ValidationError("RFC 8785 input exceeds canonical byte limit");
    }
    return serialized;
  };
  const serialize = (current: unknown): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) {
      throw new ValidationError("RFC 8785 input exceeds node limit");
    }
    if (current === null || typeof current === "boolean") {
      return primitiveChecked(JSON.stringify(current));
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new ValidationError("RFC 8785 input contains a non-finite number");
      }
      return primitiveChecked(JSON.stringify(current));
    }
    if (typeof current === "string") {
      assertValidUnicode(current);
      return primitiveChecked(JSON.stringify(current));
    }
    if (typeof current !== "object") {
      throw new ValidationError(`RFC 8785 input contains unsupported ${typeof current}`);
    }
    if (Object.getPrototypeOf(current) !== Object.prototype && !Array.isArray(current)) {
      throw new ValidationError("RFC 8785 input must contain plain objects and arrays only");
    }
    if (seen.has(current)) throw new ValidationError("RFC 8785 input contains a cycle");
    seen.add(current);
    let serialized: string;
    if (Array.isArray(current)) {
      const enumerableKeys = Object.keys(current);
      if (
        enumerableKeys.length !== current.length ||
        current.some((_item, index) => !Object.hasOwn(current, index)) ||
        enumerableKeys.some((key, index) => key !== String(index)) ||
        Reflect.ownKeys(current).some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw new ValidationError("RFC 8785 input contains a sparse or extended array");
      }
      serialized = `[${current.map((item) => serialize(item)).join(",")}]`;
    } else {
      const ownKeys = Reflect.ownKeys(current);
      const keys = Object.keys(current);
      if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string")) {
        throw new ValidationError("RFC 8785 object contains hidden or symbol properties");
      }
      for (const key of keys) {
        assertValidUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new ValidationError("RFC 8785 object contains an accessor property");
        }
      }
      serialized = `{${keys
        .sort()
        .map((key) => `${serialize(key)}:${serialize((current as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    seen.delete(current);
    return serialized;
  };
  const result = serialize(value);
  if (Buffer.byteLength(result, "utf8") > MAX_CANONICAL_BYTES) {
    throw new ValidationError("RFC 8785 input exceeds canonical byte limit");
  }
  return result;
}

/** SHA-256 lowercase hex over UTF-8 RFC 8785 canonical JSON. */
export function hashValidatedJson(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

const RuntimeIdentitySchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    active: z
      .object({
        backend: z.enum(BACKEND_NAMES),
        modelId: z.string().min(1),
        endpoint: z.string().url(),
        port: z.number().int().min(1).max(65535),
        ownedByUs: z.boolean(),
        pid: z.number().int().positive().nullable(),
        processExecutable: z.string().min(1).nullable(),
        processStartedAt: z.string().min(1).nullable(),
        modelPath: z.string().min(1).nullable(),
        authToken: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

function runtimeIdentity(state: RuntimeState): z.infer<typeof RuntimeIdentitySchema> {
  const active = state.active;
  return RuntimeIdentitySchema.parse({
    schemaVersion: state.schemaVersion,
    active:
      active === null
        ? null
        : {
            backend: active.backend,
            modelId: active.modelId,
            endpoint: active.endpoint,
            port: active.port,
            ownedByUs: active.ownedByUs,
            pid: active.pid ?? null,
            processExecutable: active.processExecutable ?? null,
            processStartedAt: active.processStartedAt ?? null,
            modelPath: active.modelPath ?? null,
            authToken: active.ownedByUs ? (active.authToken ?? null) : null,
          },
  });
}

export function hashRuntimeState(state: RuntimeState): string {
  return hashValidatedJson(runtimeIdentity(state));
}

const ProcessIdentitySchema = z
  .object({
    backend: z.enum(BACKEND_NAMES),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    pid: z.number().int().positive().nullable(),
    ownedByUs: z.boolean(),
    executable: z.string().min(1).nullable(),
    startedAt: z.string().min(1).nullable(),
  })
  .strict();

export function hashProcessIdentity(active: ServerState): string {
  assertLoopbackEndpoint(active.endpoint);
  const endpoint = new URL(active.endpoint);
  return hashValidatedJson(
    ProcessIdentitySchema.parse({
      backend: active.backend,
      host: endpoint.hostname,
      port: active.port,
      pid: active.pid ?? null,
      ownedByUs: active.ownedByUs,
      executable: active.processExecutable ?? null,
      startedAt: active.processStartedAt ?? null,
    }),
  );
}

export interface LiveProcessIdentity {
  readonly hash: string;
  readonly expectedProcess: ExpectedProcessIdentity;
}

export interface LiveProcessIdentityDeps {
  readonly probeListenerIdentity: (
    port: number,
    host: string,
  ) => Promise<ListenerIdentity | null>;
  readonly isBackendExecutable?:
    ((backend: BackendName, identity: ListenerIdentity) => boolean) | undefined;
}

function isBackendExecutable(backend: BackendName, identity: ListenerIdentity): boolean {
  if (backend === "ollama") return matchesExpectedExecutable(identity, "ollama");
  if (backend === "llamacpp") return matchesExpectedExecutable(identity, "llama-server");
  if (backend === "mlx") return matchesExpectedExecutable(identity, "python3");
  return isDefaultTrustedLmStudioExecutable(identity.executable);
}

const defaultLiveProcessIdentityDeps: LiveProcessIdentityDeps = {
  probeListenerIdentity,
  isBackendExecutable,
};

/** Capture the authoritative listener PID/executable/start identity for review. */
export async function captureLiveProcessIdentity(
  active: ServerState,
  deps: LiveProcessIdentityDeps = defaultLiveProcessIdentityDeps,
): Promise<LiveProcessIdentity> {
  assertLoopbackEndpoint(active.endpoint);
  const host = new URL(active.endpoint).hostname;
  const observed = await deps.probeListenerIdentity(active.port, host);
  if (observed === null) {
    throw new ValidationError("unable to verify the active listener process identity");
  }
  const executableCheck = deps.isBackendExecutable ?? isBackendExecutable;
  if (!executableCheck(active.backend, observed)) {
    throw new ValidationError("active listener executable is not approved for its backend");
  }
  if (active.pid !== undefined && observed.pid !== active.pid) {
    throw new ValidationError("active listener PID does not match recorded state");
  }
  if (active.ownedByUs && active.pid === undefined) {
    throw new ValidationError("owned runtime is missing a recorded PID");
  }
  if (
    active.processExecutable !== undefined &&
    observed.executable !== active.processExecutable
  ) {
    throw new ValidationError("active listener executable does not match recorded state");
  }
  if (
    active.processStartedAt !== undefined &&
    observed.started !== active.processStartedAt
  ) {
    throw new ValidationError("active listener start identity does not match recorded state");
  }
  const expectedProcess = freezeDeep({
    pid: observed.pid,
    executable: observed.executable,
    started: observed.started,
  });
  return freezeDeep({
    expectedProcess,
    hash: hashValidatedJson(
      ProcessIdentitySchema.parse({
        backend: active.backend,
        host,
        port: active.port,
        pid: observed.pid,
        ownedByUs: active.ownedByUs,
        executable: observed.executable,
        startedAt: observed.started,
      }),
    ),
  });
}

const MemoryMetaIdentitySchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    modelId: z.string().min(1),
    createdAt: z.string().min(1),
    embedding: z
      .object({ model: z.string().min(1), dimension: z.number().int().positive() })
      .strict()
      .nullable(),
    embeddingUnsupported: z.boolean().nullable(),
  })
  .strict();

function memoryMetaIdentity(meta: MemoryMeta): z.infer<typeof MemoryMetaIdentitySchema> {
  return MemoryMetaIdentitySchema.parse({
    schemaVersion: meta.schemaVersion,
    modelId: meta.modelId,
    createdAt: meta.createdAt,
    embedding:
      meta.embedding === undefined
        ? null
        : { model: meta.embedding.model, dimension: meta.embedding.dimension },
    embeddingUnsupported: meta.embeddingUnsupported ?? null,
  });
}

const TurnSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
    ts: z.string().min(1),
  })
  .strict();
const ChunkSchema = z
  .object({ id: z.string().min(1), text: z.string(), ts: z.string().min(1) })
  .strict();
const VectorSchema = z
  .object({ id: z.string().min(1), vector: z.array(z.number().finite()).max(100_000) })
  .strict();
const FactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    facts: z
      .array(z.object({ text: z.string(), ts: z.string().min(1) }).strict())
      .max(100_000),
  })
  .strict();

function parseFacts(factsText: string, present: boolean): z.infer<typeof FactsSchema> {
  if (!present) {
    if (factsText.length !== 0) {
      throw new ValidationError("absent memory facts cannot contain bytes");
    }
    return { schemaVersion: 1, facts: [] };
  }
  try {
    return FactsSchema.parse(JSON.parse(factsText));
  } catch (error) {
    throw new ValidationError("memory facts are not strict validated JSON", { cause: error });
  }
}

export function hashMemoryStoreIdentity(input: {
  readonly meta: MemoryMeta;
  readonly source: SourceMemory;
}): string {
  const embedding = input.source.embedding;
  const value = {
    meta: memoryMetaIdentity(input.meta),
    turns: z.array(TurnSchema).max(100_000).parse(input.source.turns),
    systemPrompt: input.source.systemPrompt ?? null,
    facts: {
      present: input.source.factsPresent,
      byteLength: Buffer.byteLength(input.source.factsText, "utf8"),
      sha256: createHash("sha256").update(input.source.factsText, "utf8").digest("hex"),
      logical: parseFacts(input.source.factsText, input.source.factsPresent),
    },
    embedding:
      embedding === undefined
        ? null
        : {
            meta: {
              model: embedding.meta.model,
              dimension: embedding.meta.dimension,
            },
            chunks: z.array(ChunkSchema).max(100_000).parse(embedding.chunks),
            vectors: z.array(VectorSchema).max(100_000).parse(embedding.vectors),
          },
  };
  return hashValidatedJson(value);
}

export const ABSENT_STORE_IDENTITY_HASH = hashValidatedJson({ status: "absent" });

export type MemoryStoreIdentity =
  | {
      readonly status: "present";
      readonly hash: string;
      readonly meta: MemoryMeta;
      readonly source: SourceMemory;
    }
  | { readonly status: "absent"; readonly hash: string };

export interface MemoryStoreIdentityDeps {
  readonly memoryStoreDir: typeof memoryStoreDir;
  readonly readMemoryMeta: typeof readMemoryMeta;
  readonly loadSourceMemory: typeof loadSourceMemory;
  readonly lstat: typeof lstatSync;
  readonly assertContained?: ((config: Config, dir: string) => void) | undefined;
}

function assertStoreContained(config: Config, dir: string): void {
  const root = resolve(realpathSync(config.memoryDir));
  const candidate = resolve(realpathSync(dir));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new ValidationError("memory store resolves outside configured memory root");
  }
}

const defaultMemoryStoreIdentityDeps: MemoryStoreIdentityDeps = {
  memoryStoreDir,
  readMemoryMeta,
  loadSourceMemory,
  lstat: lstatSync,
  assertContained: assertStoreContained,
};

function isMissingPath(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === "ENOENT") return true;
    current = current.cause;
  }
  return false;
}

/** Load and hash one complete logical store, or the explicit absent sentinel. */
export function captureMemoryStoreIdentity(
  config: Config,
  modelId: string,
  options: {
    readonly allowAbsent?: boolean | undefined;
    readonly deps?: MemoryStoreIdentityDeps | undefined;
  } = {},
): MemoryStoreIdentity {
  const deps = options.deps ?? defaultMemoryStoreIdentityDeps;
  const dir = deps.memoryStoreDir(config, modelId);
  try {
    deps.lstat(dir);
    deps.assertContained?.(config, dir);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  let before: MemoryMeta;
  try {
    before = deps.readMemoryMeta(dir, modelId, config.memoryDir);
  } catch (error) {
    if (options.allowAbsent === true && isMissingPath(error)) {
      try {
        deps.lstat(dir);
      } catch (directoryError) {
        if (isMissingPath(directoryError)) {
          return Object.freeze({ status: "absent", hash: ABSENT_STORE_IDENTITY_HASH });
        }
      }
    }
    throw error;
  }
  const source = deps.loadSourceMemory(config, modelId);
  const after = deps.readMemoryMeta(dir, modelId, config.memoryDir);
  if (canonicalizeJson(memoryMetaIdentity(before)) !== canonicalizeJson(memoryMetaIdentity(after))) {
    throw new ValidationError("memory store metadata changed while capturing identity");
  }
  return freezeDeep({
    status: "present",
    hash: hashMemoryStoreIdentity({ meta: after, source }),
    meta: structuredClone(after),
    source: structuredClone(source),
  });
}

export function createConfirmationSnapshot(value: ConfirmationSnapshot): ConfirmationSnapshot {
  const parsed = ConfirmationSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError("invalid confirmation snapshot", { cause: parsed.error });
  }
  return freezeDeep(parsed.data);
}

export function createRuntimeConfirmationSnapshot(options: {
  readonly operation: ConfirmationOperation;
  readonly canonicalTargetIds: readonly string[];
  readonly state: RuntimeState;
  readonly sourceStoreIdentityHash?: string | null | undefined;
  readonly targetStoreIdentityHash?: string | null | undefined;
  readonly processIdentityHash?: string | null | undefined;
}): ConfirmationSnapshot {
  const active = options.state.active;
  let processIdentityHash: string | null = null;
  if (active !== null) {
    if (options.processIdentityHash == null) {
      throw new ValidationError("active runtime snapshot requires verified live process identity");
    }
    processIdentityHash = options.processIdentityHash;
  }
  return createConfirmationSnapshot({
    operation: options.operation,
    canonicalTargetIds: [...options.canonicalTargetIds],
    backend: active?.backend ?? null,
    endpoint: active?.endpoint ?? null,
    ownedByUs: active?.ownedByUs ?? null,
    processIdentityHash,
    stateRevisionHash: hashRuntimeState(options.state),
    sourceStoreIdentityHash: options.sourceStoreIdentityHash ?? null,
    targetStoreIdentityHash: options.targetStoreIdentityHash ?? null,
  });
}

export function confirmationSnapshotsEqual(
  first: ConfirmationSnapshot,
  second: ConfirmationSnapshot,
): boolean {
  return canonicalizeJson(ConfirmationSnapshotSchema.parse(first)) === canonicalizeJson(ConfirmationSnapshotSchema.parse(second));
}

export type SnapshotComparison =
  | { readonly type: "unchanged" }
  | { readonly type: "drift"; readonly current: ConfirmationSnapshot };

/** Return a fresh-review drift result instead of inferring approval for changed state. */
export function revalidateConfirmationSnapshot(
  approved: ConfirmationSnapshot,
  current: ConfirmationSnapshot,
): SnapshotComparison {
  const validatedCurrent = createConfirmationSnapshot(current);
  return confirmationSnapshotsEqual(createConfirmationSnapshot(approved), validatedCurrent)
    ? { type: "unchanged" }
    : { type: "drift", current: validatedCurrent };
}

export function assertConfirmationUnchanged(
  approved: ConfirmationSnapshot,
  current: ConfirmationSnapshot,
  message?: string,
): void {
  const result = revalidateConfirmationSnapshot(approved, current);
  if (result.type === "drift") {
    throw new ConfirmationDriftError(result.current, message);
  }
}

export type ConfirmationApproval = "confirmed" | "yes";

export type RevalidationResult<T> =
  | { readonly type: "executed"; readonly value: T }
  | { readonly type: "drift"; readonly current: ConfirmationSnapshot };

/** Re-read under the product lock and execute only on exact approved snapshot equality. */
export async function revalidateConfirmationUnderLock<T>(options: {
  readonly approved: ConfirmationSnapshot;
  readonly approval: ConfirmationApproval;
  readonly withLock: <R>(fn: () => R | Promise<R>) => Promise<R>;
  readonly captureCurrent: () => ConfirmationSnapshot | Promise<ConfirmationSnapshot>;
  readonly execute: () => T | Promise<T>;
}): Promise<RevalidationResult<T>> {
  const approved = createConfirmationSnapshot(options.approved);
  return await options.withLock(async () => {
    const current = createConfirmationSnapshot(await options.captureCurrent());
    const comparison = revalidateConfirmationSnapshot(approved, current);
    if (comparison.type === "drift") {
      return comparison;
    }
    return { type: "executed", value: await options.execute() } as const;
  });
}
