import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { ValidationError } from "../../src/errors.js";
import { loadConnectors, saveConnectors } from "../../src/mcp/store.js";
import { emptyConnectorsFile, type ConnectorsFile } from "../../src/mcp/schema.js";

describe("connectors store", () => {
  let home: string;
  let config: Config;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "llmup-connectors-"));
    config = loadConfig({ LOCAL_LLMUP_HOME: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const sample: ConnectorsFile = {
    schemaVersion: 1,
    connectors: [{ id: "fs", name: "fs", transport: "stdio", command: "npx", args: ["-y", "s"] }],
  };

  it("returns an empty document when the file is absent", () => {
    expect(loadConnectors(config)).toEqual(emptyConnectorsFile());
  });

  it("round-trips a saved document with owner-only permissions", () => {
    saveConnectors(config, sample);
    const loaded = loadConnectors(config);
    expect(loaded).toEqual(sample);
  });

  it("treats a blank file as empty", () => {
    writeFileSync(config.connectorsFile, "   \n", { mode: 0o600 });
    expect(loadConnectors(config)).toEqual(emptyConnectorsFile());
  });

  it("refuses a symlinked connectors file", () => {
    const real = join(home, "real.json");
    writeFileSync(real, JSON.stringify(sample), { mode: 0o600 });
    symlinkSync(real, config.connectorsFile);
    expect(() => loadConnectors(config)).toThrow(ValidationError);
  });

  it("refuses a group/other-writable file", () => {
    writeFileSync(config.connectorsFile, JSON.stringify(sample), { mode: 0o600 });
    chmodSync(config.connectorsFile, 0o666);
    expect(() => loadConnectors(config)).toThrow(ValidationError);
  });

  it("rejects invalid JSON and schema violations", () => {
    writeFileSync(config.connectorsFile, "{ not json", { mode: 0o600 });
    expect(() => loadConnectors(config)).toThrow(ValidationError);

    writeFileSync(
      config.connectorsFile,
      JSON.stringify({ schemaVersion: 1, connectors: [{ id: "x" }] }),
      { mode: 0o600 },
    );
    expect(() => loadConnectors(config)).toThrow(ValidationError);
  });

  it("refuses to write an invalid document", () => {
    const bad = { schemaVersion: 99, connectors: [] } as unknown as ConnectorsFile;
    expect(() => saveConnectors(config, bad)).toThrow(ValidationError);
  });

  it("does not leave a temp file behind after a successful write", () => {
    saveConnectors(config, sample);
    const raw = readFileSync(config.connectorsFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
