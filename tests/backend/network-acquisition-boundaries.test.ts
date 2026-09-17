import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeExternalUrl, assertSafeFetchUrl } from "../../src/backend/net.js";
import { acquireRepository, createAcquireFetch, lockRepositorySnapshot } from "../../src/backend/acquire.js";
import { buildEndpoint } from "../../src/backend/adapter.js";

afterEach(() => vi.unstubAllGlobals());
describe("external address boundaries", () => {
  it.each(["https://example.com:8443", "https://local.localhost", "https://localhost"])("rejects %s", async (url) => {
    await expect(assertSafeExternalUrl(url, { lookup: vi.fn() })).rejects.toThrow();
  });
  it.each(["0.0.0.1", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.0.1", "172.16.0.1", "192.168.0.1", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::", "4000::1", "2001:1::1", "2001:db8::1", "::ffff:192.168.0.1", "invalid"])("rejects non-public DNS result %s", async (address) => {
    await expect(assertSafeExternalUrl("https://example.com", { lookup: vi.fn(async () => [{ address }]) })).rejects.toThrow("non-public");
  });
  it.each(["8.8.8.8", "172.32.0.1", "169.253.0.1", "198.51.101.1", "203.0.114.1", "2001:4860::1", "2606:4700::1", "::ffff:8.8.8.8"])("accepts public DNS result %s", async (address) => {
    await expect(assertSafeExternalUrl("https://example.com", { lookup: vi.fn(async () => [{ address }]) })).resolves.toBeInstanceOf(URL);
  });
  it("rejects empty DNS answers and supports explicitly allowed public literal download hosts", async () => {
    await expect(assertSafeExternalUrl("https://example.com", { lookup: vi.fn(async () => []) })).rejects.toThrow("no addresses");
    expect(assertSafeFetchUrl("https://8.8.8.8/file", { allowedHosts: ["8.8.8.8"] }).hostname).toBe("8.8.8.8");
    expect(() => assertSafeFetchUrl("https://[::172.16.0.1]/file")).toThrow();
    expect(buildEndpoint("[::1]", 11434)).toBe("http://[::1]:11434");
  });
});

describe("download redirect and repository boundaries", () => {
  it("rejects missing redirect destinations and redirect loops", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createAcquireFetch()("https://huggingface.co/file")).rejects.toThrow("redirect");
    fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(createAcquireFetch()("https://huggingface.co/file")).rejects.toThrow("redirect");
  });
  it("preserves empty bodies, headers, and cancellation signals", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200, headers: { "x-test": "yes" } }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const response = await createAcquireFetch()("https://huggingface.co/file", signal);
    expect(response.body).toBeNull();
    expect(response.headers.get("x-test")).toBe("yes");
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal }));
  });

  const artifact = { file: "config.json", sha256: "a".repeat(64), bytes: 42 };
  const request = { backend: "mlx" as const, repo: "owner/model", revision: "b".repeat(40), files: [artifact] };
  it.each([[], [{ ...artifact, bytes: 0 }], [artifact, artifact], [{ ...artifact, bytes: Number.MAX_SAFE_INTEGER }, { ...artifact, file: "other", bytes: 42 }]])("rejects malformed repository manifest %j", async (files) => {
    await expect(acquireRepository({ ...request, files }, { acquire: vi.fn() })).rejects.toThrow();
  });
  it.each(["unverified", "wrong-size", "relative", "wrong-path", "different-roots", "wrong-files", "cancelled"])("rejects unsafe acquisition result %s", async (scenario) => {
    const controller = new AbortController();
    if (scenario === "cancelled") controller.abort();
    let calls = 0;
    const release = vi.fn();
    await expect(acquireRepository({ ...request, files: [artifact, { ...artifact, file: "other" }] }, {
      signal: controller.signal, lockRepository: () => release,
      acquire: vi.fn(async (file, options) => {
        calls += 1;
        options?.onProgress?.(12);
        return { path: scenario === "relative" ? file.file : scenario === "wrong-path" ? "/cache/wrong" : `${scenario === "different-roots" && calls > 1 ? "/different" : "/cache"}/${file.file}`,
          digestVerified: scenario !== "unverified", bytes: scenario === "wrong-size" ? 1 : 42, cached: false };
      }),
      listFiles: () => ["wrong", "other"], onProgress: vi.fn(),
    })).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects invalid snapshot coordinates before touching the filesystem", () => {
    expect(() => lockRepositorySnapshot({ ...request, repo: "../bad" })).toThrow("invalid repository");
  });
});