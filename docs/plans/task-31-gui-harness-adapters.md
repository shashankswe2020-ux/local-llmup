# Implementation Plan: Browser GUI + Pluggable Chat Harness Adapters

> Source spec: [docs/specs/gui-and-harness-adapters.md](../specs/gui-and-harness-adapters.md)
> Related: [docs/specs/local-llmup.md](../specs/local-llmup.md),
> [docs/specs/pluggable-inference-backends.md](../specs/pluggable-inference-backends.md),
> [docs/specs/terminal-user-interface.md](../specs/terminal-user-interface.md)
> Status: Draft
> Last updated: 2026-08-26

## Overview

Deliver a loopback-only browser chat GUI and a pluggable chat harness system that lets local-llmup route a chat turn to either the active local backend or a supported cloud harness without duplicating business logic. The implementation keeps the existing CLI contract stable, preserves the memory capture path, and gates all external I/O behind validation and loopback-only security guards.

This plan is intentionally incremental:

1. Add the harness abstraction and registry.
2. Implement the local bridge plus the cloud harness adapters.
3. Add the browser GUI server and static UI over the same memory and chat flows.
4. Expose harness selection through the CLI and keep command compatibility.
5. Validate with unit and integration tests, then package the feature behind the project’s normal release checks.

## Architecture decisions

- Keep `BackendAdapter` as the local runtime lifecycle boundary; do not merge it into the chat harness interface.
- Add a new `src/harness/` module for provider-agnostic chat routing, distinct from `src/backend/`.
- Keep the browser GUI as a presenter only: it does not own ranking, hardware detection, or memory migration logic.
- Use native `fetch` for cloud providers to honor the project’s zero-new-runtime-dependency rule.
- Use SSE for streaming replies in the GUI; keep the CLI chat command behavior stable and non-streaming.
- Treat all incoming GUI requests and provider responses as untrusted and validate them with Zod before use.
- Use env vars only for API keys; never persist API credentials in config or state.

## Dependency graph

```text
G1 Harness interface + registry
  -> G2 LocalHarness
  -> G3 ClaudeHarness
  -> G4 OpenAiHarness
  -> G5 OpenAiCompatibleHarness
      -> G6 GUI server + session + static UI
          -> G7 llmup gui command
  -> G8 llmup chat --harness flag
```

Parallelizable work:
- G2, G3, G4, G5 can be implemented in parallel once G1 is complete.
- G8 can proceed after G1/G2 and the CLI boundary conventions are in place.
- G6 depends on G1 + G2 and should be implemented after the core harness contracts are stable.

## Task list

### Task G1 — Harness interface and registry foundation

Description:
- Add the `ChatHarness` interface, `HarnessChatRequest`, `HarnessName`, and registry contracts.
- Register the default built-ins: `local`, `claude`, `openai`, and `openai-compatible`.

Acceptance criteria:
- `HARNESS_NAMES` contains the four canonical names.
- `HarnessRegistry.get("unknown")` throws `ValidationError`.
- `HarnessRegistry.available()` filters out unavailable harnesses.
- `createDefaultRegistry()` returns all harnesses in deterministic registration order.

Files to create/modify:
- `src/harness/adapter.ts`
- `src/harness/registry.ts`
- `tests/harness/adapter.test.ts`
- `tests/harness/registry.test.ts`

Verification command:
- `npm test -- --run tests/harness/*.test.ts`
- `npm run typecheck`

---

### Task G2 — Local harness bridge

Description:
- Implement `LocalHarness`, which delegates chats to the active local backend via the existing `state.json` machinery.
- Keep the local path as the default and as the compatibility path for existing CLI behavior.

Acceptance criteria:
- `isAvailable()` returns false when no local server is active.
- `chatSync()` uses the active adapter instead of a direct HTTP call.
- `chat()` yields a single reply chunk as a synthetic stream when the backend is non-streaming.
- Memory store keying for local sessions still resolves through the catalog model id.

Files to create/modify:
- `src/harness/local.ts`
- `tests/harness/local.test.ts`

