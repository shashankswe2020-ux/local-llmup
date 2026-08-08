import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryError } from "../../src/errors.js";
import { readBoundedUtf8File, requireNoFollowFlag } from "../../src/memory/bounded-read.js";

describe("requireNoFollowFlag", () => {
  it("fails closed when the platform has no nonzero no-follow flag", () => {
    expect(() => requireNoFollowFlag(undefined)).toThrow(MemoryError);
    expect(() => requireNoFollowFlag(0)).toThrow(MemoryError);
  });

  it.skipIf(process.platform === "win32")("rejects a substituted symlink root", () => {
    const home = mkdtempSync(join(tmpdir(), "llmup-bounded-read-"));
    try {
      const outside = join(home, "outside");
      const root = join(home, "memory");
      mkdirSync(outside);
      writeFileSync(join(outside, "facts.json"), "{}");
      symlinkSync(outside, root);

      expect(() =>
        readBoundedUtf8File(join(root, "facts.json"), "facts", 1024, {
          allowedRoot: root,
        }),
      ).toThrow(MemoryError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});