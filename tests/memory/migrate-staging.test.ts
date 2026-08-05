import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { MemoryError } from "../../src/errors.js";
import {
  stageMigration,
  verifyMigration,
  writeMigration,
  type MigrationPlan,
} from "../../src/memory/migrate.js";

let home: string;
let config: Config;
let sourceDir: string;
let targetDir: string;

const now = (): Date => new Date("2026-01-01T00:00:00.000Z");

function makePlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    turns: [
      { role: "user", content: "hi", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "hello", ts: "2026-01-01T00:00:00.000Z" },
    ],
    systemPrompt: "You are helpful.",
    factsText: `{"schemaVersion":1,"facts":[{"text":"name = Ada","ts":"t"}]}`,
    embedding: {
      meta: { model: "nomic-embed-text", dimension: 2 },
      chunks: [
        { id: "c1", text: "hi", ts: "t" },
        { id: "c2", text: "hello", ts: "t" },
      ],
      vectors: [
        { id: "c1", vector: [0.1, 0.2] },
        { id: "c2", vector: [0.3, 0.4] },
      ],
    },
    summary: {
      turnsCarried: 2,
      turnsSummarized: 0,
      vectorsReembedded: 0,
      strategy: "none",
      embeddingStrategy: "reuse",
    },
    ...overrides,
  };
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/** Populate a directory as if it were an existing store with sentinel content. */
function seedStore(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.jsonl"), `${JSON.stringify({ marker })}\n`);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ marker }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-migrate-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  mkdirSync(config.memoryDir, { recursive: true });
  sourceDir = join(config.memoryDir, "source-model");
  targetDir = join(config.memoryDir, "target-model");
});

afterEach(() => {
  // Restore any perms a test tightened so cleanup can remove the tree.
  try {
    chmodSync(config.memoryDir, 0o700);
  } catch {
    // ignore
  }
  rmSync(home, { recursive: true, force: true });
});

