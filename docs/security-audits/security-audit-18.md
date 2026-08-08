# Security Audit Report #18

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** Task B14c — `LlamaCppAdapter` `pull` / `chat` / `embed` and the
> `up --backend llamacpp <model>` end-to-end wiring. Uncommitted working-tree
> changes vs `git HEAD 1319dfc`.
> Files audited:
>
> - `src/backend/adapter.ts` (MODIFIED — `PullWeightSource`, `PullOptions.source`, `PullResult.modelPath`)
> - `src/backend/llamacpp.ts` (MODIFIED — `pull`/`chat`/`embed`)
> - `src/backend/acquire.ts` (REVIEWED — shared fail-closed downloader the `pull` delegates to)
> - `src/backend/net.ts` (REVIEWED — SSRF/model-id guards)
> - `src/commands/up.ts` (MODIFIED — backend selection + format-aware source resolution)
> - `src/cli.ts` (MODIFIED — `--backend` parse via `parseBackendName`)
> - `src/catalog/schema.ts` (REVIEWED — `GgufSourceSchema` validation)
>   **Dependencies:** `npm audit` reports 6 advisories (2 critical, 1 high, 3
>   moderate), **all in the dev toolchain** (`vitest` → `vite-node` → `vite`/
>   `esbuild`). Runtime deps (`cac`, `zod`, `systeminformation`) remain clean.
>   Consistent with prior audits, the dev-only advisories are out of scope for this
>   slice.

---

## Overall Risk: LOW

No exploitable vulnerability was found in the B14c slice. Every headline
invariant in the focus areas holds and is fail-closed:

- **(a) SSRF / injection** — the `gguf` source (`repo`/`revision`/`file`) is
  validated **twice** (catalog `GgufSourceSchema`, then `assertValidRequest` in
  `acquireWeight`) before it is composed into a **path-segment-encoded** pinned
  Hugging Face resolve URL that is finally run through `assertSafeFetchUrl`
  (HTTPS-only, `huggingface.co` allow-list, no credentials, standard port, no
  private/loopback host). There is no observed bypass of the URL allow-list or
  the `revision`/`file` constraints.
- **(b) Integrity / fail-closed** — `acquireWeight` verifies the resolved commit
  (`X-Repo-Commit` must equal the pinned 40-hex revision), verifies the SHA-256
  when supplied, writes to a `0600` temp file with the `wx` flag, and only
  **atomically renames** into place after verification; symlinked cache entries
  and cache paths escaping the root are refused; `digestVerified` is propagated
  honestly (never a fabricated pass). A mismatched or partial download is never
  promoted.
- **(c) Command / argv injection** — `serve` spawns `shell:false` with a discrete
  arg array, guards a leading-dash `modelPath`, and `modelPath` originates only
  from the verified cache path; `chat` carries the model id in a `JSON.stringify`
  body, so it cannot break out of the JSON structure. No shell/argv surface.
- **(d) Loopback-only** — `chat` is hardcoded to `127.0.0.1:8080`; `serve` refuses
  a non-loopback bind without `allowNonLoopback`, and `up` never sets that flag.
- **(e) Skipping `assertSafeModelId` in `chat`** — **safe.** The model id reaches
  only a JSON body (never an argv, URL path, or filesystem path) and every place
  it can surface (error messages) is `stripControl`-cleaned at the CLI boundary.

The two Low findings are defence-in-depth / fail-closed-completeness items, not
live vulnerabilities: the catalog currently ships **no `gguf` sources**, so the
self-managed `pull` path is not yet reachable from real data, and both findings
require either a compromised upstream (HTTPS-protected) or an already
same-user-local process.

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 2     |
| Info     | 3     |

---

## Findings

### [LOW-1] `up` serves self-managed weights without gating on `digestVerified`, and there is no size-floor fallback for llama.cpp

