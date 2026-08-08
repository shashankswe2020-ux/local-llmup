import { describe, expect, it, vi } from "vitest";
import {
  ABSENT_STORE_IDENTITY_HASH,
  canonicalizeJson,
  captureMemoryStoreIdentity,
  captureLiveProcessIdentity,
  createConfirmationSnapshot,
  hashMemoryStoreIdentity,
  hashProcessIdentity,
  hashRuntimeState,
  hashValidatedJson,
  revalidateConfirmationUnderLock,
  type ConfirmationSnapshot,
} from "../../src/tui/snapshots.js";
import type { SourceMemory } from "../../src/memory/migrate.js";
import type { MemoryMeta } from "../../src/memory/store.js";
import type { RuntimeState } from "../../src/state/state.js";
import type { Config } from "../../src/config.js";
import { MemoryError } from "../../src/errors.js";

const config = {
  homeDir: "/tmp/llmup",
  stateFile: "/tmp/llmup/state.json",
  lockFile: "/tmp/llmup/state.lock",
  memoryDir: "/tmp/llmup/memory",
  stagingDir: "/tmp/llmup/staging",
} satisfies Config;

const state: RuntimeState = {
  schemaVersion: 2,
  active: {
    backend: "ollama",
    modelId: "qwen3:14b",
    endpoint: "http://127.0.0.1:11434",
    port: 11434,
    ownedByUs: true,
    pid: 42,
    processExecutable: "/opt/ollama",
    processStartedAt: "2026-08-09T00:00:00.000Z",
  },
};

const meta: MemoryMeta = {
  schemaVersion: 1,
  modelId: "qwen3:14b",
  createdAt: "2026-08-09T00:00:00.000Z",
};

const source: SourceMemory = {
  turns: [
    { role: "user", content: "hello", ts: "2026-08-09T00:00:01.000Z" },
    { role: "assistant", content: "hi", ts: "2026-08-09T00:00:02.000Z" },
  ],
  systemPrompt: undefined,
  factsText: '{"facts":[],"schemaVersion":1}\n',
  factsPresent: true,
  embedding: undefined,
};

function snapshot(overrides: Partial<ConfirmationSnapshot> = {}): ConfirmationSnapshot {
  return createConfirmationSnapshot({
    operation: "down",
    canonicalTargetIds: ["qwen3:14b"],
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    ownedByUs: true,
    processIdentityHash: hashProcessIdentity(state.active!),
    stateRevisionHash: hashRuntimeState(state),
    sourceStoreIdentityHash: null,
    targetStoreIdentityHash: null,
    ...overrides,
  });
}

