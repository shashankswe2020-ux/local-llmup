# Code Review Checkpoint 57: Spec — Browser GUI + Pluggable Chat Harness Adapters

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-10
> **Scope:** Spec review of `docs/specs/gui-and-harness-adapters.md` (v0.1) — architectural soundness and completeness before G-series implementation begins
> **Test suite:** N/A (spec-only review; no code implemented yet)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** The spec is well-structured and security-conscious. The threat model, harness abstraction rationale, and testing strategy are strong. However, three issues block safe implementation: the `LocalHarness` delegation chain is broken by design (it uses the wrong registry type), the `assertSafeFetchUrl` SSRF guard is incompatible with valid HTTP-based `OPENAI_COMPAT_BASE_URL` values, and the Anthropic SSE event nomenclature differs from the actual API contract. These must be resolved before G2, G3, and G5 are assigned to implementors.

---

## Critical Issues

### 1. `LocalHarness` uses the wrong registry — delegation chain is broken

- **Section:** §4.3 (`LocalHarness`)
- **Problem:** The spec states `LocalHarness` "delegates to `registry.get(active.backend).chat(...)`." But `registry` in the `ChatHarness` / `HarnessRegistry` context returns `ChatHarness` instances, not `BackendAdapter` instances. `active.backend` is a `BackendName` (e.g., `"ollama"`), which is not a `HarnessName`. Calling `HarnessRegistry.get("ollama")` throws `ValidationError("unknown harness")` — it will never resolve to an adapter. The `LocalHarness` must use the `BackendRegistry` (from `src/backend/registry.ts`), call `BackendRegistry.get(active.backend)` to obtain the `BackendAdapter`, then call `adapter.chat()`. The naming collision between `HarnessRegistry` and `BackendRegistry` is the root cause.
- **Fix:** Rewrite the `LocalHarness` description: "`LocalHarness` reads `state.json`, then uses `BackendRegistry.get(active.backend)` to obtain the active `BackendAdapter`, and calls `adapter.chat()` passing the full `ChatRequest` (including `endpoint`, `authToken`, `expectedProcess`, `expectedModelPath`). `HarnessRegistry` is never used inside `LocalHarness`." Also rename the variable holding the injected `BackendRegistry` to something like `backendRegistry` in the class signature to prevent confusion at the implementation site.

### 2. `assertSafeFetchUrl` incompatible with HTTP `OPENAI_COMPAT_BASE_URL`

