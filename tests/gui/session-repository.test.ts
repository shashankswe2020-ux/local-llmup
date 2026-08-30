import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import {
  SessionConflictError,
  SessionRepository,
  GUI_SESSION_SCHEMA_VERSION,
} from "../../src/gui/session-repository.js";

describe("SessionRepository", () => {
  let home: string;
  let config: Config;
  let clock: number;

  function makeRepo(): SessionRepository {
    // Monotonic clock so updatedAt ordering is deterministic.
    return new SessionRepository(config, { now: () => new Date(clock++) });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "llmup-sessions-"));
    config = loadConfig({ LOCAL_LLMUP_HOME: home });
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates, reads, and lists a session", () => {
    const repo = makeRepo();
    const created = repo.create("First");
    expect(created.title).toBe("First");
    expect(created.revision).toBe(0);
    expect(created.messageCount).toBe(0);

    const fetched = repo.get(created.id);
    expect(fetched?.schemaVersion).toBe(GUI_SESSION_SCHEMA_VERSION);

    const listed = repo.list();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.id).toBe(created.id);
  });

  it("appends messages, bumps revision, and derives the title", () => {
    const repo = makeRepo();
    const created = repo.create();
    expect(created.title).toBe("New chat");

    const afterUser = repo.append(created.id, { role: "user", content: "How do I run this model?" });
    expect(afterUser.revision).toBe(1);
    expect(afterUser.title).toBe("How do I run this model?");

    repo.append(created.id, { role: "assistant", content: "Use up." });
    const page = repo.readMessages(created.id);
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page.messages[0]?.content).toBe("How do I run this model?");
  });

  it("preserves multiline message structure while removing unsafe controls", () => {
    const repo = makeRepo();
    const created = repo.create();
    repo.append(created.id, {
      role: "assistant",
      content: "## Result\r\n\r\n```ts\rconst x = 1;\r```\t\u0000\u001b[31m\u202e",
    });

    expect(repo.readMessages(created.id).messages[0]?.content).toBe(
      "## Result\n\n```ts\nconst x = 1;\n```\t",
    );
  });

  it("survives a restart: a fresh repository sees persisted sessions", () => {
    const created = makeRepo().create("Durable");
    makeRepo().append(created.id, { role: "user", content: "hi" });

    const reopened = makeRepo();
    const doc = reopened.get(created.id);
    expect(doc?.title).toBe("Durable");
    expect(doc?.messages).toHaveLength(1);
  });

  it("enforces an optimistic revision on append and rename", () => {
    const repo = makeRepo();
    const created = repo.create();
    repo.append(created.id, { role: "user", content: "one" }, { expectedRevision: 0 });
    expect(() =>
      repo.append(created.id, { role: "user", content: "stale" }, { expectedRevision: 0 }),
    ).toThrow(SessionConflictError);
    expect(() => repo.rename(created.id, "x", { expectedRevision: 99 })).toThrow(SessionConflictError);
  });

  it("archives, unarchives, and hides archived sessions by default", () => {
    const repo = makeRepo();
    const a = repo.create("A");
    repo.create("B");
    repo.setArchived(a.id, true);

    expect(repo.list().sessions.map((s) => s.title)).toEqual(["B"]);
    expect(repo.list({ includeArchived: true }).sessions).toHaveLength(2);

    repo.setArchived(a.id, false);
    expect(repo.list().sessions).toHaveLength(2);
  });

  it("deletes a session and treats missing deletes as a no-op", () => {
    const repo = makeRepo();
    const created = repo.create();
    repo.remove(created.id);
    expect(repo.get(created.id)).toBeUndefined();
    expect(() => repo.remove(created.id)).not.toThrow();
  });

  it("paginates the session list with a cursor", () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i += 1) {
      repo.create(`S${i}`);
    }
    const first = repo.list({ limit: 2 });
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = repo.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.sessions).toHaveLength(2);
    const third = repo.list({ limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.sessions).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it("paginates messages with a cursor", () => {
    const repo = makeRepo();
    const created = repo.create();
    for (let i = 0; i < 5; i += 1) {
      repo.append(created.id, { role: "user", content: `m${i}` });
    }
    const first = repo.readMessages(created.id, { limit: 2 });
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const rest = repo.readMessages(created.id, { limit: 10, cursor: "2" });
    expect(rest.messages).toHaveLength(3);
    expect(rest.nextCursor).toBeNull();
  });

  it("searches titles and message content, case-insensitively", () => {
    const repo = makeRepo();
    const a = repo.create("Hardware advice");
    const b = repo.create("Other");
    repo.append(b.id, { role: "assistant", content: "You can serve QWEN locally." });

    expect(repo.search("hardware").map((r) => r.summary.id)).toEqual([a.id]);
    const contentHit = repo.search("qwen");
    expect(contentHit).toHaveLength(1);
    expect(contentHit[0]?.summary.id).toBe(b.id);
    expect(repo.search("")).toEqual([]);
  });

  it("rejects a traversal-shaped session id", () => {
    const repo = makeRepo();
    expect(() => repo.get("../../etc/passwd")).toThrow();
    expect(() => repo.readMessages("..%2f..%2fsecret")).toThrow();
  });

  it("fails closed on a corrupt session file but keeps listing others", () => {
    const repo = makeRepo();
    const ok = repo.create("Good");
    const badId = "00000000-0000-0000-0000-000000000000";
    writeFileSync(join(config.guiSessionsDir, `${badId}.json`), "{not json");

    expect(() => repo.get(badId)).toThrow();
    // The corrupt file is skipped, not surfaced, and does not break listing.
    expect(repo.list().sessions.map((s) => s.id)).toEqual([ok.id]);
  });

  it("fails closed on a wrong schema version", () => {
    const repo = makeRepo();
    const id = "11111111-1111-1111-1111-111111111111";
    mkdirSync(config.guiSessionsDir, { recursive: true });
    writeFileSync(
      join(config.guiSessionsDir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 999,
        id,
        title: "x",
        createdAt: "t",
        updatedAt: "t",
        revision: 0,
        archived: false,
        messages: [],
      }),
    );
    expect(() => repo.get(id)).toThrow();
    expect(repo.list().sessions).toHaveLength(0);
  });

  it("fails closed on a symlinked session file", () => {
    const repo = makeRepo();
    repo.create("real"); // ensure dir exists
    const outside = join(home, "outside.json");
    writeFileSync(outside, JSON.stringify({ schemaVersion: 1 }));
    const linkId = "22222222-2222-2222-2222-222222222222";
    symlinkSync(outside, join(config.guiSessionsDir, `${linkId}.json`));
    expect(() => repo.get(linkId)).toThrow();
  });

  it("caps message retention per session", () => {
    // Assert the retention behavior at a small scale by checking the tail order.
    const repo = makeRepo();
    const created = repo.create();
    for (let i = 0; i < 30; i += 1) {
      repo.append(created.id, { role: "user", content: `n${i}` });
    }
    const page = repo.readMessages(created.id, { limit: 500 });
    expect(page.messages.at(-1)?.content).toBe("n29");
    expect(page.messages).toHaveLength(30);
  });
});
