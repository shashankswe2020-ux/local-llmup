import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInstalledModelVerifier,
  OllamaInstalledModels,
} from "../../src/backend/ollama-installed.js";

const digest = "a".repeat(64);
const model = { name: "gemma4:e4b-it-qat", digest, size: 3_000_000_000 };

describe("installed Ollama models", () => {
  it("keeps unknown architecture geometry unknown and uses exact installed tags", async () => {
    const request = vi.fn(async (_endpoint: string, path: string) =>
      path === "/api/tags"
        ? { models: [model] }
        : {
            model_info: { "general.architecture": "gemma4", "gemma4.context_length": 131072 },
            capabilities: ["completion"],
          },
    );
    const service = new OllamaInstalledModels({ request, verify: vi.fn() });
    const result = await service.inspect("http://127.0.0.1:11435", model.name);
    expect(result).toMatchObject({ id: model.name, contextLength: 131072, kvBytesPerToken: null });
    await expect(service.inspect("http://127.0.0.1:11435", "gemma4:wrong")).rejects.toThrow(
      "not installed",
    );
  });

  it("verifies content before creating a context variant and never pulls", async () => {
    const verify = vi.fn(async () => undefined);
    let created = false;
    const request = vi.fn(
      async (_endpoint: string, path: string, body?: Record<string, unknown>) => {
        if (path === "/api/tags")
          return {
            models: [model, ...(created ? [{ ...model, name: "llmup-context-test:65536" }] : [])],
          };
        if (path === "/api/create") {
          created = true;
          return { status: "success" };
        }
        return {
          model_info: {},
          capabilities: ["completion"],
          parameters: body?.model === model.name ? "" : "num_ctx 65536",
        };
      },
    );
    const service = new OllamaInstalledModels({ request, verify, uniqueId: () => "test" });
    const selected = await service.inspect("http://127.0.0.1:11434", model.name);
    await service.activate("http://127.0.0.1:11434", selected, 65536);
    expect(verify).toHaveBeenCalledWith(model.name, digest);
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:11434", "/api/create", {
      model: "llmup-context-test:65536",
      from: model.name,
      parameters: { num_ctx: 65536 },
      stream: false,
    });
    expect(request.mock.calls.some((call) => call[1].includes("pull"))).toBe(false);
  });

  it("does not activate when local verification fails", async () => {
    const request = vi.fn(async () => ({ models: [model] }));
    const service = new OllamaInstalledModels({
      request,
      verify: vi.fn(async () => {
        throw new Error("digest mismatch");
      }),
    });
    await expect(
      service.activate(
        "http://127.0.0.1:11434",
        {
          id: model.name,
          digest,
          sizeBytes: model.size,
          contextLength: null,
          kvBytesPerToken: null,
          quant: null,
          capabilities: ["completion"],
        },
        65536,
      ),
    ).rejects.toThrow("digest mismatch");
    expect(request.mock.calls.every((call) => call[1] !== "/api/create")).toBe(true);
  });
});

describe("local manifest verification", () => {
  const blob = {
    mediaType: "application/vnd.ollama.image.model",
    digest: `sha256:${digest}`,
    size: 42,
  };
  const raw = JSON.stringify({ schemaVersion: 2, config: blob, layers: [blob] });
  const manifestDigest = createHash("sha256").update(raw).digest("hex");

  it("hashes every referenced blob against the pinned manifest", async () => {
    const hashFile = vi.fn(async () => digest);
    const verify = createInstalledModelVerifier({
      modelsDir: "/models",
      readFile: vi.fn(async () => raw),
      hashFile,
      statFile: vi.fn(async () => ({ size: 42 })),
    });
    await verify(model.name, manifestDigest);
    expect(hashFile).toHaveBeenCalledWith(`/models/blobs/sha256-${digest}`);
  });

  it("rejects corrupt content, changed manifests, and traversal", async () => {
    const verify = createInstalledModelVerifier({
      modelsDir: "/models",
      readFile: vi.fn(async () => raw),
      hashFile: vi.fn(async () => "b".repeat(64)),
      statFile: vi.fn(async () => ({ size: 42 })),
    });
    await expect(verify(model.name, manifestDigest)).rejects.toThrow("integrity");
    await expect(verify(model.name, digest)).rejects.toThrow("manifest");
    await expect(verify("../bad:tag", manifestDigest)).rejects.toThrow();
  });

  it("retains a catalog digest requirement for known installed weights", async () => {
    const verify = createInstalledModelVerifier({
      modelsDir: "/models",
      readFile: vi.fn(async () => raw),
      hashFile: vi.fn(async () => digest),
      statFile: vi.fn(async () => ({ size: 42 })),
    });
    await expect(verify(model.name, manifestDigest, "b".repeat(64))).rejects.toThrow("catalog");
    await expect(verify(model.name, manifestDigest, digest)).resolves.toBeUndefined();
  });
});
