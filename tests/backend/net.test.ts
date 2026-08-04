import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import {
  assertSafeFetchUrl,
  assertSafeModelId,
  DEFAULT_ALLOWED_FETCH_HOSTS,
  isSafeModelId,
  MODEL_ID_PATTERN,
} from "../../src/backend/net.js";

describe("model id allow-list", () => {
  const valid = [
    "llama3.1:8b",
    "qwen2.5-coder:7b",
    "nomic-embed-text",
    "library/llama3.1:8b",
    "gemma2:2b-instruct-q4_0",
    "deepseek-r1:1.5b",
  ];
  for (const id of valid) {
    it(`accepts ${id}`, () => {
      expect(isSafeModelId(id)).toBe(true);
      expect(() => assertSafeModelId(id)).not.toThrow();
    });
  }

  const invalid: Array<[string, string]> = [
    ["empty", ""],
    ["uppercase", "Llama3.1"],
    ["space", "llama 3.1"],
    ["semicolon", "llama;rm -rf /"],
    ["command substitution", "llama$(whoami)"],
    ["backtick", "llama`id`"],
    ["pipe", "a|b"],
    ["ampersand", "a&b"],
    ["redirect", "a>b"],
    ["glob", "a*b"],
    ["quote", "a'b"],
    ["newline", "llama3.1\n"],
    ["carriage return", "llama3.1\r"],
    ["null byte", "llama\u00003.1"],
    ["leading dash (option injection)", "-ngl"],
    ["leading double dash", "--verbose"],
  ];
  for (const [label, id] of invalid) {
    it(`rejects ${label}`, () => {
      expect(isSafeModelId(id)).toBe(false);
      expect(() => assertSafeModelId(id)).toThrow(ValidationError);
    });
  }

  it("has an anchored pattern", () => {
    expect(MODEL_ID_PATTERN.source.startsWith("^")).toBe(true);
    expect(MODEL_ID_PATTERN.source.endsWith("$")).toBe(true);
  });
});

describe("fetch URL SSRF guard", () => {
  it("exposes the expected default allow-list", () => {
    expect(DEFAULT_ALLOWED_FETCH_HOSTS).toContain("huggingface.co");
    expect(DEFAULT_ALLOWED_FETCH_HOSTS).toContain("registry.ollama.ai");
  });

  const allowed = [
    "https://huggingface.co/api/models/meta-llama/Llama-3.1-8B",
    "https://cdn-lfs.huggingface.co/repos/x/y",
    "https://registry.ollama.ai/v2/library/llama3.1/manifests/8b",
  ];
  for (const url of allowed) {
    it(`accepts ${url}`, () => {
      const parsed = assertSafeFetchUrl(url);
      expect(parsed.href).toBe(new URL(url).href);
    });
  }

  const rejected: Array<[string, string]> = [
    ["non-HTTPS", "http://huggingface.co/x"],
    ["credentialed", "https://user:pass@huggingface.co/x"],
    ["credentialed username only", "https://token@huggingface.co/x"],
    ["odd port", "https://huggingface.co:8443/x"],
    ["host not allow-listed", "https://evil.com/x"],
    ["allow-list suffix spoof", "https://huggingface.co.evil.com/x"],
    ["localhost", "https://localhost/x"],
    ["loopback v4", "https://127.0.0.1/x"],
    ["unspecified v4", "https://0.0.0.0/x"],
    ["private 10.x", "https://10.0.0.5/x"],
    ["private 192.168.x", "https://192.168.1.10/x"],
    ["private 172.16.x", "https://172.16.4.4/x"],
    ["link-local v4", "https://169.254.169.254/x"],
    ["loopback v6", "https://[::1]/x"],
    ["link-local v6", "https://[fe80::1]/x"],
    ["unique-local v6", "https://[fd00::1]/x"],
    ["ipv4-mapped loopback v6", "https://[::ffff:127.0.0.1]/x"],
    ["ipv4-mapped private v6", "https://[::ffff:10.0.0.1]/x"],
    ["not a url", "not a url"],
    ["ftp scheme", "ftp://huggingface.co/x"],
  ];
  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => assertSafeFetchUrl(url)).toThrow(ValidationError);
    });
  }

  it("does not leak credentials in the error message", () => {
    try {
      assertSafeFetchUrl("https://secretuser:secretpass@evil.com/x");
      expect.unreachable("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("secretpass");
      expect(message).not.toContain("secretuser");
    }
  });

  it("rejects an ipv4-mapped loopback before the allow-list, with a private-host reason", () => {
    try {
      assertSafeFetchUrl("https://[::ffff:127.0.0.1]/x");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect((error as Error).message).toContain("private/loopback");
    }
  });

  it("honors a custom allow-list", () => {
    expect(() =>
      assertSafeFetchUrl("https://example.com/x", { allowedHosts: ["example.com"] }),
    ).not.toThrow();
    expect(() =>
      assertSafeFetchUrl("https://huggingface.co/x", { allowedHosts: ["example.com"] }),
    ).toThrow(ValidationError);
  });
});
