import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { MemoryError, ValidationError } from "../../src/errors.js";
import {
  MEMORY_SCHEMA_VERSION,
  memorySlug,
  openMemoryStore,
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
});