- **Location:** [src/commands/up.ts](../../src/commands/up.ts#L203-L228), [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L451-L475)
- **Description:** The domain integrity principle is "verify pulled weights
  against a catalog digest (or size-floor fallback) and **refuse to serve
  unverified weights**." On the Ollama path `up` passes `expectedSha256` /
  `expectedSizeBytes`, so the adapter enforces a digest or a size floor. On the
  llama.cpp path the gguf source's own `sha256` is used **only if present**:
  when a catalog `gguf` entry omits `sha256`, `acquireWeight` returns
  `digestVerified: false` (honestly), but `up` never inspects
  `pullResult.digestVerified` and there is **no size-floor fallback** for the
  self-managed downloader. The weight is served anyway, with no warning.
- **Impact:** If a `gguf` catalog entry lacks a digest, the only integrity
  anchors are the pinned commit (`X-Repo-Commit`) and HTTPS to Hugging Face. A
  mid-stream truncation (no error thrown by the stream pipeline) or a compromised
  upstream that forges a matching `X-Repo-Commit` header would be promoted and
  served. This is a deviation from the stated fail-closed guarantee, mitigated
  today by: (1) the catalog shipping no `gguf` sources yet, (2) HTTPS + the HF
  host allow-list, and (3) the commit-pin check.
- **Proof of concept:** N/A for a remote unauthenticated attacker (blocked by
  HTTPS to a pinned, allow-listed origin). Reachable only with a catalog `gguf`
  entry that has no `sha256` **and** a compromised/MITM'd upstream.
- **Recommendation:** Make the self-managed path fail closed to match Ollama.
  Two complementary options:
  1. In `up`, treat an unverified self-managed pull as a hard stop (or an
     explicit, loud opt-in), e.g.:
     ```ts
     if (ggufSource !== undefined && !pullResult.digestVerified) {
       throw new BackendError(
         `refusing to serve ${model.id}: gguf weights could not be digest-verified`,
       );
     }
     ```
  2. Require `sha256` on `GgufSourceSchema` (drop `.optional()`), so the
     honesty-gate "unknown digest" state can never enter the self-managed serve
     path in the first place.

### [LOW-2] `chat` hardcodes `127.0.0.1:8080` and does no identity check, so it can post the conversation to an unrelated loopback listener

- **Location:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L743-L758)
- **Description:** `chat` always targets `buildEndpoint(DEFAULT_BIND_HOST,
LLAMACPP_DEFAULT_PORT)` (`127.0.0.1:8080`), ignoring the port a server was
  actually started on. `serve` performs a `/props` identity check before
  attaching to a foreign listener, but `chat` re-derives the endpoint from a
  constant and performs **no** identity check. When a model is served on a
  non-default port (`up --port 9090`), a `chat` request would POST the full
  conversation to whatever process happens to listen on `127.0.0.1:8080`.
- **Impact:** Conversation content (potentially sensitive prompts) could be sent
  to an unrelated same-user local process squatting on port 8080. Bounded to
  loopback and to same-user local processes, so this is a
  privacy/robustness gap rather than a remote vulnerability.
- **Recommendation:** Thread the real endpoint (from `ServeHandle` / `state.json`)
  into `chat` instead of a hardcoded host:port, mirroring how the readiness/attach
  paths carry `endpoint`. Optionally reuse the `/props` identity check before
  sending a prompt so `chat` never speaks to an unverified listener.

---

## Info

### [INFO-1] Skipping `assertSafeModelId` in `chat` is a sound, deliberate choice

Not validating `request.model` in `chat` is **safe** and correctly reasoned in
the code comment: the id travels only inside a `JSON.stringify` body (no argv, no
URL path, no filesystem mapping), so no shell/argv/path-traversal surface is
opened, and it legitimately needs to preserve uppercase HF-style names that
`MODEL_ID_PATTERN` (lowercase-only) would reject. The only places the id can
resurface are `BackendError` messages (`llamacpp chat failed for
${request.model}`), and those are `stripControl`-cleaned at the CLI output
boundary. Recommendation: keep `request.model` out of any future argv/URL/log/
filesystem path; if that ever changes, add a boundary check there rather than in
`chat`.