- **Section:** §4.3 (`OpenAiCompatibleHarness`), §2, §7.1
- **Problem:** The spec says "`assertSafeFetchUrl()` called on the runtime value — SSRF guard is active." But the existing `assertSafeFetchUrl` (in `src/backend/net.ts`) hard-fails on anything that is not HTTPS, rejects non-standard ports, and checks against a static allowed-host list. `OPENAI_COMPAT_BASE_URL` is commonly an HTTP endpoint on a custom port (e.g., LM Studio's `http://127.0.0.1:1234`, a remote dev server at `http://192.168.1.100:8080`). Passing such URLs to the existing function throws `ValidationError("refusing non-HTTPS fetch URL")` — blocking every legitimate use of this harness. The spec presents `assertSafeFetchUrl` as if it is a single universal guard, but the existing implementation is tuned for public cloud (HTTPS-only, allow-listed hosts). The `openai-compatible` harness needs a different guard: SSRF-safe but permissive of HTTP and custom ports when the host is loopback or a user-supplied allowlist.
- **Fix:** Either (a) introduce an `assertSafeCompatEndpoint()` variant for this harness that allows HTTP on loopback/trusted hosts and custom ports but still rejects javascript:/file:/ schemes and private-to-public transitions, or (b) state explicitly that `OPENAI_COMPAT_BASE_URL` *must* be HTTPS, document why (and that LM Studio and similar HTTP-only local servers are out of scope), and mention this in the Non-goals section. Option (a) is the more useful user-facing choice.

### 3. Anthropic SSE event nomenclature diverges from the actual API

- **Section:** §4.3 (`ClaudeHarness`), §8.4 G3 acceptance criteria
- **Problem:** The spec says streaming uses "delta event type" and the G3 criterion says "SSE stream is correctly parsed; delta chunks are yielded in order." The Anthropic Messages streaming API emits `content_block_delta` events, each carrying a `delta` object of type `text_delta` with a `text` field. An implementor reading only this spec will build a parser that looks for `event: delta` lines and will parse no tokens at all against the real API. The spec must name the exact event types (`content_block_start`, `content_block_delta`, `message_delta`, `message_stop`) and the path to the text content (`delta.type === "text_delta" && delta.text`).
- **Fix:** Replace the vague "delta event type" language with the precise Anthropic SSE event taxonomy. Add a minimal example of the raw SSE wire format to the harness description or to the test strategy section so the acceptance criterion is unambiguous.

---

## Important Issues

### 4. `LocalHarness` drops the rich `ChatRequest` parameter set

- **Section:** §4.3 (`LocalHarness`), §4.1 (`HarnessChatRequest`)
- **Problem:** `HarnessChatRequest` only carries `{ model, messages, signal }`. The existing `BackendAdapter.chat()` (see `src/backend/adapter.ts`, `ChatRequest`) additionally requires `endpoint`, `authToken`, `expectedProcess`, and `expectedModelPath` — all derived from `state.json`. The spec does not explain how `LocalHarness` populates these fields. Without this, `LocalHarness.chatSync()` will silently pass `undefined` for `endpoint` (which some adapters accept via fallback, but MLX and llama.cpp require it explicitly). This is not just a `LocalHarness` implementation detail — it determines whether the harness works correctly for non-Ollama backends.
- **Fix:** Explicitly state in §4.3 that `LocalHarness` reads `state.json` to populate `endpoint`, `authToken`, `expectedProcess`, and `expectedModelPath` before constructing the `ChatRequest`, mirroring the logic in `src/commands/chat.ts` lines 150–192.

### 5. `POST /api/harness` and `GET /api/history` schemas are unspecified

- **Section:** §4.4 (HTTP API table)
- **Problem:** Both routes are listed with only a one-line description. `POST /api/harness` has no documented request body shape. `GET /api/history` has no documented query parameters (what is `N`? Is it a query param `?limit=20`?) or response envelope. Implementors writing to this spec will produce incompatible shapes.
- **Fix:** Add a subsection under §4.4 for each route specifying the full Zod-equivalent schema — e.g., `POST /api/harness` body: `{ harness: HarnessName }`, response: `{ harness: HarnessName }` on success; and `GET /api/history?limit=<n>` response: `{ turns: Array<{ role, content, timestamp? }> }`.

### 6. CORS policy is absent — partial CSRF gap

- **Section:** §7.1 (Threat model, CSRF row)
- **Problem:** The spec says "Same-origin SSE + Host header guard (no cookies, no tokens in v1)" mitigates CSRF. Host header validation blocks DNS rebinding, but it does not prevent a cross-origin attacker from sending a `POST /api/chat` with `Content-Type: text/plain` (a non-preflighted simple request). The browser's CORS preflight only fires for non-simple requests. If the server accepts `text/plain` or form-encoded bodies, a malicious page could still trigger state-changing requests. Without an explicit `Access-Control-Allow-Origin: null` or `Access-Control-Allow-Origin: http://127.0.0.1:<port>` response header, browsers may not restrict cross-origin reads of the response, but cross-origin writes can still fire.
- **Fix:** Add a CORS policy row to the threat model table and specify that the server must emit `Access-Control-Allow-Origin: http://127.0.0.1:<port>` (the exact loopback origin, not `*`) on all responses, and that `Content-Type: application/json` must be enforced for all `POST` endpoints (causing browsers to pre-flight cross-origin requests).

### 7. Memory key format for cloud harnesses conflicts with `migrate` command

- **Section:** §4.5 (Memory integration), §11 OQ3
- **Problem:** Cloud harnesses key the memory store on `"claude:claude-3-5-haiku-20241022"`. The existing `migrate` command (and memory store) are designed around local catalog model ids. OQ3 acknowledges this ("should `migrate` move cloud-harness memory?") and recommends "yes" but gives no implementation path. The `migrate` command's source/destination resolution will silently fail to find the cloud key unless it is updated. This is a cross-cutting change that will break `migrate` in a hard-to-diagnose way.
- **Fix:** Either (a) resolve OQ3 explicitly (document required `migrate` changes as a separate G-series task or deferred work item), or (b) mark cloud-harness memory as non-migratable in v1 and document that the `migrate` command will not enumerate cloud-keyed stores. Leave the format decision, but do not leave it as a silent gap.

### 8. Multi-tab behavior is undefined beyond "non-goal"

- **Section:** §4.4 (Session model), §1.3 Non-goals OQ4
- **Problem:** The spec says OQ4 multi-user/multi-tab is a non-goal, but the single `GuiSession` object means a second tab opening `/api/chat` will share the conversation window, potentially interleaving messages. The spec does not specify whether the server should (a) serve the second tab from the shared session (confusing), (b) return HTTP 409 when a chat is in progress, or (c) silently serve both. The behavior gap will produce surprising UX and untestable acceptance criteria.
- **Fix:** Add a short paragraph to §4.4 Session model: "In v1, the server maintains a single `GuiSession`. Concurrent POST /api/chat requests are serialized; if a chat is already streaming, a second request returns HTTP 409 (`{"error":"session busy"}`). This is consistent with the single-tab non-goal."

### 9. SSE connection teardown and `AbortSignal` propagation unspecified

- **Section:** §4.3 (`ChatHarness` interface), §4.4 (SSE streaming)
- **Problem:** `HarnessChatRequest.signal` carries an `AbortSignal`. For cloud harnesses (`ClaudeHarness`, `OpenAiHarness`), when the browser closes the SSE connection mid-stream, the Node HTTP server receives an `'close'` event. The spec does not specify that the server must listen for this event and abort the upstream cloud `fetch` via the signal. Without this, an abandoned tab will continue consuming cloud API tokens until the full response is received.
- **Fix:** Add a bullet to the SSE streaming section: "The server listens for `request.on('close')` and calls `controller.abort()` on the signal passed to the active harness, cancelling the upstream fetch."

---

## Suggestions

### 10. `createRegistry()` mentioned in G1 deliverables but never defined

- **Section:** §9 G1 deliverables
- **Problem:** "HarnessRegistry interface + `createRegistry()` + `createDefaultRegistry()`" — `createRegistry()` appears only in the G1 task list, never in §4.2 or the interface contract. It is unclear whether this is a factory for empty registries (for tests), an alias for `createDefaultRegistry()`, or an oversight.
- **Fix:** Either define `createRegistry()` in §4.2 (e.g., "`createRegistry(harnesses: readonly ChatHarness[]): HarnessRegistry` — wraps an ordered list for injection in tests") or remove it from the G1 deliverables.

### 11. `unavailableHint` as a static string is inflexible

- **Section:** §4.1 (`ChatHarness` interface)
- **Problem:** `readonly unavailableHint: string` forces implementors to choose a static string at construction time. `LocalHarness` might want to hint differently based on whether the state file is missing vs. no active model is set. A method `unavailableHint(): string` would be marginally more flexible at no architectural cost.
- **Fix:** Change to `unavailableHint(): string` or `readonly unavailableHint: string | (() => string)`. Not blocking, but worth considering now before the interface is locked.

### 12. No HTTP 404/405 handler specified

- **Section:** §4.4 (HTTP API table)
- **Problem:** The route table lists eight routes. Requests to unmatched paths or with wrong methods are not addressed. Without a default handler, implementors may let Node's default `undefined` response or an unhandled exception surface.
- **Fix:** Add a row to the table: "All other routes → HTTP 404 `{"error":"not found"}`; wrong method on known routes → HTTP 405."

### 13. Anthropic default model version will bit-rot

- **Section:** §4.3 (`ClaudeHarness`)
- **Problem:** `claude-3-5-haiku-20241022` is hardcoded as the default. Anthropic API model versioning is date-stamped; this default will become stale. The spec should note that this is a pinned default that must be updated in the catalog or via a `DEFAULT_CLAUDE_MODEL` constant (documented for easy update), not buried in prose.
- **Fix:** Add a note: "The default model string is defined as `DEFAULT_CLAUDE_MODEL = 'claude-3-5-haiku-20241022'` in `src/harness/claude.ts`. It must be updated when the preferred default changes."

### 14. `LOCAL_LLMUP_HARNESS` env var not in §12 Boundaries

- **Section:** §3.1, §12
- **Problem:** `LOCAL_LLMUP_HARNESS` is introduced in §3.1 as a harness resolution fallback but does not appear in the "Always / Ask first / Never" boundaries in §12. The env var has the same security surface as any env-sourced config and should be listed alongside `ANTHROPIC_API_KEY` etc.
- **Fix:** Add `LOCAL_LLMUP_HARNESS` to the "Always validate" list in §12: "Validate `LOCAL_LLMUP_HARNESS` against `HARNESS_NAMES` at startup; unknown values → `ValidationError`."

### 15. `resolveStaticPath` uses `root + path.sep` which is fragile

- **Section:** §7.3 (Static file security)
- **Problem:** The path containment check is `resolved.startsWith(root + path.sep)`. If `root` itself is the target (`resolved === root`), this check fails (a request for the root directory would be blocked, which is fine — but the semantics are unclear). Additionally, on case-insensitive filesystems (macOS HFS+), `startsWith` can be bypassed by mixed-case paths. `path.resolve()` normalizes separators but not case.
- **Fix:** Consider adding `path.resolve(root) === path.resolve(resolved)` as an allowed equality case (for serving `index.html` when path maps exactly to root), and note the case-sensitivity limitation. Alternatively, recommend using `realpath`-based resolution post-implementation.

---

## What's Done Well

- **Threat model is thorough.** §7.1 covers DNS rebinding, SSRF, path traversal, request body cap, prompt injection, and API cost runaway with concrete mitigations for each. The decision to validate every cloud API URL with `assertSafeFetchUrl` and `stripControl()` every response before storage is exactly right.
- **Zero new runtime deps is a genuine constraint enforced by design.** Using SSE instead of WebSockets, vanilla browser APIs, and Node built-ins for the server avoids the dependency explosion trap. The reasoning is explicit and defensible.
- **Injectable deps seam is consistent with existing `chat.ts` pattern.** The `FetchFn` / `EnvFn` injection (§6, §6.1) directly mirrors the `ChatDeps` interface in `src/commands/chat.ts`, making test patterns predictable.
- **Honesty gate applied to cloud harnesses.** Specifying `unknown` throughput for cloud models (§10) prevents the score engine from fabricating tok/s for non-local providers — a clean carry-through of the core domain principle.
- **Fail-closed key handling.** Missing env key → `ValidationError` before first turn (not a silent empty-string fallback) is the right posture.
- **Dependency graph in §9 is accurate and enables parallel implementation** of G2–G5, which is a meaningful throughput win.
- **Open Questions §11 are explicit and actionable.** Surfacing OQ1–OQ7 as named decisions (rather than silent assumptions) gives the spec reader a clear approval checklist.

---

## Verification Story

| Check              | Status | Notes                                                                                                                            |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Spec read in full  | ✅     | All 12 sections reviewed                                                                                                         |
| BackendAdapter reviewed | ✅ | `src/backend/adapter.ts` read in full — ChatRequest parameter set confirmed                                                    |
| `chat.ts` reviewed | ✅     | Existing delegation chain confirms `LocalHarness` must replicate endpoint/authToken/expectedProcess population from `state.json` |
| `assertSafeFetchUrl` reviewed | ✅ | `src/backend/net.ts` confirms HTTPS-only, allow-listed hosts — incompatible with HTTP openai-compatible endpoints          |
| `sanitize.ts` reviewed | ✅ | `stripControl()` covers ANSI, C0/C1, and BiDi — suitable for cloud response sanitization                                   |
| Prior checkpoints reviewed | ✅ | Checkpoint 29 — no open action items carry over                                                                           |
| Tests run          | N/A    | Spec-only review; no implementation exists yet                                                                                   |

---

## Action Items

| #   | Priority  | Issue                                                                             | Target                |
| --- | --------- | --------------------------------------------------------------------------------- | --------------------- |
| 1   | Critical  | Fix `LocalHarness` registry type — must use `BackendRegistry`, not `HarnessRegistry` | Before G2 assigned |
| 2   | Critical  | Resolve `assertSafeFetchUrl` HTTPS-only conflict for `OPENAI_COMPAT_BASE_URL`     | Before G5 assigned    |
| 3   | Critical  | Specify correct Anthropic SSE event taxonomy (`content_block_delta`, `text_delta`) | Before G3 assigned   |
| 4   | Important | Document how `LocalHarness` populates `ChatRequest` rich fields from `state.json` | Before G2 assigned    |
| 5   | Important | Specify `POST /api/harness` and `GET /api/history` request/response schemas       | Before G6 assigned    |
| 6   | Important | Add CORS policy to threat model and server spec                                   | Before G6 assigned    |
| 7   | Important | Resolve OQ3 — specify `migrate` impact or mark cloud memory non-migratable in v1 | Before G8 assigned    |
| 8   | Important | Specify multi-tab/concurrent-request behavior (HTTP 409 recommended)              | Before G6 assigned    |
| 9   | Important | Specify SSE connection teardown → `AbortSignal` propagation to upstream fetch     | Before G6 assigned    |
| 10  | Suggestion | Define or remove `createRegistry()` from G1 deliverables                         | Before G1 assigned    |
| 11  | Suggestion | Consider `unavailableHint()` as a method rather than static string               | Before G1 assigned    |
| 12  | Suggestion | Add HTTP 404/405 default handler to API route table                               | Before G6 assigned    |
| 13  | Suggestion | Extract `DEFAULT_CLAUDE_MODEL` constant with update note                          | Before G3 assigned    |
| 14  | Suggestion | Add `LOCAL_LLMUP_HARNESS` to §12 Boundaries validation list                      | Spec edit             |
| 15  | Suggestion | Note `resolveStaticPath` case-sensitivity limitation on macOS HFS+               | Before G6 assigned    |
