/**
 * Network and identifier safety utilities shared by the backend adapters and the
 * catalog-enrichment pipeline. Two boundaries are hardened here:
 *
 *  - **Model ids** are validated against a strict allow-list before they reach a
 *    process spawn, so no shell metacharacter can be smuggled into a backend
 *    invocation (defence in depth; the adapter also spawns with `shell: false`).
 *  - **Fetch URLs** consumed by enrichment are checked against an anti-SSRF
 *    policy (HTTPS only, no credentials, standard port, no private/loopback/
 *    link-local targets) and a host allow-list.
 */
import { ValidationError } from "../errors.js";

/**
 * Allowed characters in a resolved model id: lowercase, no shell metacharacters,
 * and no leading `-` (which a backend would parse as an option, not a model
 * name — argument-injection defence).
 */
export const MODEL_ID_PATTERN = /^[a-z0-9._:/][a-z0-9._:/-]*$/;

/** Hosts the enrichment pipeline is permitted to fetch from. */
export const DEFAULT_ALLOWED_FETCH_HOSTS = ["huggingface.co", "registry.ollama.ai"] as const;

/** True when `id` is safe to pass to a backend process as a discrete argument. */
export function isSafeModelId(id: string): boolean {
  // The pattern rejects everything outside the allow-list, but JS `$` also
  // matches just before a single trailing newline — guard that explicitly.
  return MODEL_ID_PATTERN.test(id) && !id.includes("\n") && !id.includes("\r");
}

/**
 * Throw {@link ValidationError} unless `id` matches the model-id allow-list.
 *
 * This guards the **process-argument** boundary only. It intentionally permits
 * `/`, `.`, and `:` for registry ids like `library/name:tag`, so it does NOT
 * sanitize filesystem paths — a caller that maps a model id onto a directory
 * (e.g. the per-model memory store) must add its own per-segment traversal
 * check (reject `..`) or encode the id.
 */
export function assertSafeModelId(id: string): void {
  if (!isSafeModelId(id)) {
    throw new ValidationError(
      `unsafe model id: must match ${MODEL_ID_PATTERN.source} (lowercase, no shell metacharacters)`,
    );
  }
}

/** Options controlling {@link assertSafeFetchUrl}. */
export interface FetchUrlOptions {
  readonly allowedHosts?: readonly string[] | undefined;
}

/**
 * Validate an outbound fetch URL against the anti-SSRF policy and host
 * allow-list, returning the parsed {@link URL}. Throws {@link ValidationError}
 * with a credential-free message on any violation.
 */
export function assertSafeFetchUrl(rawUrl: string, options: FetchUrlOptions = {}): URL {
  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_FETCH_HOSTS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new ValidationError("invalid fetch URL", { cause: error });
  }

  if (url.protocol !== "https:") {
    throw new ValidationError(`refusing non-HTTPS fetch URL: ${redact(url)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError(`refusing credentialed fetch URL: ${redact(url)}`);
  }
  // https default port is exposed as "" by URL; anything else is a non-standard port.
  if (url.port !== "") {
    throw new ValidationError(`refusing non-standard port on fetch URL: ${redact(url)}`);
  }

  const host = normalizeHost(url.hostname);
  assertNotPrivateHost(host);
  if (!isAllowedHost(host, allowedHosts)) {
    throw new ValidationError(`fetch host not allow-listed: ${host}`);
  }
  return url;
}

function redact(url: URL): string {
  return `${url.protocol}//${url.hostname}${url.pathname}`;
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  return allowed.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
}

function assertNotPrivateHost(host: string): void {
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new ValidationError(`refusing loopback fetch host: ${host}`);
  }
  if (isIpV4(host)) {
    if (isPrivateOrLoopbackV4(host)) {
      throw new ValidationError(`refusing private/loopback fetch host: ${host}`);
    }
    return;
  }
  if (host.includes(":") && isPrivateOrLoopbackV6(host)) {
    throw new ValidationError(`refusing private/loopback fetch host: ${host}`);
  }
}

function isIpV4(host: string): boolean {
  const octets = host.split(".");
  return (
    octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isPrivateOrLoopbackV4(host: string): boolean {
  const [a, b] = host.split(".").map(Number) as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isPrivateOrLoopbackV6(host: string): boolean {
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
  // IPv4-mapped/compat forms embed a v4 address; WHATWG may normalize the tail
  // to hex (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1). Decode and apply v4 policy.
  const embedded = embeddedV4FromV6(host);
  return embedded !== null && isPrivateOrLoopbackV4(embedded);
}

function embeddedV4FromV6(host: string): string | null {
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted && isIpV4(dotted[1] as string)) {
    return dotted[1] as string;
  }
  const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1] as string, 16);
    const low = Number.parseInt(hex[2] as string, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}
