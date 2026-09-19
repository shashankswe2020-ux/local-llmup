import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { readState, withLock, writeState, type RuntimeState } from "../src/state/state.js";
import { collectLs, formatLsText } from "../src/commands/ls.js";
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync("cargo", ["build", "--locked", "-p", "llmup-runtime", "--example", "state_bridge"], {
  cwd: root,
  stdio: "inherit",
});
const binary = join(
  root,
  "target",
  "debug",
  "examples",
  process.platform === "win32" ? "state_bridge.exe" : "state_bridge",
);
const home = mkdtempSync(join(tmpdir(), "llmup-rust-state-"));
try {
  const config = loadConfig({ LOCAL_LLMUP_HOME: home });
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
  const common = {
    modelId: "test:latest",
    endpoint: "http://127.0.0.1:18080",
    port: 18080,
    pid: 123,
    processExecutable: "/fake/runtime",
    processStartedAt: "2026-09-17 01:02:03",
  };
  const fixtures: RuntimeState[] = [
    { schemaVersion: 2, active: null },
    { schemaVersion: 2, active: { ...common, backend: "llamacpp", ownedByUs: true } },
    {
      schemaVersion: 2,
      active: { ...common, backend: "mlx", ownedByUs: true, authToken: "a".repeat(64) },
    },
    {
      schemaVersion: 2,
      active: {
        ...common,
        backend: "lmstudio",
        ownedByUs: false,
        modelPath: "owner/model/weights.gguf",
      },
    },
  ];
  for (const fixture of fixtures) {
    await withLock(config, () => writeState(config, fixture));
    execFileSync(binary, ["roundtrip", home], { timeout: 5000 });
    assert.deepEqual(readState(config), fixture);
    const result = collectLs({ config, readState, write: () => undefined });
    const text = execFileSync(native, ["ls"], {
      env: { ...process.env, LOCAL_LLMUP_HOME: home, PATH: "" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(text, formatLsText(result));
    const json: unknown = JSON.parse(
      execFileSync(native, ["ls", "--json"], {
        env: { ...process.env, LOCAL_LLMUP_HOME: home, PATH: "" },
        encoding: "utf8",
        timeout: 5000,
      }),
    );
    assert.deepEqual(json, result);
  }
  writeFileSync(
    config.stateFile,
    JSON.stringify({
      schemaVersion: 1,
      active: {
        modelId: "legacy:latest",
        endpoint: "http://127.0.0.1:11434",
        port: 11434,
        ownedByUs: false,
        pid: 0,
      },
    }),
    { mode: 0o600 },
  );
  const normalized = readState(config);
  execFileSync(binary, ["roundtrip", home], { timeout: 5000 });
  assert.deepEqual(readState(config), normalized);
  const state: RuntimeState = {
    schemaVersion: 2,
    active: {
      backend: "ollama",
      modelId: "gemma4:e4b-it-qat",
      runtimeModelId: "llmup-context-test:65536",
      context: 65536,
      endpoint: "http://127.0.0.1:11435",
      port: 11435,
      ownedByUs: false,
      pid: 123,
      processExecutable: "/fake/ollama",
      processStartedAt: "test-start",
      integrity: "local-manifest",
      localManifestDigest: "a".repeat(64),
    },
  };
  await withLock(config, () => writeState(config, state));
  await withLock(config, () => {
    const result = spawnSync(binary, ["roundtrip", home], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(result.status, 0, "Rust entered a TypeScript-held lock");
  });
  execFileSync(binary, ["roundtrip", home], { timeout: 5000 });
  assert.deepEqual(readState(config), state);
  const child = spawn(binary, ["hold", home], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  try {
    await once(child.stdout, "data");
    await assert.rejects(
      withLock(config, () => undefined, { timeoutMs: 30, pollIntervalMs: 5 }),
      { kind: "locked" },
    );
    child.stdin.end("release\n");
    assert.equal((await exit)[0], 0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
  assert.deepEqual(readState(config), state);
  if (process.platform !== "win32") assert.equal(statSync(config.stateFile).mode & 0o777, 0o600);
  console.log("Rust/TypeScript state round-trip and mutual lock exclusion passed.");
} finally {
  rmSync(home, { recursive: true, force: true });
}