describe("RFC 8785 canonical JSON", () => {
  it("matches the RFC primitive and recursive property-order sample", () => {
    const value = {
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    expect(canonicalizeJson(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
    expect(hashValidatedJson(value)).toBe(
      "2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb",
    );
  });

  it("sorts property names by raw UTF-16 code units and preserves array order", () => {
    const value = {
      "\ufb33": "Hebrew",
      "😀": "Emoji",
      "€": "Euro",
      ö: "Latin",
      "\r": "CR",
      "1": "One",
      "\u0080": "Control",
      nested: [{ z: 1, a: 2 }],
    };
    expect(canonicalizeJson(value)).toBe(
      '{"\\r":"CR","1":"One","nested":[{"a":2,"z":1}],"":"Control","ö":"Latin","€":"Euro","😀":"Emoji","דּ":"Hebrew"}',
    );
  });

  it.each([
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["undefined", { value: undefined }],
    ["BigInt", { value: 1n }],
    ["lone surrogate", { value: "\ud800" }],
    ["non-plain object", { value: new Date("2026-08-09T00:00:00.000Z") }],
    ["sparse array", { value: new Array(1) }],
  ])("rejects non-I-JSON %s input", (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow("RFC 8785");
  });
});

describe("confirmation identity hashes", () => {
  it("normalizes absent runtime optional fields to explicit nulls", () => {
    const withoutOptionals = hashRuntimeState(state);
    const withUndefinedOptionals = hashRuntimeState({
      ...state,
      active: { ...state.active!, modelPath: undefined, authToken: undefined },
    } as RuntimeState);
    expect(withoutOptionals).toBe(withUndefinedOptionals);
    expect(withoutOptionals).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds process identity to backend, loopback address, ownership, pid, executable, and start", () => {
    const original = hashProcessIdentity(state.active!);
    expect(hashProcessIdentity({ ...state.active!, pid: 43 })).not.toBe(original);
    expect(hashProcessIdentity({ ...state.active!, endpoint: "http://127.0.0.1:11435", port: 11435 })).not.toBe(original);
    expect(hashProcessIdentity({ ...state.active!, processStartedAt: "later" })).not.toBe(original);
  });

  it("captures authoritative live listener identity and rejects PID reuse", async () => {
    const active = state.active!;
    const observed = {
      pid: active.pid!,
      process: "ollama",
      executable: active.processExecutable!,
      started: active.processStartedAt!,
      localAddress: "127.0.0.1",
    };
    const identity = await captureLiveProcessIdentity(active, {
      isBackendExecutable: () => true,
      probeListenerIdentity: async () => observed,
    });
    expect(identity.expectedProcess).toEqual({
      pid: 42,
      executable: "/opt/ollama",
      started: "2026-08-09T00:00:00.000Z",
    });
    expect(identity.hash).toMatch(/^[a-f0-9]{64}$/u);

    await expect(
      captureLiveProcessIdentity(active, {
        isBackendExecutable: () => true,
        probeListenerIdentity: async () => ({ ...observed, pid: 43 }),
      }),
    ).rejects.toThrow("PID does not match");
  });

  it("hashes complete logical memory data independent of object key insertion order", () => {
    const first = hashMemoryStoreIdentity({ meta, source });
    const reorderedMeta: MemoryMeta = {
      createdAt: meta.createdAt,
      modelId: meta.modelId,
      schemaVersion: meta.schemaVersion,
    };
    expect(hashMemoryStoreIdentity({ meta: reorderedMeta, source })).toBe(first);
    expect(
      hashMemoryStoreIdentity({
        meta,
        source: { ...source, turns: [...source.turns].reverse() },
      }),
    ).not.toBe(first);
    expect(ABSENT_STORE_IDENTITY_HASH).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds facts-file presence and exact preserved bytes", () => {
    const absent = hashMemoryStoreIdentity({
      meta,
      source: { ...source, factsPresent: false, factsText: "" },
    });
    const presentEmpty = hashMemoryStoreIdentity({
      meta,
      source: {
        ...source,
        factsPresent: true,
        factsText: '{"schemaVersion":1,"facts":[]}',
      },
    });
    const reformatted = hashMemoryStoreIdentity({
      meta,
      source: {
        ...source,
        factsPresent: true,
        factsText: '{ "schemaVersion": 1, "facts": [] }',
      },
    });
    expect(new Set([absent, presentEmpty, reformatted]).size).toBe(3);
    expect(() =>
      hashMemoryStoreIdentity({
        meta,
        source: { ...source, factsPresent: true, factsText: "" },
      }),
    ).toThrow("strict validated JSON");
    expect(() =>
      hashMemoryStoreIdentity({
        meta,
        source: {
          ...source,
          factsPresent: true,
          factsText: '\ufeff{"schemaVersion":1,"facts":[]}',
        },
      }),
    ).toThrow("strict validated JSON");
  });

  it("captures a stable descriptor-loaded logical store and explicit absence", () => {
    const readMemoryMeta = vi.fn(() => meta);
    const present = captureMemoryStoreIdentity(config, "qwen3:14b", {
      deps: {
        memoryStoreDir: () => "/tmp/store",
        readMemoryMeta,
        loadSourceMemory: () => source,
        lstat: vi.fn(),
      },
    });
    expect(present).toMatchObject({
      status: "present",
      hash: hashMemoryStoreIdentity({ meta, source }),
    });
    expect(readMemoryMeta).toHaveBeenCalledTimes(2);

    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const absent = captureMemoryStoreIdentity(config, "absent:model", {
      allowAbsent: true,
      deps: {
        memoryStoreDir: () => "/tmp/absent",
        readMemoryMeta: () => {
          throw new MemoryError("missing meta", { cause: missing });
        },
        loadSourceMemory: vi.fn(),
        lstat: () => {
          throw missing;
        },
      },
    });
    expect(absent).toEqual({ status: "absent", hash: ABSENT_STORE_IDENTITY_HASH });
  });

  it("fails closed on metadata drift or a corrupt present target", () => {
    const changed = { ...meta, createdAt: "later" };
    let reads = 0;
    expect(() =>
      captureMemoryStoreIdentity(config, "qwen3:14b", {
        deps: {
          memoryStoreDir: () => "/tmp/store",
          readMemoryMeta: () => (++reads === 1 ? meta : changed),
          loadSourceMemory: () => source,
          lstat: vi.fn(),
        },
      }),
    ).toThrow("metadata changed");

    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(() =>
      captureMemoryStoreIdentity(config, "corrupt:model", {
        allowAbsent: true,
        deps: {
          memoryStoreDir: () => "/tmp/corrupt",
          readMemoryMeta: () => {
            throw new MemoryError("missing meta", { cause: missing });
          },
          loadSourceMemory: vi.fn(),
          lstat: vi.fn(() => ({}) as ReturnType<typeof import("node:fs").lstatSync>),
        },
      }),
    ).toThrow("missing meta");
  });

  it("creates a strict frozen snapshot whose hash fields exclude themselves", () => {
    const value = snapshot();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.canonicalTargetIds)).toBe(true);
    expect(value.stateRevisionHash).toBe(hashRuntimeState(state));
    expect(() => createConfirmationSnapshot({ ...value, unknown: true } as never)).toThrow(
      "confirmation snapshot",
    );
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        canonicalTargetIds: ["../../unsafe"],
      }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        endpoint: "http://example.com:11434",
      }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        operation: "migrate",
        sourceStoreIdentityHash: null,
        targetStoreIdentityHash: null,
      }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({ ...value, operation: "detach", ownedByUs: true }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({ ...value, processIdentityHash: null }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({ ...value, backend: null }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        operation: "replace_server",
        canonicalTargetIds: [],
      }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        operation: "detach",
        ownedByUs: false,
        canonicalTargetIds: [],
      }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({ ...value, operation: "down", canonicalTargetIds: [] }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        operation: "replace_server",
        canonicalTargetIds: ["qwen3:14b"],
      }),
    ).toThrow("confirmation snapshot");
    expect(() =>
      createConfirmationSnapshot({
        ...value,
        operation: "migrate",
        canonicalTargetIds: ["qwen3:14b", "qwen3:14b"],
        sourceStoreIdentityHash: "a".repeat(64),
        targetStoreIdentityHash: "b".repeat(64),
      }),
    ).toThrow("confirmation snapshot");
  });
});

describe("locked confirmation revalidation", () => {
  it("executes once under lock when the authoritative snapshot is unchanged", async () => {
    const approved = snapshot();
    const execute = vi.fn(async () => "done");
    const result = await revalidateConfirmationUnderLock({
      approved,
      approval: "confirmed",
      withLock: async (fn) => await fn(),
      captureCurrent: async () => approved,
      execute,
    });
    expect(result).toEqual({ type: "executed", value: "done" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["confirmed", "yes"] as const)(
    "returns drift for %s approval without executing or auto-approving the changed target",
    async (approval) => {
      const approved = snapshot();
      const current = snapshot({ stateRevisionHash: "f".repeat(64) });
      const execute = vi.fn(async () => "unsafe");
      const result = await revalidateConfirmationUnderLock({
        approved,
        approval,
        withLock: async (fn) => await fn(),
        captureCurrent: async () => current,
        execute,
      });
      expect(result).toEqual({ type: "drift", current });
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
