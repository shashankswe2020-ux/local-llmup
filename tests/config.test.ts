import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadUserConfig,
  DIR_MODE,
  FILE_MODE,
  MAX_USER_CONFIG_BYTES,
  type Config,
} from "../src/config.js";
import { ValidationError } from "../src/errors.js";

describe("loadConfig", () => {
  it("defaults the home dir to ~/.local-llmup when the env var is unset", () => {
    const config = loadConfig({});
    expect(config.homeDir).toBe(join(homedir(), ".local-llmup"));
  });

  it("honors LOCAL_LLMUP_HOME when set", () => {
    const config = loadConfig({ LOCAL_LLMUP_HOME: "/tmp/custom-llmup" });
    expect(config.homeDir).toBe("/tmp/custom-llmup");
  });

  it("resolves a relative LOCAL_LLMUP_HOME to an absolute path", () => {
    const config = loadConfig({ LOCAL_LLMUP_HOME: "relative/home" });
    expect(config.homeDir).toBe(join(process.cwd(), "relative/home"));
  });

  it("falls back to the default when LOCAL_LLMUP_HOME is empty or whitespace", () => {
    expect(loadConfig({ LOCAL_LLMUP_HOME: "" }).homeDir).toBe(join(homedir(), ".local-llmup"));
    expect(loadConfig({ LOCAL_LLMUP_HOME: "   " }).homeDir).toBe(join(homedir(), ".local-llmup"));
  });

  it("derives all runtime paths under the home dir", () => {
    const config = loadConfig({ LOCAL_LLMUP_HOME: "/tmp/custom-llmup" });
    expect(config.stateFile).toBe("/tmp/custom-llmup/state.json");
    expect(config.lockFile).toBe("/tmp/custom-llmup/lock");
    expect(config.memoryDir).toBe("/tmp/custom-llmup/memory");
    expect(config.stagingDir).toBe("/tmp/custom-llmup/.staging");
    expect(config.agentsDir).toBe("/tmp/custom-llmup/agents");
    expect(config.skillsDir).toBe("/tmp/custom-llmup/skills");
    expect(config.artifactsDir).toBe("/tmp/custom-llmup/artifacts");
  });

  it("reads process.env by default", () => {
    process.env.LOCAL_LLMUP_HOME = "/tmp/env-llmup";
    expect(loadConfig().homeDir).toBe("/tmp/env-llmup");
  });

  it("exposes restrictive permission constants", () => {
    expect(DIR_MODE).toBe(0o700);
    expect(FILE_MODE).toBe(0o600);
  });

  afterEach(() => {
    delete process.env.LOCAL_LLMUP_HOME;
  });
});

describe("loadUserConfig", () => {
  let home: string;
  let config: Config;
  let previousUmask: number;

  beforeEach(() => {
    previousUmask = process.umask(0);
    home = mkdtempSync(join(tmpdir(), "llmup-config-"));
    config = loadConfig({ LOCAL_LLMUP_HOME: home });
  });

  afterEach(() => {
    process.umask(previousUmask);
    rmSync(home, { recursive: true, force: true });
  });

  function writeUserConfig(content: string, mode = 0o600): string {
    const path = join(home, "config.json");
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  }

  it("returns undefined when the config file is absent", () => {
    expect(loadUserConfig(config)).toBeUndefined();
  });

  it("returns undefined when the config file is blank", () => {
    writeUserConfig("   \n");
    expect(loadUserConfig(config)).toBeUndefined();
  });

  it("parses a valid config", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "ollama" }));
    expect(loadUserConfig(config)).toEqual({ schemaVersion: 1, defaultBackend: "ollama" });
  });

  it("accepts a known backend that is not yet registered in Phase 0", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "llamacpp" }));
    expect(loadUserConfig(config)?.defaultBackend).toBe("llamacpp");
  });

  it("accepts a group/other-readable but not writable file (0o644)", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "ollama" }), 0o644);
    expect(loadUserConfig(config)?.defaultBackend).toBe("ollama");
  });

  it("rejects unknown keys", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "ollama", extra: true }));
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects a wrong schema version", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 2, defaultBackend: "ollama" }));
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects an unknown backend name", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "bogus" }));
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects invalid JSON", () => {
    writeUserConfig("{ not json");
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects an oversized file", () => {
    const padding = " ".repeat(MAX_USER_CONFIG_BYTES + 1);
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "ollama" }) + padding);
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects a group/other-writable file", () => {
    writeUserConfig(JSON.stringify({ schemaVersion: 1, defaultBackend: "ollama" }), 0o666);
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects a symlinked config file", () => {
    const target = join(home, "real-config.json");
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, defaultBackend: "ollama" }), {
      mode: 0o600,
    });
    symlinkSync(target, join(home, "config.json"));
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });

  it("rejects a directory at the config path", () => {
    mkdirSync(join(home, "config.json"), { mode: 0o700 });
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });
});
