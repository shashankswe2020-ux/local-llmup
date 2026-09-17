import { describe, expect, it, vi } from "vitest";
import { OllamaAdapter, createDefaultDigestProbe, type FetchFn } from "../../src/backend/ollama.js";

const identity = { pid: 42, process: "ollama", executable: "/nonexistent/ollama", started: "start", localAddress: "127.0.0.1" };
describe("Ollama installed inventory transport", () => {
  it.each(["http://127.0.0.1:11435", "http://127.0.0.1"])("inspects local metadata at %s", async (endpoint) => {
    const fetch = vi.fn<FetchFn>(async (url) => ({ ok: true, status: 200, json: async () =>
      url.endsWith("/api/version") ? { version: "0.32.5" } : url.endsWith("/api/tags") ? { models: [{ name: "test:latest", digest: "a".repeat(64), size: 42 }] } : { model_info: {} },
    }));
    const adapter = new OllamaAdapter({ fetch, binary: identity.executable, listenerProbe: vi.fn(async () => identity) });
    await expect(adapter.installedModels.inspect(endpoint, "test:latest")).resolves.toMatchObject({ id: "test:latest" });
    expect(fetch).toHaveBeenCalledWith(`${endpoint}/api/show`, expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "test:latest" }) }));
  });
  it.each(["http-error", "disappeared", "changed", "malformed-body"])("rejects %s", async (scenario) => {
    let probes = 0;
    const adapter = new OllamaAdapter({ binary: identity.executable,
      listenerProbe: vi.fn(async () => {
        probes += 1;
        if (scenario === "disappeared" && probes === 3) return null;
        return scenario === "changed" && probes === 4 ? { ...identity, pid: 43 } : identity;
      }),
      fetch: vi.fn<FetchFn>(async (url) => url.endsWith("/api/version") ? { ok: true, status: 200, json: async () => ({ version: "0.32.5" }) } : {
        ok: scenario !== "http-error", status: scenario === "http-error" ? 500 : 200,
        ...(scenario === "malformed-body" ? {} : { json: async () => ({ models: [] }) }),
      }),
    });
    await expect(adapter.installedModels.list("http://127.0.0.1:11435")).rejects.toThrow();
  });
});

describe("Ollama manifest layer validation", () => {
  it.each([null, 5, { layers: null }, { layers: [null, 42, { mediaType: "other" }, { mediaType: "application/vnd.ollama.image.model", digest: 2 }, { mediaType: "application/vnd.ollama.image.model", digest: "md5:bad" }, { mediaType: "application/vnd.ollama.image.model", digest: "sha256:invalid" }] }])("returns no evidence for malformed layers %j", async (manifest) => {
    const probe = createDefaultDigestProbe({ modelsDir: "/models", readFile: vi.fn(async () => JSON.stringify(manifest)), hashFile: vi.fn(), statFile: vi.fn() });
    await expect(probe("registry/namespace/test:latest")).resolves.toEqual({});
  });
});