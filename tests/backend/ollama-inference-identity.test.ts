import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/errors.js";
import { OllamaAdapter, type FetchFn } from "../../src/backend/ollama.js";
import type { ListenerIdentity } from "../../src/backend/listener.js";

const TRUSTED: ListenerIdentity = {
  pid: 42,
  process: "ollama",
  executable: "/nonexistent/ollama",
  started: "2026-08-08 00:00:00",
  localAddress: "127.0.0.1",
};

type InferenceKind = "chat" | "embed";

function makeAdapter(options: {
  identities: readonly (ListenerIdentity | null)[];
  versionValid?: boolean;
  events?: string[];
}) {
  let probeIndex = 0;
  const ports: number[] = [];
  const events = options.events ?? [];
  const listenerProbe = vi.fn(async (port: number) => {
    ports.push(port);
    events.push("listener");
    const identity = options.identities[probeIndex] ?? options.identities.at(-1) ?? null;
    probeIndex += 1;
    return identity;
  });
  const fetch = vi.fn<FetchFn>((url) => {
    if (url.endsWith("/api/version")) {
      events.push("version");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(options.versionValid === false ? {} : { version: "0.32.5" }),
      });
    }
    if (url.endsWith("/api/chat")) {
      events.push("chat");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: { content: "ok" } }),
      });
    }
    events.push("embed");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ embeddings: [[0.1, 0.2]] }),
    });
  });
  return {
    adapter: new OllamaAdapter({
      fetch,
      binary: "/nonexistent/ollama",
      listenerProbe,
    }),
    fetch,
    ports,
    events,
  };
}

async function infer(adapter: OllamaAdapter, kind: InferenceKind, endpoint: string): Promise<void> {
  if (kind === "chat") {
    await adapter.chat({ endpoint, model: "smollm2:135m", messages: [] });
    return;
  }
  await adapter.embed({ endpoint, model: "all-minilm:latest", input: ["x"] });
}

type Harness = ReturnType<typeof makeAdapter>;

function dataPostCount(fetch: Harness["fetch"], kind: InferenceKind): number {
  const suffix = kind === "chat" ? "/api/chat" : "/api/embed";
  return fetch.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
}

describe.each<InferenceKind>(["chat", "embed"])("Ollama %s identity preflight", (kind) => {
  it("orders listener → version → listener before the data POST", async () => {
    const harness = makeAdapter({ identities: [TRUSTED, TRUSTED] });

    await infer(harness.adapter, kind, "http://127.0.0.1:18134");

    expect(harness.events).toEqual(["listener", "version", "listener", kind]);
  });

  it("refuses wrong executable, changed process identity, and malformed version", async () => {
    const scenarios = [
      makeAdapter({
        identities: [{ ...TRUSTED, process: "evil", executable: "/nonexistent/evil" }],
      }),
      makeAdapter({ identities: [TRUSTED, { ...TRUSTED, pid: 43 }] }),
      makeAdapter({ identities: [TRUSTED, TRUSTED], versionValid: false }),
    ];

    for (const harness of scenarios) {
      await expect(
        infer(harness.adapter, kind, "http://127.0.0.1:18134"),
      ).rejects.toBeInstanceOf(BackendError);
      expect(dataPostCount(harness.fetch, kind)).toBe(0);
    }
  });

  it("checks omitted/default HTTP port 80 rather than Ollama port 11434", async () => {
    const harness = makeAdapter({ identities: [null] });

    await expect(
      infer(harness.adapter, kind, "http://127.0.0.1"),
    ).rejects.toBeInstanceOf(BackendError);

    expect(harness.ports).toEqual([80]);
    expect(dataPostCount(harness.fetch, kind)).toBe(0);
  });
});
