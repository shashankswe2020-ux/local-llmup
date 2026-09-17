import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInstalledModelVerifier, OllamaInstalledModels } from "../../src/backend/ollama-installed.js";
import type { InstalledModel } from "../../src/backend/installed.js";

const endpoint = "http://127.0.0.1:11435";
const digest = "a".repeat(64);
const model: InstalledModel = { id: "test:latest", digest, sizeBytes: 42, quant: null, contextLength: null, kvBytesPerToken: null, capabilities: [] };
const entry = { name: model.id, digest, size: 42 };

describe("installed model failure boundaries", () => {
  it("validates inventories and excludes remote model aliases", async () => {
    const request = vi.fn().mockResolvedValueOnce({ models: "wrong" }).mockResolvedValueOnce({ models: [
      { ...entry, remote_host: "https://remote.example" }, { ...entry, remote_model: "cloud" },
      { ...entry, details: { quantization_level: "Q4_0" } },
    ] });
    const service = new OllamaInstalledModels({ request, verify: vi.fn() });
    await expect(service.list(endpoint)).rejects.toThrow("inventory");
    await expect(service.list(endpoint)).resolves.toMatchObject([{ quant: "Q4_0" }]);
  });

  it.each([null, { remote_host: "https://remote.example" }])("rejects invalid or remote metadata %j", async (metadata) => {
    const service = new OllamaInstalledModels({ request: vi.fn(async (_endpoint, path) => path === "/api/tags" ? { models: [entry] } : metadata), verify: vi.fn() });
    await expect(service.inspect(endpoint, model.id)).rejects.toThrow("metadata");
  });

  it.each([true, false])("only estimates complete supported geometry (complete=%s)", async (complete) => {
    const info = { "general.architecture": "llama", "llama.block_count": 32, "llama.attention.head_count_kv": 8,
      ...(complete ? { "llama.attention.key_length": 128, "llama.attention.value_length": 128 } : {}) };
    const service = new OllamaInstalledModels({ request: vi.fn(async (_endpoint, path) => path === "/api/tags" ? { models: [entry] } : { model_info: info }), verify: vi.fn() });
    expect((await service.inspect(endpoint, model.id)).kvBytesPerToken).toBe(complete ? 131072 : null);
  });

  it("keeps the original tag when no context is requested and rejects invalid contexts", async () => {
    const service = new OllamaInstalledModels({ request: vi.fn(async () => ({ models: [entry] })), verify: vi.fn() });
    await expect(service.activate(endpoint, model)).resolves.toBe(model.id);
    await expect(service.activate(endpoint, model, 0)).rejects.toThrow("context");
  });

  it.each(["missing-source", "changed-source", "create-failed", "invalid-show", "missing-parameter", "wrong-parameter", "missing-variant", "source-drift"])("fails closed on %s", async (failure) => {
    let lists = 0;
    const variant = "llmup-context-test:65536";
    const request = vi.fn(async (_endpoint: string, path: string) => {
      if (path === "/api/tags") {
        lists += 1;
        if (failure === "missing-source") return { models: [] };
        if (failure === "changed-source" || (failure === "source-drift" && lists === 3)) return { models: [{ ...entry, digest: "b".repeat(64) }] };
        return { models: [entry, ...(lists > 1 && failure !== "missing-variant" ? [{ ...entry, name: variant }] : [])] };
      }
      if (path === "/api/create") return { status: failure === "create-failed" ? "error" : "success" };
      if (failure === "invalid-show") return null;
      if (failure === "missing-parameter") return {};
      return { parameters: failure === "wrong-parameter" ? "temperature 0.5\nnum_ctx 4096" : "num_ctx 65536" };
    });
    const service = new OllamaInstalledModels({ request, verify: vi.fn(), uniqueId: () => "test" });
    await expect(service.activate(endpoint, model, 65536)).rejects.toThrow();
  });
});

describe("installed manifest rejection", () => {
  const blob = { mediaType: "application/vnd.ollama.image.model", digest: `sha256:${digest}`, size: 42 };
  const raw = JSON.stringify({ schemaVersion: 2, config: blob, layers: [blob] });
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  it.each(["too/many/path/segments", "name:tag:extra", "test:"])("rejects unsafe manifest id %s", async (id) => {
    const verify = createInstalledModelVerifier({ readFile: vi.fn() });
    await expect(verify(id, digest)).rejects.toThrow("path");
  });

  it("validates manifest digest, size floor, weights, and stability", async () => {
    const read = vi.fn(async () => raw);
    const verify = createInstalledModelVerifier({ modelsDir: "/models", readFile: read, hashFile: vi.fn(async () => digest), statFile: vi.fn(async () => ({ size: 42 })) });
    await expect(verify("test", "invalid")).rejects.toThrow("digest");
    await expect(verify("registry/namespace/test", sha(raw), undefined, 1000)).rejects.toThrow("size floor");
    await expect(verify("namespace/test", sha(raw), undefined, 42)).resolves.toBeUndefined();
    const noWeights = JSON.stringify({ schemaVersion: 2, config: blob, layers: [{ ...blob, mediaType: "config" }] });
    read.mockResolvedValueOnce(noWeights);
    await expect(verify(model.id, sha(noWeights))).rejects.toThrow("no model weights");
    read.mockResolvedValueOnce(raw).mockResolvedValueOnce("changed");
    await expect(verify(model.id, sha(raw))).rejects.toThrow("changed");
    read.mockRejectedValueOnce("unreadable");
    await expect(verify(model.id, sha(raw))).rejects.toThrow("unavailable content");
  });
});