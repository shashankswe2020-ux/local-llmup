import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import {
  buildEndpoint,
  DEFAULT_BIND_HOST,
  DEFAULT_OLLAMA_PORT,
  type BackendAdapter,
  type ChatRequest,
  type EmbedRequest,
  type PullOptions,
  type ReadinessOptions,
  type ServeHandle,
  type ServeOptions,
} from "../../src/backend/adapter.js";

describe("endpoint helpers", () => {
  it("defaults to loopback and the Ollama port", () => {
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(DEFAULT_OLLAMA_PORT).toBe(11434);
  });

  it("builds a loopback endpoint", () => {
    expect(buildEndpoint(DEFAULT_BIND_HOST, DEFAULT_OLLAMA_PORT)).toBe("http://127.0.0.1:11434");
  });

  it("brackets IPv6 hosts", () => {
    expect(buildEndpoint("::1", 8080)).toBe("http://[::1]:8080");
  });

  const badPorts = [0, -1, 70000, 1.5, Number.NaN];
  for (const port of badPorts) {
    it(`rejects invalid port ${port}`, () => {
      expect(() => buildEndpoint("127.0.0.1", port)).toThrow(ValidationError);
    });
  }
});

/**
 * A stateless in-memory adapter proving the interface is implementable and that
 * an implementation need not hold runtime state between calls.
 */
class FakeAdapter implements BackendAdapter {
  readonly name = "fake";
  readonly calls: string[] = [];

  isInstalled(): Promise<boolean> {
    this.calls.push("isInstalled");
    return Promise.resolve(true);
  }
  installHint(): string {
    return "brew install fake";
  }
  pull(options: PullOptions): Promise<{ modelId: string; digestVerified: boolean }> {
    options.onProgress?.({ status: "pulling" });
    return Promise.resolve({ modelId: options.modelId, digestVerified: false });
  }
  serve(options: ServeOptions = {}): Promise<ServeHandle> {
    const host = options.host ?? DEFAULT_BIND_HOST;
    const port = options.port ?? DEFAULT_OLLAMA_PORT;
    return Promise.resolve({
      endpoint: buildEndpoint(host, port),
      pid: 1234,
      port,
      ownedByUs: true,
    });
  }
  waitUntilReady(_options: ReadinessOptions): Promise<void> {
    return Promise.resolve();
  }
  stop(_handle: ServeHandle): Promise<void> {
    return Promise.resolve();
  }
  chat(request: ChatRequest): Promise<{ content: string }> {
    return Promise.resolve({ content: `echo:${request.messages.length}` });
  }
  embed(request: EmbedRequest): Promise<{ vectors: number[][]; dimension: number }> {
    return Promise.resolve({ vectors: request.input.map(() => [0]), dimension: 1 });
  }
}

describe("BackendAdapter contract", () => {
  it("is implementable and drives the up-flow lifecycle", async () => {
    const adapter = new FakeAdapter();
    const progress: string[] = [];

    expect(await adapter.isInstalled()).toBe(true);
    expect(adapter.installHint()).toContain("fake");

    const pull = await adapter.pull({
      modelId: "llama3.1:8b",
      onProgress: (event) => progress.push(event.status),
    });
    expect(pull.digestVerified).toBe(false);
    expect(progress).toEqual(["pulling"]);

    const handle = await adapter.serve();
    expect(handle.endpoint).toBe("http://127.0.0.1:11434");
    expect(handle.ownedByUs).toBe(true);

    await expect(adapter.waitUntilReady({ endpoint: handle.endpoint })).resolves.toBeUndefined();
    await expect(adapter.stop(handle)).resolves.toBeUndefined();
  });

  it("exposes inference used by chat and migrate", async () => {
    const adapter = new FakeAdapter();
    const chat = await adapter.chat({
      model: "llama3.1:8b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chat.content).toBe("echo:1");

    const embed = await adapter.embed({ model: "nomic-embed-text", input: ["a", "b"] });
    expect(embed.dimension).toBe(1);
    expect(embed.vectors).toHaveLength(2);
  });
});
