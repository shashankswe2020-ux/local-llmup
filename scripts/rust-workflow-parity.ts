import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { memorySlug, openMemoryStore } from "../src/memory/store.js";
import { captureExchange, extractFacts } from "../src/memory/capture.js";
import { loadSourceMemory, planMigration, type SourceMemory } from "../src/memory/migrate.js";
import { parseDocument } from "../src/library/frontmatter.js";
import { createLibraryService } from "../src/library/service.js";
import { loadConnectors, saveConnectors } from "../src/mcp/store.js";
import { SessionRepository } from "../src/gui/session-repository.js";
import { WorkspaceService } from "../src/gui/workspace/service.js";
import { EditProposalService } from "../src/gui/workspace/edit-proposal.js";

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(
  "cargo",
  ["build", "--locked", "-p", "llmup-runtime", "--example", "workflow_bridge"],
  { cwd: root, stdio: "inherit" },
);
const binary = join(
  root,
  "target",
  "debug",
  "examples",
  process.platform === "win32" ? "workflow_bridge.exe" : "workflow_bridge",
);
const bridge = (requests: readonly unknown[]): unknown[] =>
  z.array(z.unknown()).parse(
    JSON.parse(
      execFileSync(binary, [], {
        input: JSON.stringify(requests),
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  );
const requests: unknown[] = [];
const expected: unknown[] = [];
const add = (request: unknown, result: unknown): void => {
  requests.push(request);
  expected.push(JSON.parse(JSON.stringify(result)) as unknown);
};
for (const id of [
  "Owner/Model:Q4_K_M",
  " model---name ",
  "../evil",
  "CON.json",
  "model".repeat(100),
  "unicode-\u00e9-model",
])
  add({ op: "slug", id }, memorySlug(id));
for (const text of [
  "My name is Ada. I live in Paris. I work as a developer.",
  "I prefer Rust. Remember that backups matter.",
  "My name is Ada. My name is ada.",
  "ordinary conversation",
  "\u00e9My name is Ada.",
])
  add({ op: "facts", text }, extractFacts(text));
for (const raw of [
  "plain body",
  "---\nname: Test\nenabled: false\n---\n\nbody\n",
  '---\nname: "quoted\\"value"\n---\nbody',
  "---\n  name: ignored\n---\nbody",
  "---\nnot closed",
]) {
  const parsed = parseDocument(raw);
  add({ op: "document", raw }, { fields: parsed.frontmatter, body: parsed.body });
}
for (const context of [1, 128, 300, 8192]) {
  const source: SourceMemory = {
    turns: [
      { role: "user", content: "old ".repeat(500), ts: "old" },
      { role: "assistant", content: "recent", ts: "new" },
    ],
    systemPrompt: "persona",
    factsText: '{ "schemaVersion": 1, "facts": [] }\n',
    factsPresent: true,
    embedding: undefined,
  };
  add(
    { op: "migration", source, context },
    await planMigration({ source, targetContextLength: context }),
  );
}
const home = mkdtempSync(join(tmpdir(), "llmup-workflow-parity-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "llmup-workspace-parity-"));
try {
  const config = loadConfig({ LOCAL_LLMUP_HOME: home });
  const now = (): Date => new Date("2026-09-17T00:00:00.000Z");
  const store = openMemoryStore(config, "bridge:model");
  await captureExchange(config, store, { user: "My name is Ada.", assistant: "Hello." }, { now });
  add({ op: "memory", home, model: "bridge:model" }, loadSourceMemory(config, "bridge:model"));
  const library = createLibraryService(config);
  const skill = library.create("skill", { name: "Review", body: "Check boundaries." });
  const agent = library.create("agent", {
    name: "Builder",
    body: "Build carefully.",
    skills: [skill.id],
  });
  add(
    { op: "library", home, agent: agent.id, skills: [skill.id] },
    {
      agents: library.list("agent"),
      skills: library.list("skill"),
      prompt: library.composeForChat(agent.id, [skill.id]),
    },
  );
  saveConnectors(config, {
    schemaVersion: 1,
    connectors: [
      {
        id: "fixture",
        name: "Fixture",
        transport: "stdio",
        command: "never-launched",
        args: [],
        env: { TEST_FLAG: "fixture" },
      },
    ],
  });
  add({ op: "connectors", home }, loadConnectors(config));
  const sessions = new SessionRepository(config, { now });
  const session = sessions.create();
  sessions.append(session.id, { role: "user", content: "hello\nworld\tvalue\u001b[31m" });
  add({ op: "session", home, id: session.id }, sessions.get(session.id));
  for (const query of ["hello", "absent", " world "]) {
    add({ op: "session-search", home, query }, sessions.search(query));
  }
  writeFileSync(join(workspaceRoot, "file.txt"), "before\ncontext\n");
  const workspace = new WorkspaceService();
  const capability = workspace.registerRoot(workspaceRoot);
  const snapshot = workspace.read(capability.id, "file.txt");
  for (const query of ["", " FILE ", "absent"]) {
    add(
      { op: "search", root: workspaceRoot, query, limit: 10 },
      workspace.search(capability.id, query, { limit: 10 }),
    );
  }
  for (const range of [undefined, { startLine: 2, endLine: 2 }, { startLine: 1, endLine: 100 }]) {
    add(
      { op: "read", root: workspaceRoot, path: "file.txt", range },
      workspace.read(capability.id, "file.txt", range),
    );
  }
  const operations = [
    {
      op: "update",
      path: "file.txt",
      baseHash: snapshot.hash,
      hunks: [{ start: 1, end: 1, lines: ["after"] }],
    },
    { op: "create", path: "new.txt", text: "new\n" },
  ];
  const review = new EditProposalService(workspace).review({
    workspaceId: capability.id,
    operations,
  });
  add(
    { op: "review", root: workspaceRoot, operations },
    { files: review.files, warnings: review.warnings },
  );
  const actual = bridge(requests);
  assert.equal(actual.length, expected.length);
  actual.forEach((result, index) =>
    assert.deepEqual(
      result,
      expected[index],
      `workflow fixture ${index}: ${JSON.stringify(requests[index])}`,
    ),
  );
  bridge([
    { op: "capture", home, model: "bridge:model", user: "I prefer Rust.", assistant: "Recorded." },
  ]);
  const afterNative = loadSourceMemory(config, "bridge:model");
  assert.equal(afterNative.turns.length, 4);
  assert.ok(afterNative.factsText.includes(extractFacts("I prefer Rust.")[0] ?? "missing fact"));
  await captureExchange(
    config,
    openMemoryStore(config, "bridge:model"),
    { user: "Remember that rollback matters.", assistant: "Noted." },
    { now },
  );
  assert.deepEqual(
    bridge([{ op: "memory", home, model: "bridge:model" }])[0],
    JSON.parse(JSON.stringify(loadSourceMemory(config, "bridge:model"))) as unknown,
  );
  execFileSync("cargo", ["build", "--locked", "-p", "llmup-cli", "--bin", "llmup-native"], {
    cwd: root,
    stdio: "inherit",
  });
  const native = join(
    root,
    "target",
    "debug",
    process.platform === "win32" ? "llmup-native.exe" : "llmup-native",
  );
  const migrate = (target: string, flags: string[]): void => {
    execFileSync(
      native,
      ["migrate", "--from", "bridge:model", "--to", target, "--context", "8192", ...flags],
      { env: { ...process.env, LOCAL_LLMUP_HOME: home }, timeout: 15000 },
    );
  };
  const beforeMigration = loadSourceMemory(config, "bridge:model");
  migrate("dry-target", ["--dry-run"]);
  assert.equal(existsSync(join(home, "memory", "dry-target")), false);
  assert.deepEqual(loadSourceMemory(config, "bridge:model"), beforeMigration);
  migrate("copy-target", []);
  assert.deepEqual(loadSourceMemory(config, "copy-target"), beforeMigration);
  migrate("move-target", ["--move", "--yes"]);
  assert.deepEqual(loadSourceMemory(config, "move-target"), beforeMigration);
  assert.equal(existsSync(store.dir), false);
  console.log(
    `Rust/TypeScript workflow parity passed: ${requests.length} exact fixtures, bidirectional capture, and native CLI dry-run/copy/move.`,
  );
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
