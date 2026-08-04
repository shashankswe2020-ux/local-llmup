import { describe, it, expect } from "vitest";
import {
  LocalLlmupError,
  ValidationError,
  BackendError,
  MemoryError,
  CatalogError,
} from "../src/errors.js";

describe("LocalLlmupError", () => {
  it("is an Error subclass carrying a stable code", () => {
    const error = new LocalLlmupError("boom", "GENERIC");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LocalLlmupError");
    expect(error.code).toBe("GENERIC");
    expect(error.message).toBe("boom");
  });

  it("preserves the underlying cause", () => {
    const cause = new Error("root");
    const error = new LocalLlmupError("wrapped", "GENERIC", { cause });
    expect(error.cause).toBe(cause);
  });
});

describe("typed subclasses", () => {
  const cases = [
    { Ctor: ValidationError, name: "ValidationError", code: "VALIDATION" },
    { Ctor: BackendError, name: "BackendError", code: "BACKEND" },
    { Ctor: MemoryError, name: "MemoryError", code: "MEMORY" },
    { Ctor: CatalogError, name: "CatalogError", code: "CATALOG" },
  ] as const;

  for (const { Ctor, name, code } of cases) {
    it(`${name} sets its name and code and remains a LocalLlmupError`, () => {
      const error = new Ctor("msg");
      expect(error).toBeInstanceOf(LocalLlmupError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.message).toBe("msg");
    });
  }

  it("subclasses forward the cause option", () => {
    const cause = new Error("io");
    expect(new BackendError("failed", { cause }).cause).toBe(cause);
  });
});
