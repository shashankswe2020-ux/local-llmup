import { describe, expect, it } from "vitest";
import {
  isDeniedPath,
  isIgnoredDirectory,
  normalizeRelativePath,
} from "../../src/gui/workspace/policy.js";
import { ValidationError } from "../../src/errors.js";

describe("workspace policy", () => {
  describe("normalizeRelativePath", () => {
    it("returns the empty string for the root", () => {
      expect(normalizeRelativePath("")).toBe("");
      expect(normalizeRelativePath(undefined)).toBe("");
    });

    it("normalizes forward-slash relative paths", () => {
      expect(normalizeRelativePath("src/gui/server.ts")).toBe("src/gui/server.ts");
      expect(normalizeRelativePath(".")).toBe("");
    });

    it("rejects traversal, absolute, drive, backslash, and NUL inputs", () => {
      for (const bad of [
        "../etc/passwd",
        "src/../../secret",
        "/etc/passwd",
        "C:\\Windows",
        "src\\gui",
        "a\0b",
        "..",
      ]) {
        expect(() => normalizeRelativePath(bad)).toThrow(ValidationError);
      }
    });

    it("rejects overly long or deeply nested paths", () => {
      expect(() => normalizeRelativePath("a".repeat(2000))).toThrow(ValidationError);
      expect(() => normalizeRelativePath(Array.from({ length: 60 }, () => "x").join("/"))).toThrow(
        ValidationError,
      );
    });
  });

  describe("isDeniedPath", () => {
    it("denies secret directories, filenames, prefixes, and extensions", () => {
      for (const denied of [
        ".git/config",
        ".ssh/id_rsa",
        ".aws/credentials",
        ".env",
        "app/.env.local",
        "id_rsa",
        "server.pem",
        "cert.key",
        ".npmrc",
        ".netrc",
      ]) {
        expect(isDeniedPath(denied)).toBe(true);
      }
    });

    it("allows ordinary source files", () => {
      for (const ok of ["src/index.ts", "README.md", "package.json", "docs/plan.md"]) {
        expect(isDeniedPath(ok)).toBe(false);
      }
    });
  });

  describe("isIgnoredDirectory", () => {
    it("ignores noisy build and dependency directories", () => {
      for (const name of ["node_modules", ".git", "dist", "build", "coverage", "__pycache__"]) {
        expect(isIgnoredDirectory(name)).toBe(true);
      }
    });

    it("does not ignore normal directories", () => {
      for (const name of ["src", "docs", "tests"]) {
        expect(isIgnoredDirectory(name)).toBe(false);
      }
    });
  });
});