describe("writeMigration", () => {
  it("writes every target artifact and leaves the source in place", () => {
    seedStore(sourceDir, "source");
    const plan = makePlan();

    writeMigration(config, { sourceDir, targetDir, targetModelId: "qwen2.5:14b", plan }, { now });

    const turns = readLines(join(targetDir, "conversation.jsonl")).map(
      (line) => JSON.parse(line) as unknown,
    );
    expect(turns).toEqual(plan.turns);
    expect(readFileSync(join(targetDir, "system.md"), "utf8")).toBe("You are helpful.");
    // facts.json is carried byte-identically.
    expect(readFileSync(join(targetDir, "facts.json"), "utf8")).toBe(plan.factsText);
    expect(readLines(join(targetDir, "embeddings", "chunks.jsonl"))).toHaveLength(2);
    expect(readLines(join(targetDir, "embeddings", "vectors.jsonl"))).toHaveLength(2);

    const meta = JSON.parse(readFileSync(join(targetDir, "meta.json"), "utf8")) as {
      modelId: string;
      embedding?: { model: string; dimension: number };
    };
    expect(meta.modelId).toBe("qwen2.5:14b");
    expect(meta.embedding).toEqual({ model: "nomic-embed-text", dimension: 2 });

    // Staging is cleaned up and the source is untouched.
    expect(readdirSync(config.stagingDir)).toEqual([]);
    expect(existsSync(sourceDir)).toBe(true);
  });

  it("restricts staged artifact permissions to the owner under a hostile umask", () => {
    const previous = process.umask(0);
    try {
      writeMigration(config, { sourceDir, targetDir, targetModelId: "m", plan: makePlan() }, { now });
      expect(statSync(targetDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(targetDir, "meta.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(targetDir, "embeddings")).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  it("deletes the source only after a successful write when --move is set", () => {
    seedStore(sourceDir, "source");

    writeMigration(
      config,
      { sourceDir, targetDir, targetModelId: "m", plan: makePlan() },
      { move: true, now },
    );

    expect(existsSync(sourceDir)).toBe(false);
    expect(existsSync(join(targetDir, "conversation.jsonl"))).toBe(true);
  });

  it("preserves the source when the target write fails (--move)", () => {
    seedStore(sourceDir, "source");
    // A read-only memory root makes the commit rename fail deterministically.
    chmodSync(config.memoryDir, 0o500);

    expect(() =>
      writeMigration(
        config,
        { sourceDir, targetDir, targetModelId: "m", plan: makePlan() },
        { move: true, now },
      ),
    ).toThrow(MemoryError);

    chmodSync(config.memoryDir, 0o700);
    expect(existsSync(sourceDir)).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(config.stagingDir)).toEqual([]);
  });

  it("preserves the source when post-copy verification fails (--move)", () => {
    seedStore(sourceDir, "source");

    expect(() =>
      writeMigration(
        config,
        { sourceDir, targetDir, targetModelId: "m", plan: makePlan() },
        {
          move: true,
          now,
          verify: () => {
            throw new MemoryError("verification failed");
          },
        },
      ),
    ).toThrow(MemoryError);

    // Source preserved, the rolled-back target removed, staging cleaned.
    expect(existsSync(sourceDir)).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
    expect(readdirSync(config.stagingDir)).toEqual([]);
  });

  it("refuses --move when the source overlaps the target", () => {
    seedStore(targetDir, "OLD");

    expect(() =>
      writeMigration(
        config,
        { sourceDir: targetDir, targetDir, targetModelId: "m", plan: makePlan() },
        { move: true, now },
      ),
    ).toThrow(MemoryError);

    // The overlapping target/source was never staged over or deleted.
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(config.stagingDir)).toBe(false);
  });

  it("rolls the target back to its original content when verification fails", () => {
    seedStore(targetDir, "OLD");

    expect(() =>
      writeMigration(
        config,
        { sourceDir, targetDir, targetModelId: "m", plan: makePlan() },
        {
          now,
          verify: () => {
            throw new MemoryError("verification failed");
          },
        },
      ),
    ).toThrow(MemoryError);

    const restored = JSON.parse(readFileSync(join(targetDir, "meta.json"), "utf8")) as {
      marker?: string;
    };
    expect(restored.marker).toBe("OLD");
    expect(readdirSync(config.stagingDir)).toEqual([]);
  });
});

describe("stageMigration", () => {
  it("never touches the original target before commit (crash between write and rename)", () => {
    seedStore(targetDir, "OLD");
    const plan = makePlan();

    const staged = stageMigration(config, targetDir, "m", plan, now);

    // The original target is untouched; the new content sits in staging only.
    const original = JSON.parse(readFileSync(join(targetDir, "meta.json"), "utf8")) as {
      marker?: string;
    };
    expect(original.marker).toBe("OLD");
    expect(existsSync(staged.stagedDir)).toBe(true);
    expect(readLines(join(staged.stagedDir, "conversation.jsonl"))).toHaveLength(2);

    staged.cleanup();
    expect(existsSync(staged.stagedDir)).toBe(false);
  });

  it("atomically swaps staged content into an existing target on commit", () => {
    seedStore(targetDir, "OLD");
    const staged = stageMigration(config, targetDir, "m", makePlan(), now);

    staged.commit();

    const turns = readLines(join(targetDir, "conversation.jsonl"));
    expect(turns).toHaveLength(2);
    expect(readFileSync(join(targetDir, "system.md"), "utf8")).toBe("You are helpful.");
    expect(readdirSync(config.stagingDir)).toEqual([]);
  });

  it("is single-use: committing twice throws and leaves the target intact", () => {
    const staged = stageMigration(config, targetDir, "m", makePlan(), now);
    staged.commit();
    expect(() => staged.commit()).toThrow(MemoryError);
    expect(readLines(join(targetDir, "conversation.jsonl"))).toHaveLength(2);
  });

  it("cleans up the staged directory when commit verification fails", () => {
    const staged = stageMigration(config, targetDir, "m", makePlan(), now);
    expect(() =>
      staged.commit(() => {
        throw new MemoryError("bad");
      }),
    ).toThrow(MemoryError);
    expect(existsSync(staged.stagedDir)).toBe(false);
    expect(readdirSync(config.stagingDir)).toEqual([]);
    expect(existsSync(targetDir)).toBe(false);
  });
});

describe("verifyMigration", () => {
  it("passes for a faithfully written target", () => {
    const plan = makePlan();
    writeMigration(config, { sourceDir, targetDir, targetModelId: "m", plan }, { now });
    expect(() => verifyMigration(targetDir, plan)).not.toThrow();
  });

  it("throws when facts.json bytes were altered", () => {
    const plan = makePlan();
    writeMigration(config, { sourceDir, targetDir, targetModelId: "m", plan }, { now });
    writeFileSync(join(targetDir, "facts.json"), `{"schemaVersion":1,"facts":[]}`);
    expect(() => verifyMigration(targetDir, plan)).toThrow(MemoryError);
  });

  it("throws when the conversation turn count differs", () => {
    const plan = makePlan();
    writeMigration(config, { sourceDir, targetDir, targetModelId: "m", plan }, { now });
    writeFileSync(join(targetDir, "conversation.jsonl"), "");
    expect(() => verifyMigration(targetDir, plan)).toThrow(MemoryError);
  });
});
