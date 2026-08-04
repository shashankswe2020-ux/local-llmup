import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, DIR_MODE, FILE_MODE } from "../src/config.js";

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
