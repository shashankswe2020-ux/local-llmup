import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { readState, writeState } from "../../src/state/state.js";
import { runLs, type LsDeps } from "../../src/commands/ls.js";

let home: string;
let config: Config;
let stdout: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-ls-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
  stdout = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function deps(): LsDeps {
  return {
    config,
    readState,
    write: (t) => stdout.push(t),
  };
}

describe("runLs", () => {
  it("reports when no model is active", () => {
    runLs(deps());
    expect(stdout.join("")).toMatch(/no active model/i);
  });

  it("reflects the active owned server from state", () => {
    writeState(config, {
      schemaVersion: 1,
      active: {
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 9001,
        port: 11434,
        ownedByUs: true,
      },
    });

    runLs(deps());

    const out = stdout.join("");
    expect(out).toContain("llama3.1:8b");
    expect(out).toContain("http://127.0.0.1:11434");
    expect(out).toContain("11434");
    expect(out).toMatch(/owned/i);
  });

  it("marks an attached server distinctly from an owned one", () => {
    writeState(config, {
      schemaVersion: 1,
      active: {
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 0,
        port: 11434,
        ownedByUs: false,
      },
    });

    runLs(deps());

    expect(stdout.join("")).toMatch(/attached/i);
  });

  it("reads state through the injected reader (does not throw on a fresh home)", () => {
    expect(() => runLs(deps())).not.toThrow();
    expect(readState(config).active).toBeNull();
  });
});