Verification command:
- `npm test -- --run tests/harness/local.test.ts`
- `npm run typecheck`

---

### Task G3 — Claude harness adapter

Description:
- Implement the Anthropic Messages API wrapper for text completions.
- Validate env keys, safe URL usage, request parsing, and SSE parsing.

Acceptance criteria:
- `ANTHROPIC_API_KEY` is required before use and missing keys fail closed.
- Calls validate the Anthropic URL via `assertSafeFetchUrl()`.
- SSE delta fragments are parsed and yielded in order.
- Response content is sanitized before storage/display.
- A 16 MiB response cap aborts long responses.

Files to create/modify:
- `src/harness/claude.ts`
- `tests/harness/claude.test.ts`

Verification command:
- `npm test -- --run tests/harness/claude.test.ts`
- `npm run typecheck`

---

### Task G4 — OpenAI harness adapter

Description:
- Implement the OpenAI chat-completions harness with streaming support and strict key validation.

Acceptance criteria:
- `OPENAI_API_KEY` is required before use.
- Streaming terminator `[DONE]` ends the response cleanly.
- Response payload parsing rejects malformed output.
- Keys are never exposed in errors or logs.

Files to create/modify:
- `src/harness/openai.ts`
- `tests/harness/openai.test.ts`

Verification command:
- `npm test -- --run tests/harness/openai.test.ts`
- `npm run typecheck`

---

### Task G5 — OpenAI-compatible harness adapter

Description:
- Implement a generic OpenAI-compatible provider harness using a runtime-configured base URL.
- Require the exact same fail-closed SSRF protections as other outbound network calls.

Acceptance criteria:
- `OPENAI_COMPAT_BASE_URL` is required before use.
- `assertSafeFetchUrl()` is called on the runtime URL value, not just a constant.
- Private or non-HTTPS endpoints are rejected.
- Optional `OPENAI_COMPAT_API_KEY` is only sent when configured.

Files to create/modify:
- `src/harness/openai-compatible.ts`
- `tests/harness/openai-compatible.test.ts`

Verification command:
- `npm test -- --run tests/harness/openai-compatible.test.ts`
- `npm run typecheck`

---

### Task G6 — GUI server and static UI

Description:
- Add the loopback-only HTTP server and the browser UI shell for chat.
- Implement SSE route handling, host validation, and safe static file serving.

Acceptance criteria:
- Server binds only to `127.0.0.1:<port>`.
- `Host` header mismatch returns HTTP 400.
- `GET /` returns the UI shell and static assets are served safely.
- Path traversal attempts like `/static/../outside.txt` are rejected.
- `POST /api/chat` accepts valid input and emits `delta`, `done`, and `error` SSE events.
- The `done` event reports capture metadata (`turnsAppended`, `factsExtracted`, `vectorsEmbedded`).
- The server shuts down cleanly on interrupt without leaving a port open.

Files to create/modify:
- `src/gui/server.ts`
- `src/gui/handlers.ts`
- `src/gui/static.ts`
- `src/gui/session.ts`
- `src/gui/static/index.html`
- `src/gui/static/chat.js`
- `src/gui/static/styles.css`
- `tests/gui/server.test.ts`
- `tests/gui/handlers.test.ts`
- `tests/gui/session.test.ts`

Verification command:
- `npm test -- --run tests/gui/*.test.ts`
- `npm run typecheck`

---

### Task G7 — `llmup gui` command and CLI entrypoint

Description:
- Add the command implementation and CLI registration for the browser GUI.
- Provide JSON output mode and graceful lifecycle handling for server startup and interrupt.

Acceptance criteria:
- `llmup gui --port 4000 --json` emits valid JSON with `url`, `harness`, and `port`.
- `--port` validation fails closed for invalid values.
- Port conflicts exit with a clear message.
- `--harness <name>` selects a valid harness and fails cleanly for unknown names.
- SIGINT/SIGTERM stops the process without leaving the GUI server alive.

