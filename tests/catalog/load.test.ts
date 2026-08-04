import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCatalog, loadCatalog, DEFAULT_CATALOG_PATH } from "../../src/catalog/load.js";
import { CatalogError } from "../../src/errors.js";
import { validCatalog } from "./fixtures.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const tmpFiles: string[] = [];
function writeTmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "llmup-catalog-"));
  const file = join(dir, "models.json");
  writeFileSync(file, content, "utf8");
  tmpFiles.push(dir);
  return file;
}

afterEach(() => {
  while (tmpFiles.length > 0) {
    rmSync(tmpFiles.pop()!, { recursive: true, force: true });
  }
});

describe("parseCatalog", () => {
  it("parses and returns a valid catalog", () => {
    const catalog = parseCatalog(JSON.stringify(validCatalog));
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]?.id).toBe("llama3.1:8b");
  });

  it("throws CatalogError on malformed JSON", () => {
    try {
      parseCatalog("{ not json ]");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogError);
      expect((err as CatalogError).message).toMatch(/json/i);
      expect((err as CatalogError).cause).toBeInstanceOf(Error);
    }
  });

  it("throws CatalogError on schema-invalid content, distinct from malformed JSON", () => {
    const bad = clone(validCatalog) as unknown as { models: { license: string }[] };
    bad.models[0]!.license = "proprietary";
    try {
      parseCatalog(JSON.stringify(bad));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogError);
      expect((err as CatalogError).message).toMatch(/schema/i);
      expect((err as CatalogError).message).not.toMatch(/not valid json/i);
    }
  });

  it("strips ANSI and control sequences from model-sourced display fields", () => {
    const dirty = clone(validCatalog) as unknown as {
      models: { id: string; family: string; source: { ollama?: string }; quantizations: { name: string }[] }[];
    };
    dirty.models[0]!.id = "llama\u001b[31m3.1\u001b[0m:8b\u0007";
    dirty.models[0]!.family = "lla\u0000ma";
    dirty.models[0]!.source.ollama = "llama3.1:8b\u001b[2J";
    dirty.models[0]!.quantizations[0]!.name = "Q4\u001b[1m_K_M";

    const catalog = parseCatalog(JSON.stringify(dirty));
    const model = catalog.models[0]!;
    expect(model.id).toBe("llama3.1:8b");
    expect(model.family).toBe("llama");
    expect(model.source.ollama).toBe("llama3.1:8b");
    expect(model.quantizations[0]?.name).toBe("Q4_K_M");
    // No escape or control bytes survive anywhere in the sanitized fields.
    const combined = model.id + model.family + model.quantizations[0]!.name;
    const hasControl = [...combined].some((ch) => {
      const code = ch.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    });
    expect(hasControl).toBe(false);
  });

  it("throws CatalogError on duplicate model ids", () => {
    const dup = clone(validCatalog) as unknown as { models: { id: string }[] };
    dup.models[1]!.id = dup.models[0]!.id;
    expect(() => parseCatalog(JSON.stringify(dup))).toThrow(CatalogError);
  });

  it("detects duplicate ids that only collide after sanitization", () => {
    const dirty = clone(validCatalog) as unknown as { models: { id: string }[] };
    dirty.models[0]!.id = "llama3.1:8b";
    dirty.models[1]!.id = "llama3.1:8b\u001b[0m";
    expect(() => parseCatalog(JSON.stringify(dirty))).toThrow(CatalogError);
  });

  it("does not leak escape sequences through the schema-error message", () => {
    const withRogueKey = {
      ...clone(validCatalog),
      "\u001b[2Jinjected": true,
    };
    try {
      parseCatalog(JSON.stringify(withRogueKey));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogError);
      const message = (err as CatalogError).message;
      const hasControl = [...message].some((ch) => {
        const code = ch.codePointAt(0)!;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      });
      expect(hasControl).toBe(false);
    }
  });

  it("strips BiDi and zero-width codepoints", () => {
    const dirty = clone(validCatalog) as unknown as { models: { family: string }[] };
    dirty.models[0]!.family = "lla\u202ema\u200b";
    const catalog = parseCatalog(JSON.stringify(dirty));
    expect(catalog.models[0]?.family).toBe("llama");
  });

  it("rejects a control character smuggled into params at the schema layer", () => {
    // params is an anchored-regex field, so control chars never reach sanitize.
    const dirty = clone(validCatalog) as unknown as { models: { params: string }[] };
    dirty.models[0]!.params = "8B\n";
    expect(() => parseCatalog(JSON.stringify(dirty))).toThrow(CatalogError);
  });

  it("rejects control characters as an integrity failure when rejectOnSanitize is set", () => {
    const dirty = clone(validCatalog) as unknown as { models: { family: string }[] };
    dirty.models[0]!.family = "lla\u0000ma";
    expect(() => parseCatalog(JSON.stringify(dirty), { rejectOnSanitize: true })).toThrow(
      CatalogError,
    );
    // Same input strips cleanly when not in trusted-seed mode.
    expect(() => parseCatalog(JSON.stringify(dirty))).not.toThrow();
  });
});

describe("loadCatalog", () => {
  it("loads a valid catalog from disk", () => {
    const file = writeTmp(JSON.stringify(validCatalog));
    const catalog = loadCatalog(file);
    expect(catalog.models).toHaveLength(2);
  });

  it("throws CatalogError when the file is missing", () => {
    expect(() => loadCatalog(join(tmpdir(), "does-not-exist-llmup.json"))).toThrow(CatalogError);
  });

  it("defaults to data/models.json at the package root", () => {
    expect(DEFAULT_CATALOG_PATH.replace(/\\/g, "/")).toMatch(/\/data\/models\.json$/);
  });
});
