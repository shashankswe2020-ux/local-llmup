import { afterEach, describe, expect, it, vi } from "vitest";

describe("up module import behavior", () => {
  afterEach(() => {
    vi.doUnmock("../../src/config.js");
    vi.doUnmock("../../src/backend/ollama.js");
    vi.resetModules();
  });

  it("does not load config or construct OllamaAdapter at import time", async () => {
    const loadConfigMock = vi.fn(() => {
      throw new Error("loadConfig called during module import");
    });
    const OllamaAdapterMock = vi.fn(() => {
      throw new Error("OllamaAdapter constructed during module import");
    });

    vi.resetModules();
    vi.doMock("../../src/config.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/config.js")>(
        "../../src/config.js",
      );
      return {
        ...actual,
        loadConfig: loadConfigMock as typeof actual.loadConfig,
      };
    });
    vi.doMock("../../src/backend/ollama.js", () => ({
      OllamaAdapter: OllamaAdapterMock,
    }));

    await expect(import("../../src/commands/up.js")).resolves.toBeDefined();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(OllamaAdapterMock).not.toHaveBeenCalled();
  });
});