Files to create/modify:
- `src/commands/gui.ts`
- `src/cli.ts`
- `tests/commands/gui.test.ts`

Verification command:
- `npm test -- --run tests/commands/gui.test.ts`
- `npm run typecheck`

---

### Task G8 — CLI `chat --harness` routing and compatibility

Description:
- Allow `llmup chat` to route through a registered harness when explicitly chosen.
- Preserve the current local-harness default path exactly when no harness is supplied.

Acceptance criteria:
- `llmup chat` without `--harness` behaves identically to current behavior.
- `--harness claude` calls the Claude harness and records memory under the harness-aware key.
- Missing API keys fail before the first turn is sent.
- Existing command tests remain byte-for-byte unchanged for default behavior.

Files to create/modify:
- `src/commands/chat.ts`
- `src/cli.ts`
- `tests/commands/chat.test.ts`

Verification command:
- `npm test -- --run tests/commands/chat.test.ts`
- `npm run typecheck`

---

## Checkpoints

### Checkpoint 1 — Harness foundation complete

Done when:
- G1 + G2 + G3 + G4 + G5 all pass their unit suites.
- `HarnessRegistry` represents the default provider set and fail-closed key gates.

Exit criteria:
- `npm test -- --run tests/harness/*.test.ts`
- `npm run typecheck`

### Checkpoint 2 — GUI server complete

Done when:
- G6 passes the GUI and route validation suite.
- SSE stream and host validation are proven with test fixtures.

Exit criteria:
- `npm test -- --run tests/gui/*.test.ts`
- `npm run typecheck`

### Checkpoint 3 — CLI integration complete

Done when:
- G7 + G8 pass and the default CLI behavior remains unchanged.
- The feature integrates with the existing memory capture flow and local backend flow.

Exit criteria:
- `npm test -- --run tests/commands/chat.test.ts tests/commands/gui.test.ts`
- `npm run typecheck`
- `npm test`

### Final release gate

Before claiming the feature is ready:
- run `npm test`
- run `npm run typecheck`
- run `npm run build`
- run `npm run lint`

## Files to deliver

Primary implementation:
- `src/harness/*.ts`
- `src/gui/*.ts`
- `src/commands/gui.ts`
- `src/cli.ts`

Primary tests:
- `tests/harness/*.test.ts`
- `tests/gui/*.test.ts`
- `tests/commands/gui.test.ts`
- `tests/commands/chat.test.ts`

Docs and follow-up:
- update [docs/specs/gui-and-harness-adapters.md](../specs/gui-and-harness-adapters.md) after implementation if requirements change
- optionally add a follow-up Tauri desktop spec if the app shell is approved separately

## Risk mitigations

### Risk: Cloud API key leaks
Mitigation:
- Use the env-only seam and never print raw key values.
- Require `ValidationError` before first network call when missing.

### Risk: SSRF through custom provider endpoints
Mitigation:
- Call `assertSafeFetchUrl()` on runtime-configured provider URLs.
- Reject private IPs, localhost loops, and non-HTTPS values where required.

### Risk: Prompt injection or unsafe rendered output
Mitigation:
- Sanitize all provider strings with `stripControl()` before display or storage.
- Keep the GUI’s renderer text-only and never inject raw HTML from model output.

### Risk: Port reuse or server collision
Mitigation:
- Validate `--port` before startup.
- Check whether the port is already in use before launching the GUI server.
- Fail with clear errors rather than silently switching ports.

### Risk: Memory store collisions between local and cloud sessions
Mitigation:
- Use the harness-aware key pattern for cloud sessions.
- Keep local session keys tied to catalog ids.

### Risk: Hidden CLI regressions during harness work
Mitigation:
- Preserve the default local branch exactly and run the full project test suite before release.

## Optional follow-up task: Tauri desktop wrap

This is intentionally not part of the core GUI/harness task. After the browser GUI is stable, a later task can add a native shell using Tauri for packaging and OS integration. That follow-up should be treated as a separate task because it adds a new runtime toolchain and release matrix beyond the original CLI and browser GUI scope.
