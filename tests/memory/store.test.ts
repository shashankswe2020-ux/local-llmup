import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { MemoryError, ValidationError } from "../../src/errors.js";
import {
  MEMORY_SCHEMA_VERSION,
  memorySlug,
  openMemoryStore,
  writeMemoryMeta,
} from "../../src/memory/store.js";

let home: string;
let config: Config;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-mem-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("memorySlug", () => {
  it("maps a model id to a filesystem-safe slug", () => {
    expect(memorySlug("llama3.1:8b")).toBe("llama3.1-8b");
    expect(memorySlug("Qwen2.5:14B-Instruct")).toBe("qwen2.5-14b-instruct");
    expect(memorySlug("a:b/c")).toBe("a-b-c");
  });

  it("neutralizes path-traversal sequences", () => {
    expect(memorySlug("../evil")).toBe("evil");
    expect(memorySlug("/etc/passwd")).toBe("etc-passwd");
  });

  it("rejects an id that slugs to nothing", () => {
    expect(() => memorySlug("   ")).toThrow(ValidationError);
    expect(() => memorySlug("...")).toThrow(ValidationError);
    expect(() => memorySlug("///")).toThrow(ValidationError);
  });

  it("caps long slugs with a deterministic hash suffix", () => {
    const modelId = `Qwen2.5:${"Very-Long-Model-Name-".repeat(16)}`;

    const first = memorySlug(modelId);
    const second = memorySlug(modelId);

    expect(first.length).toBe(128);
    expect(first).toBe(second);
    expect(first).toMatch(/[0-9a-f]{16}$/);
    expect(first).toMatch(/^[a-z0-9._-]+$/);
  });

  it("keeps long ids unique when truncation is required", () => {
    const commonPrefix = "llama3.1:" + "x".repeat(180);
    const one = memorySlug(`${commonPrefix}-alpha`);
    const two = memorySlug(`${commonPrefix}-beta`);

    expect(one.length).toBe(128);
    expect(two.length).toBe(128);
    expect(one).not.toBe(two);
  });

  it("neutralizes Windows reserved device names and dot-space variants on win32", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(memorySlug("CON")).toBe("x-con");
      expect(memorySlug("nul.txt")).toBe("x-nul.txt");
      expect(memorySlug("aux.   ")).toBe("x-aux");
      expect(memorySlug("LPT9...")).toBe("x-lpt9");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("keeps non-Windows slug behavior unchanged for reserved-name strings", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(memorySlug("con")).toBe("con");
      expect(memorySlug("con.txt")).toBe("con.txt");
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("openMemoryStore", () => {
  it("creates the store directory and a schemaVersion'd meta.json", () => {
    const store = openMemoryStore(config, "llama3.1:8b");

    expect(store.modelId).toBe("llama3.1:8b");
    expect(store.dir).toBe(join(config.memoryDir, "llama3.1-8b"));
    expect(store.meta.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);

    const onDisk: unknown = JSON.parse(readFileSync(join(store.dir, "meta.json"), "utf8"));
    expect(onDisk).toMatchObject({ schemaVersion: MEMORY_SCHEMA_VERSION, modelId: "llama3.1:8b" });
    expect(readdirSync(config.stagingDir)).toEqual([]);
  });

  it("reopens idempotently without overwriting existing metadata", () => {
    const first = openMemoryStore(config, "llama3.1:8b");
    const created = first.meta.createdAt;

    const second = openMemoryStore(config, "llama3.1:8b");

    expect(second.meta.createdAt).toBe(created);
  });

  it("refuses to reuse a store whose slug collides with a different model id", () => {
    openMemoryStore(config, "llama3.1:8b");

    expect(() => openMemoryStore(config, "llama3.1-8b")).toThrow(MemoryError);

    // The original owner's metadata is left untouched.
    const meta: unknown = JSON.parse(
      readFileSync(join(config.memoryDir, "llama3.1-8b", "meta.json"), "utf8"),
    );
    expect(meta).toMatchObject({ modelId: "llama3.1:8b" });
  });

  it("creates separate stores for long model ids that share the same truncated prefix", () => {
    const commonPrefix = "qwen2.5:" + "a".repeat(220);
    const firstId = `${commonPrefix}-one`;
    const secondId = `${commonPrefix}-two`;

    const first = openMemoryStore(config, firstId);
    const second = openMemoryStore(config, secondId);

    expect(first.dir).not.toBe(second.dir);
    expect(first.meta.modelId).toBe(firstId);
    expect(second.meta.modelId).toBe(secondId);
  });

  it("restricts store directory and metadata permissions to the owner under a hostile umask", () => {
    const previous = process.umask(0);
    try {
      const store = openMemoryStore(config, "llama3.1:8b");
      expect(statSync(join(store.dir, "meta.json")).mode & 0o777).toBe(0o600);
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  it("fails closed when reopening an existing store with permissive directory permissions", () => {
    const store = openMemoryStore(config, "llama3.1:8b");
    chmodSync(store.dir, 0o755);

    expect(() => openMemoryStore(config, "llama3.1:8b")).toThrow(MemoryError);
  });

  it("fails closed when reopening an existing store with permissive metadata permissions", () => {
    const store = openMemoryStore(config, "llama3.1:8b");
    chmodSync(join(store.dir, "meta.json"), 0o644);

    expect(() => openMemoryStore(config, "llama3.1:8b")).toThrow(MemoryError);
  });

  it("hardens newly created intermediate memory path directories under a hostile umask", () => {
    const root = mkdtempSync(join(tmpdir(), "llmup-mem-nested-"));
    const nestedHome = join(root, "a", "b", "c");
    const nestedConfig = loadConfig({ LOCAL_LLMUP_HOME: nestedHome });
    const previous = process.umask(0);

    try {
      const store = openMemoryStore(nestedConfig, "llama3.1:8b");
      expect(statSync(join(root, "a")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "a", "b")).mode & 0o777).toBe(0o700);
      expect(statSync(nestedConfig.homeDir).mode & 0o777).toBe(0o700);
      expect(statSync(nestedConfig.memoryDir).mode & 0o777).toBe(0o700);
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails gracefully on an unparseable metadata file", () => {
    const dir = join(config.memoryDir, "llama3.1-8b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "{ not json");

    expect(() => openMemoryStore(config, "llama3.1:8b")).toThrow(MemoryError);
  });

  it("fails gracefully on a schema-invalid metadata file", () => {
    const dir = join(config.memoryDir, "llama3.1-8b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 999 }));

    expect(() => openMemoryStore(config, "llama3.1:8b")).toThrow(MemoryError);
  });

  it("rejects a store directory that symlinks outside the memory root", () => {
    const outside = mkdtempSync(join(tmpdir(), "llmup-escape-"));
    try {
      mkdirSync(config.memoryDir, { recursive: true });
      symlinkSync(outside, join(config.memoryDir, "llama3.1-8b"));

      expect(() => openMemoryStore(config, "llama3.1:8b")).toThrow(MemoryError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("anchors metadata writes to the validated canonical store path", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "llmup-mem-real-"));
    let observedLinkTarget: string | undefined;
    let observedRenameTarget: string | undefined;

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        linkSync: ((
          existingPath: import("node:fs").PathLike,
          newPath: import("node:fs").PathLike,
        ) => {
          observedLinkTarget = String(newPath);
          actual.linkSync(existingPath, newPath);
        }) as typeof import("node:fs").linkSync,
        renameSync: ((oldPath: import("node:fs").PathLike, newPath: import("node:fs").PathLike) => {
          observedRenameTarget = String(newPath);
          actual.renameSync(oldPath, newPath);
        }) as typeof import("node:fs").renameSync,
      };
    });

    try {
      const [{ loadConfig: loadConfigIsolated }, storeModule] = await Promise.all([
        import("../../src/config.js"),
        import("../../src/memory/store.js"),
      ]);

      const isolatedConfig = loadConfigIsolated({ LOCAL_LLMUP_HOME: isolatedHome });
      mkdirSync(isolatedConfig.memoryDir, { recursive: true });

      const canonicalStoreDir = join(isolatedConfig.memoryDir, "canonical-store");
      mkdirSync(canonicalStoreDir, { recursive: true });
      chmodSync(canonicalStoreDir, 0o700);
      symlinkSync(canonicalStoreDir, join(isolatedConfig.memoryDir, "llama3.1-8b"));
      const canonicalMeta = join(realpathSync(canonicalStoreDir), "meta.json");

      const store = storeModule.openMemoryStore(isolatedConfig, "llama3.1:8b");
      expect(observedLinkTarget).toBe(canonicalMeta);

      storeModule.writeMemoryMeta(isolatedConfig, store.dir, {
        ...store.meta,
        embedding: { model: "nomic-embed-text", dimension: 768 },
      });
      expect(observedRenameTarget).toBe(canonicalMeta);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("fails closed when updating metadata for a store with permissive directory permissions", () => {
    const store = openMemoryStore(config, "llama3.1:8b");
    chmodSync(store.dir, 0o755);

    expect(() =>
      writeMemoryMeta(config, store.dir, {
        ...store.meta,
        embedding: { model: "nomic-embed-text", dimension: 768 },
      }),
    ).toThrow(MemoryError);
  });
});