### [INFO-2] Redirects are followed without re-applying the SSRF allow-list to the redirect target

- **Location:** [src/backend/acquire.ts](../../src/backend/acquire.ts#L95-L118)
- **Description:** `createAcquireFetch` uses `fetch(url, { redirect: "follow" })`.
  `assertSafeFetchUrl` validates only the **initial** resolve URL; the CDN
  redirect target is not re-validated against the host allow-list. The code
  documents this: the trust anchor is content (pinned commit + digest), not
  transport, and no credentials are ever attached. This is acceptable because the
  first hop is HTTPS to a pinned, allow-listed origin (`huggingface.co`), which an
  off-path attacker cannot rewrite. It does, however, reinforce [LOW-1]: when
  `sha256` is absent, the redirect chain's only integrity check is the
  `X-Repo-Commit` header. Requiring `sha256` on gguf sources closes this.

### [INFO-3] Dev-toolchain dependency advisories remain (runtime deps clean)

`npm audit` reports 6 advisories, all transitive dev dependencies of
`vitest`/`vite-node`. They do not ship in the published package (runtime deps are
`cac`, `zod`, `systeminformation`, all clean) and are consistent with prior
audits. No action required for this slice; track the vitest upgrade separately.

---

## Positive Observations

- **Defence-in-depth SSRF guard.** The gguf source is validated by the catalog
  schema and **re-validated** in `assertValidRequest`, then the URL is
  path-segment-encoded and passed through `assertSafeFetchUrl` (HTTPS-only,
  host allow-list, no credentials, standard port, private/loopback refusal). No
  bypass of the allow-list or the revision/file constraints was found.
- **Genuinely fail-closed acquisition.** `acquireWeight` refuses symlinked cache
  entries, asserts the composed path and the realpath'd parent stay within the
  cache root, streams to a `0600` `wx` temp file, verifies commit + digest, and
  only then does an atomic same-directory rename — a partial or mismatched
  download is never promoted, and `digestVerified` is reported honestly.
- **No argv/shell injection surface.** `serve` uses `shell:false` with a discrete
  arg array, refuses a leading-dash `modelPath`, and sources `modelPath` solely
  from the verified cache path; `chat` JSON-encodes the model id and messages.
- **Loopback-only by construction.** `chat` is pinned to `127.0.0.1`, `serve`
  refuses a non-loopback bind without an explicit opt-in, and `up` never opts in.
- **Honest capability degradation.** `embed` fails closed (`canEmbed:false`) so
  memory capture uses the vector-less path rather than fabricating vectors.
- **Validated backend selector.** `--backend` is parsed through `parseBackendName`
  (zod enum against `BACKEND_NAMES`) with a `stripControl`-cleaned, length-bounded
  error echo.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                                                                                          | Recommendation                                                                                                                                   |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Low      | `up` serves self-managed weights without a digest/size gate ([up.ts:203](../../src/commands/up.ts#L203))         | Refuse (or loudly warn) when `pullResult.digestVerified` is false for self-managed backends, and/or make `sha256` required on `GgufSourceSchema` |
| 2   | Low      | `chat` hardcodes `127.0.0.1:8080` with no identity check ([llamacpp.ts:743](../../src/backend/llamacpp.ts#L743)) | Thread the real endpoint from state into `chat`; optionally reuse the `/props` identity check                                                    |
| 3   | Info     | Redirects not re-validated against the allow-list ([acquire.ts:95](../../src/backend/acquire.ts#L95))            | Acceptable given HTTPS + content verification; addressed by requiring `sha256` (item 1)                                                          |

---

## Note on Issue Tracking

Per the audit request, **no GitHub issues were created** for this slice — this is
a research/review-only pass. The two Low findings above should be tracked
manually if they are to be scheduled.
