# Spec: Browser GUI for Chat + Pluggable Chat Harness Adapters

> Status: **Draft (v0.1)** — pending sub-agent review and human approval.
> Last updated: 2026-08-10
> Related: [local-llmup.md](./local-llmup.md),
> [pluggable-inference-backends.md](./pluggable-inference-backends.md),
> [terminal-user-interface.md](./terminal-user-interface.md)

---

## 0. Assumptions and decisions pending approval

The following are explicit assumptions. Any of these may change the scope of
implementation. They become decisions only when this specification is approved.

1. **"GUI"** means a **browser-based chat UI** served by a loopback HTTP server
   spawned by the CLI (`llmup gui`). It is not a desktop app (Electron/Tauri),
   not the TUI (T30 spec already covers that), and not a cloud dashboard.
2. **"Harness"** means a `ChatHarness` interface: a lightweight adapter that can
   route a chat turn (user prompt → assistant reply) to any LLM provider — local
   or cloud. It is distinct from `BackendAdapter`, which manages local inference
   server lifecycle. A harness only needs to implement `chat()`.
3. **"Claude harness"** means the **Anthropic Messages API** called via native
   `fetch` with an `ANTHROPIC_API_KEY` env var. No `@anthropic-ai/sdk` dependency
   in v1 — we call the HTTP API directly to stay within the zero-new-runtime-dep
   policy. The same applies to the OpenAI harness.
4. **Memory recording** (conversation turns, facts, embeddings) works identically
   regardless of harness. The memory store keyed on the harness-provided model id
   is the same store `migrate` already manages.
5. **Loopback-only.** The GUI HTTP server binds `127.0.0.1` by default; no
   `0.0.0.0` or public interface exposure. Same posture as all local servers in
   this project.
6. **No TLS, no authentication** in v1. This is a single-user local developer
   tool; the loopback boundary is the isolation mechanism.
7. **Runtime deps:** `src/gui/` HTML/CSS/JS is served as **static files** — no
   bundler, no framework. Only vanilla browser APIs. The Node server uses only
   Node built-ins (`http`, `fs`, `path`). No new runtime npm dependencies
   introduced by this spec without explicit approval.
8. **Streaming**: GUI chat uses **Server-Sent Events (SSE)** for streaming replies.
   The harness layer surfaces a streaming interface; non-streaming harnesses
   (e.g., a harness wrapping a non-stream-capable backend) emit a single
   synthetic event.
9. **Config / key storage**: API keys are never stored on disk. They are read
   from environment variables at harness instantiation time and never written
   to config files, state, or memory.
10. The `chat` CLI command and memory capture are **not changed** by this spec;
    the GUI and harness system are additive.

---

## 1. Objective

Enable two complementary ways to interact with local (and cloud) LLMs beyond the
existing `chat` CLI command:

### 1.1 Browser GUI for chat (`llmup gui`)

Provide a polished, loopback-served browser UI that lets users:

- chat with the active local model (or a configured harness) in a familiar
  conversational interface;
- see memory recording status (turns captured, facts extracted, embeddings
  indexed) after each exchange;
- switch between available harnesses without restarting;
- view session history for the current model from the memory store (read-only);
- copy the equivalent CLI command for any action.

The GUI is intentionally minimal: it is a **presenter** over the existing
command and memory layer, not a reimplementation of backend or ranking logic.

### 1.2 Pluggable chat harness adapters (`src/harness/`)

Provide a `ChatHarness` interface and a `HarnessRegistry` so that any LLM
provider — local or cloud — can serve as the routing target for a chat session,
both in the GUI and (optionally) via `llmup chat --harness <name>`.

Built-in harnesses in v1:
- **`local`** — bridges the active `BackendAdapter` (Ollama, llama.cpp, MLX,
  LM Studio); the default when a local server is running.
- **`claude`** — Anthropic Messages API (`claude-3-5-haiku-20241022` default);
  requires `ANTHROPIC_API_KEY`.
- **`openai`** — OpenAI Chat Completions API (`gpt-4o-mini` default); requires
  `OPENAI_API_KEY`.
- **`openai-compatible`** — any OpenAI-compatible endpoint; requires
  `OPENAI_COMPAT_BASE_URL` and optionally `OPENAI_COMPAT_API_KEY`.

### Target users

- Users who prefer a browser interface over the terminal for interactive chat.
- Developers who want to **compare** local model outputs vs. Claude or GPT-4o
  side-by-side using the same prompt and memory store.
- Teams running `local-llmup` as a shared dev machine with a browser UI.
- Anyone wanting to route chat sessions through cloud LLMs during a local model
  pull or when the local server is unavailable.

### Non-goals (v1)

- Mouse-required interaction beyond standard browser affordances.
- Persisting harness selection, theme, or filter preferences to disk.
- Multi-user authentication, session isolation, or remote (non-loopback) access.
- Side-by-side diff/comparison view (harnesses switched one at a time per session).
- Streaming in the CLI `chat` command (existing non-streaming contract preserved).
- TLS termination, WebSocket (SSE is used instead), or native desktop packaging.
- New model ranking, catalog browsing, or hardware scoring in the GUI.
- Calling cloud LLMs from `recommend`, `can-run`, `doctor`, or `catalog`.
- Storing API keys in config or state files.

---

## 2. Tech Stack and Constraints

Inherited from the project (no changes):

| Concern | Value |
|---|---|
| Language | TypeScript ~5.x, `strict: true`, no `any` |
| Runtime | Node.js ≥ 18, ESM, native `fetch` |
| Validation | Zod — all external input (HTTP request bodies, API responses, env vars) |
| Testing | Vitest — mock all network and FS; no real API calls in tests |
| Lint/format | ESLint (typescript-eslint) + Prettier |
| Runtime deps | **Zero new** in v1; Node built-ins only for server, vanilla JS for UI |

Additional rules for this spec:

- All strings received from cloud API responses pass `stripControl()` before
  display or storage.
- `assertSafeFetchUrl()` validates every cloud API endpoint before the first
  fetch (blocks SSRF, javascript:, file:, and private IP ranges).
- The GUI HTTP server refuses all requests except those to its own origin
  (`Host` header validation).
- Request bodies from the browser are validated with Zod before processing.
- No env var values are echoed in logs, responses, or error messages.

---

## 3. Command Surface

### 3.1 New: `llmup gui`

```
llmup gui [options]

Options:
  --port <n>       Port to bind on 127.0.0.1 (default: 4000)
  --harness <name> Start with this harness active (default: local)
  --no-open        Do not open the browser automatically
  --json           Print the server URL as JSON instead of opening a browser
  -h, --help
```

**Behavior:**

1. Validate `--port` is 1–65535.
2. Probe whether port is already in use; if so, exit 1 with a clear message.
3. Resolve the active harness: `--harness` flag → env `LOCAL_LLMUP_HARNESS` →
   `local` fallback. Validate harness name via `HarnessRegistry.get()`.
4. Start the HTTP server on `127.0.0.1:<port>`.
5. Unless `--no-open` or `--json`, open `http://127.0.0.1:<port>` in the
   default browser.
6. Print `local-llmup GUI listening at http://127.0.0.1:<port>` to stdout.
7. Block until SIGINT/SIGTERM; print `Stopped.` and exit 0 on shutdown.

**`--json` output shape:**

```json
{
  "url": "http://127.0.0.1:4000",
  "harness": "local",
  "port": 4000
}
```

**Exit codes:**

| Code | Condition |
|---|---|
| 0 | Server started and stopped cleanly |
| 1 | Port in use, harness not found, validation error |

### 3.2 Modified: `llmup chat` — new `--harness` flag

```
llmup chat [--model <model>] [--harness <name>]
```

- When `--harness` is omitted: existing behavior unchanged (routes via local
  `BackendAdapter`).
- When `--harness <name>`: resolves harness via `HarnessRegistry`, calls
  `harness.chat()` instead of the backend adapter. Memory recording is identical.
- `--harness local` is equivalent to the current default.
- `--harness claude` requires `ANTHROPIC_API_KEY`; missing key → `ValidationError`
  with message `ANTHROPIC_API_KEY is not set`.
- Model resolution: harness-provided harnesses accept a free-form model string
  (not validated against the local catalog); only the `local` harness resolves
  via `resolveModel()`.

---

## 4. Architecture

### 4.1 `ChatHarness` interface (`src/harness/adapter.ts`)

```typescript
/** The chat harness interface. A harness routes one chat turn to an LLM. */
export interface ChatHarness {
  /** Stable wire name — stored in memory meta when different from "local". */
  readonly name: HarnessName;

  /**
   * Returns true if the harness can serve requests right now.
   * For `local`, checks readState.active !== null.
   * For cloud harnesses, checks env var is non-empty.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Human-readable hint when isAvailable() is false.
   * e.g. "Set ANTHROPIC_API_KEY to use the Claude harness."
   */
  readonly unavailableHint: string;

  /**
   * Send one turn. Returns an AsyncIterable of text delta chunks so the GUI
   * can stream. Non-streaming harnesses yield a single chunk.
   */
  chat(request: HarnessChatRequest): AsyncIterable<string>;

  /**
   * Drain the full reply as a single string (used by the CLI chat path).
   */
  chatSync(request: HarnessChatRequest): Promise<string>;
}

export interface HarnessChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
}
```

`HarnessName` is a string literal union:
```typescript
export const HARNESS_NAMES = ["local", "claude", "openai", "openai-compatible"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
```

### 4.2 `HarnessRegistry` (`src/harness/registry.ts`)

- `all(): readonly ChatHarness[]` — registration order.
- `get(name: string): ChatHarness` — throws `ValidationError` on unknown name.
- `available(): Promise<readonly ChatHarness[]>` — filters by `isAvailable()`.
- `createDefaultRegistry(deps?): HarnessRegistry` — returns all four built-in
  harnesses in registration order: `local`, `claude`, `openai`,
  `openai-compatible`.

### 4.3 Built-in harness implementations (`src/harness/`)

| File | Harness | API |
|---|---|---|
| `local.ts` | `LocalHarness` | Delegates to active `BackendAdapter` via `state.json` |
| `claude.ts` | `ClaudeHarness` | `POST https://api.anthropic.com/v1/messages` |
| `openai.ts` | `OpenAiHarness` | `POST https://api.openai.com/v1/chat/completions` |
| `openai-compatible.ts` | `OpenAiCompatibleHarness` | Configurable base URL |

**`ClaudeHarness` (`src/harness/claude.ts`)**

- Reads `ANTHROPIC_API_KEY` from env at call time (not construction time) so
  tests can inject via the deps seam.
- Uses native `fetch` with `x-api-key: <key>` header (never logged).
- Default model: `claude-3-5-haiku-20241022` (overridable in `HarnessChatRequest`).
- Request body validated with Zod before send; response validated before yield.
- Streaming via `anthropic-version: 2023-06-01` + `stream: true` SSE parsing.
- `assertSafeFetchUrl("https://api.anthropic.com/v1/messages")` called at module
  init — this is a static constant so it always passes, but the call forces the
  security gate to be exercised in tests.
- Injectable: `FetchFn` seam for tests; never hits the real API in tests.
- Response body byte cap: 16 MiB abort (consistent with existing acquire module).

**`OpenAiHarness` (`src/harness/openai.ts`)**

- Reads `OPENAI_API_KEY` from env at call time.
- Default model: `gpt-4o-mini`.
- OpenAI streaming SSE (`data: {...}` lines, `data: [DONE]` terminator).
- Same security constraints as Claude harness.

**`OpenAiCompatibleHarness` (`src/harness/openai-compatible.ts`)**

- Reads `OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY` from env.
- `assertSafeFetchUrl()` called on the runtime value — SSRF guard is active.
- Model must be supplied in every request (no default — the correct model is
  unknown without the endpoint).

**`LocalHarness` (`src/harness/local.ts`)**

- Reads `state.json` via `readState(config)`.
- Active null → `isAvailable()` returns false.
- Delegates to `registry.get(active.backend).chat(...)` — uses the
  `BackendAdapter` chain, not a direct HTTP call.
- `chatSync()` calls `adapter.chat()` (already non-streaming in the adapter contract).
- `chat()` async iterator: yields the full reply as a single string chunk.

### 4.4 GUI server (`src/gui/`)

```
src/gui/
  server.ts        — Node HTTP server, route dispatcher, SSE endpoint
  handlers.ts      — per-route request handlers (validated with Zod)
  static.ts        — safe static file serving from src/gui/static/
  session.ts       — in-memory per-tab session state (ephemeral, loopback-only)
  static/
    index.html     — single-page chat UI shell
    chat.js        — streaming SSE client, DOM update, harness selector
    styles.css     — minimal, accessible styling
```

**HTTP API (loopback only):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Serve `index.html` |
| `GET` | `/static/*` | Serve static assets |
| `GET` | `/api/status` | Active harness, model, memory stats (JSON) |
| `GET` | `/api/harnesses` | Available harness list (JSON) |
| `POST` | `/api/chat` | Send one turn (SSE response) |
| `POST` | `/api/harness` | Switch active harness for this session |
| `GET` | `/api/history` | Last N turns from memory store (JSON, read-only) |

**Request validation (`src/gui/handlers.ts`):**

All incoming JSON request bodies are parsed with `z.unknown()` then validated
with a typed Zod schema before any domain call. Unknown fields are stripped
(`z.object(...).strict()` is used where the shape is fully known).

**Session model (`src/gui/session.ts`):**

- One in-memory `GuiSession` object per Node process (single-tab v1).
- Contains: `activeHarnessName`, `conversationWindow` (last 20 messages, same
  cap as CLI `chat`), `modelId` (for memory store keying).
- Not persisted — cleared on server restart.
- Exported type: `GuiSession`.

**SSE streaming (`POST /api/chat`):**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Event format:
```
data: {"type":"delta","content":"Hello"}

data: {"type":"delta","content":" world"}

data: {"type":"done","turnsAppended":1,"factsExtracted":0,"vectorsEmbedded":0}

data: {"type":"error","message":"Harness unavailable"}
```

All `content` strings are `stripControl()`-sanitized before inclusion in the
SSE data. The `done` event includes the capture result so the UI can show
memory recording status.

**Host header validation:**

Every request handler checks `Host === "127.0.0.1:<port>"` (exact match). Any
other `Host` value receives a 400 response immediately. This prevents DNS
rebinding attacks.

### 4.5 Memory integration

Memory recording in the GUI follows the same path as the CLI `chat` command:

1. On `done` event: `captureExchange(config, store, {user, assistant}, {now, embedder?})`.
2. `withLock(config, ...)` wraps each capture, same as CLI.
3. Memory errors are surfaced in the `done` event `error` field without
   interrupting the conversation (consistent with CLI chat: capture failures
   log to stderr and continue).
4. The memory store is keyed on `modelId` from the active harness:
   - `local` harness: uses `resolveModel()` to get catalog `model.id`.
   - Cloud harnesses: keyed on `harness.name + ":" + model` (e.g.,
     `"claude:claude-3-5-haiku-20241022"`). This ensures cloud harness memory
     never collides with a local model store.

---

## 5. Project Structure

```
src/
  harness/
    adapter.ts           — ChatHarness interface, HarnessName, HarnessChatRequest
    registry.ts          — HarnessRegistry, createDefaultRegistry()
    local.ts             — LocalHarness
    claude.ts            — ClaudeHarness
    openai.ts            — OpenAiHarness
    openai-compatible.ts — OpenAiCompatibleHarness
  gui/
    server.ts            — GuiServer class, start(), stop()
    handlers.ts          — route handlers, Zod-validated
    static.ts            — safe static file server
    session.ts           — GuiSession type and helpers
    static/
      index.html
      chat.js
      styles.css
  commands/
    gui.ts               — runGui() command implementation
  cli.ts                 — (modified) register `gui` subcommand

tests/
  harness/
    adapter.test.ts      — HarnessName enum, interface shape
    registry.test.ts     — HarnessRegistry CRUD, available()
    local.test.ts        — LocalHarness routing, unavailable when no active server
    claude.test.ts       — ClaudeHarness (mock fetch), SSE parsing, key guard
    openai.test.ts       — OpenAiHarness (mock fetch), streaming, key guard
    openai-compatible.test.ts — URL validation, SSRF guard
  gui/
    server.test.ts       — HTTP routing, Host header guard, port conflict
    handlers.test.ts     — per-route Zod validation, happy path, error shapes
    session.test.ts      — session creation, window cap, harness switch
  commands/
    gui.test.ts          — runGui happy path, port error, harness resolution
```

---

## 6. Code Conventions

All conventions inherited from the project. Additional rules for new modules:

- **Named exports only** — no default exports in `src/harness/` or `src/gui/`.
- **Explicit return types** on all exported functions.
- **No `any`** — `z.unknown()` at API boundaries, typed immediately after parse.
- **Kebab-case files**, `PascalCase` types, `camelCase` functions,
  `SCREAMING_SNAKE_CASE` constants.
- Cloud harness deps are **constructor-injectable** (`FetchFn`, `EnvFn`) so tests
  never hit real APIs.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPAT_API_KEY` — never echoed
  in logs, errors, or returned in API responses.
- GUI static files (HTML/CSS/JS) must pass `npm run lint` (ESLint handles
  `.js` in `src/gui/static/`) and must not `import` Node modules (browser-only).

### 6.1 Example: harness-injected test pattern

```typescript
// tests/harness/claude.test.ts
const fakeFetch: FetchFn = async () => new Response(
  new ReadableStream({ start(c) { c.enqueue(enc("data: {...}\n\n")); c.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream" } }
);
const harness = new ClaudeHarness({ fetch: fakeFetch, getEnv: () => "sk-fake-key" });
```

---

## 7. Security Design

### 7.1 Threat model

The GUI adds an HTTP server surface to a previously command-only tool. The
mitigations below address the additional attack surface.

| Threat | Mitigation |
|---|---|
| DNS rebinding (external page → localhost API) | Host header exact-match validation on every request |
| SSRF via user-supplied `OPENAI_COMPAT_BASE_URL` | `assertSafeFetchUrl()` on the runtime value |
| API key leakage in error messages | Keys never interpolated in error strings or response bodies |
| Prompt injection via API response content | `stripControl()` before storage and before SSE emission |
| Path traversal via static file requests | Whitelist-only static paths; `path.resolve()` + `isWithin()` containment check |
| Oversized request body | 64 KiB request body cap on all `POST` endpoints |
| Replay / cross-site request forgery | Same-origin SSE + Host header guard (no cookies, no tokens in v1) |
| Cloud model API cost runaway | No automatic retry on cloud harnesses; abort on signal; per-request response cap |

### 7.2 Key handling

- Keys are read via an injectable `getEnv(key: string): string | undefined` dep.
- The default implementation is `(k) => process.env[k]`.
- Tests inject a fake that returns a predictable value without touching
  `process.env`.
- Keys are never written to `config.json`, `state.json`, or any memory file.
- Keys are never included in `--json` output, `GET /api/status`, or SSE events.

### 7.3 Static file security

```typescript
function resolveStaticPath(root: string, request: string): string {
  const rel = request.replace(/^\/static\//, "");
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep)) {
    throw new ValidationError(`path traversal refused: ${rel}`);
  }
  // Whitelist: only serve known extensions
  const ext = path.extname(resolved);
  if (![".html", ".css", ".js", ".map"].includes(ext)) {
    throw new ValidationError(`unknown extension: ${ext}`);
  }
  return resolved;
}
```

---

## 8. Testing Strategy

### 8.1 Principles

- TDD: write the failing test first, then implement (Prove-It pattern).
- Mock ALL: `fetch`, filesystem, `readState`, `captureExchange`, `openMemoryStore`,
  `process.env` via `getEnv` seam.
- Never hit a real cloud API in tests.
- Never start a real HTTP server on a real port unless explicitly testing port
  conflict (use `net.createServer` mock).

### 8.2 Test levels

| Level | What is covered |
|---|---|
| Unit (harness) | Interface contract, SSE parsing, Zod validation, key guard, SSRF |
| Unit (GUI handlers) | Route validation, error shapes, Host guard, body cap |
| Unit (GUI session) | Window cap, harness switch, model id keying |
| Integration (chat --harness) | CLI flag → harness selection → memory capture |
| Integration (gui command) | Server start → /api/status → /api/chat SSE roundtrip |

### 8.3 Coverage expectations

- `src/harness/**` ≥ 85 % line coverage.
- `src/gui/**` ≥ 80 % line coverage.
- `src/commands/gui.ts` ≥ 80 % line coverage.

### 8.4 Acceptance criteria (must all pass for each task to be "done")

**G1 — Harness interface and registry:**
- [ ] `HARNESS_NAMES` includes `"local"`, `"claude"`, `"openai"`, `"openai-compatible"`.
- [ ] `HarnessRegistry.get("unknown")` throws `ValidationError`.
- [ ] `HarnessRegistry.available()` excludes harnesses where `isAvailable()` is false.
- [ ] `createDefaultRegistry()` returns all four harnesses in registration order.

**G2 — `LocalHarness`:**
- [ ] `isAvailable()` returns false when `readState.active === null`.
- [ ] `chatSync()` delegates to the active backend adapter.
- [ ] `chat()` async iterator yields the full reply as one chunk.
- [ ] Memory store keying uses `resolveModel()` catalog id.

**G3 — `ClaudeHarness`:**
- [ ] `isAvailable()` returns false when `ANTHROPIC_API_KEY` is not set.
- [ ] `chatSync()` calls `assertSafeFetchUrl` then posts to the Anthropic endpoint.
- [ ] API key is not present in any thrown error message.
- [ ] SSE stream is correctly parsed; delta chunks are yielded in order.
- [ ] Response body is `stripControl()`-sanitized before yield.
- [ ] 16 MiB response cap aborts the stream.

**G4 — `OpenAiHarness`:**
- [ ] `isAvailable()` returns false when `OPENAI_API_KEY` is not set.
- [ ] OpenAI SSE `[DONE]` terminator ends the stream cleanly.
- [ ] Same key/sanitize/cap tests as G3.

**G5 — `OpenAiCompatibleHarness`:**
- [ ] `isAvailable()` returns false when `OPENAI_COMPAT_BASE_URL` is not set.
- [ ] `assertSafeFetchUrl()` is called on the runtime URL value.
- [ ] Private IP in `OPENAI_COMPAT_BASE_URL` (e.g., `http://192.168.1.1`) throws `ValidationError`.

**G6 — GUI server:**
- [ ] Server binds `127.0.0.1:<port>` and not `0.0.0.0`.
- [ ] `Host` header mismatch returns HTTP 400.
- [ ] `GET /` returns `index.html` content.
- [ ] `GET /static/../outside.txt` returns HTTP 400 (path traversal blocked).
- [ ] `POST /api/chat` body > 64 KiB returns HTTP 413.
- [ ] `POST /api/chat` with valid body opens an SSE stream.
- [ ] SSE `done` event includes `turnsAppended`, `factsExtracted`, `vectorsEmbedded`.
- [ ] Server stops cleanly on SIGINT without leaving the port open.

**G7 — `llmup gui` command:**
- [ ] `--port` out of range → exit 1 with error message.
- [ ] Port already in use → exit 1 with "port XXXX is already in use".
- [ ] `--harness unknown` → exit 1 with "unknown harness".
- [ ] `--json` prints `{"url":..., "harness":..., "port":...}` then blocks.
- [ ] SIGINT exits 0 cleanly.

**G8 — `llmup chat --harness claude`:**
- [ ] Routes chat turn to `ClaudeHarness.chatSync()` instead of `adapter.chat()`.
- [ ] Memory store is keyed on `"claude:<model>"`, not a local catalog id.
- [ ] Missing `ANTHROPIC_API_KEY` → `ValidationError` before first turn.
- [ ] Existing `--harness`-less chat tests remain byte-for-byte identical.

---

## 9. Implementation Plan (G-series tasks)

### Dependency graph

```
G1 harness interface + registry
  → G2 LocalHarness
  → G3 ClaudeHarness
  → G4 OpenAiHarness
  → G5 OpenAiCompatibleHarness
     → G6 GUI server (static + SSE + session)
        → G7 llmup gui command
  → G8 llmup chat --harness flag
```

G2–G5 are independent of each other (parallel-implementable).
G6 depends on G1+G2 (at minimum); G3–G5 are wired into G6 afterward.
G8 depends on G1+G2 and is independent of G6–G7.

### G1 — Harness interface and registry (Foundation)

**New files:** `src/harness/adapter.ts`, `src/harness/registry.ts`
**Tests:** `tests/harness/adapter.test.ts`, `tests/harness/registry.test.ts`

Deliverables:
- `HARNESS_NAMES`, `HarnessName`, `HarnessChatRequest`, `ChatHarness` interface.
- `HarnessRegistry` interface + `createRegistry()` + `createDefaultRegistry()`.
- All four built-in harnesses registered (stubs acceptable at this point).

### G2 — `LocalHarness` (local bridge)

**New file:** `src/harness/local.ts`
**Tests:** `tests/harness/local.test.ts`

Deliverables:
- `LocalHarness` bridges `BackendAdapter.chat()` via `readState`.
- `isAvailable()` checks `readState.active !== null`.
- `chat()` yields single chunk; `chatSync()` awaits `adapter.chat()`.

### G3 — `ClaudeHarness` (Anthropic API)

**New file:** `src/harness/claude.ts`
**Tests:** `tests/harness/claude.test.ts`

Deliverables:
- Native `fetch` call to `https://api.anthropic.com/v1/messages`.
- SSE stream parsing with `delta` event type.
- `getEnv` dep seam; key never in errors.
- Response cap, `stripControl`, Zod validation of response shape.

### G4 — `OpenAiHarness` (OpenAI API)

**New file:** `src/harness/openai.ts`
**Tests:** `tests/harness/openai.test.ts`

Deliverables:
- Native `fetch` to `https://api.openai.com/v1/chat/completions`.
- OpenAI SSE `[DONE]` terminator handling.
- Same security constraints as G3.

### G5 — `OpenAiCompatibleHarness`

**New file:** `src/harness/openai-compatible.ts`
**Tests:** `tests/harness/openai-compatible.test.ts`

Deliverables:
- Configurable `OPENAI_COMPAT_BASE_URL` + optional key.
- SSRF guard on the runtime URL value.

### G6 — GUI HTTP server

**New directory:** `src/gui/`
**Tests:** `tests/gui/`

Deliverables:
- `GuiServer` class: `start(port)`, `stop()`, route dispatcher.
- All HTTP routes specified in §4.4.
- Host header guard (DNS rebinding defense).
- SSE streaming with `delta` / `done` / `error` events.
- Path-safe static file server from `src/gui/static/`.
- `src/gui/static/` with functional chat UI (input, message list, harness
  selector, memory stats, copy-to-clipboard, keyboard shortcut to send).

### G7 — `llmup gui` command

**New file:** `src/commands/gui.ts`
**Modified:** `src/cli.ts`
**Tests:** `tests/commands/gui.test.ts`

Deliverables:
- `runGui(options, deps)` with injectable deps.
- `--port`, `--harness`, `--no-open`, `--json` flags.
- Port conflict detection via `net.createServer` probe.
- Auto-open via `open` (or `child_process.exec(xdg-open/open/start)` — no new
  dep; use platform-native commands).
- Graceful SIGINT handler.

### G8 — `llmup chat --harness` flag

**Modified:** `src/commands/chat.ts`, `src/cli.ts`
**Tests:** `tests/commands/chat.test.ts` (extend existing suite)

Deliverables:
- `ChatOptions.harness?: HarnessName`.
- When harness is `"local"` or undefined: existing code path unchanged.
- When harness is a cloud harness: `harness.chatSync()` replaces `adapter.chat()`.
- Memory store key: `harness.name + ":" + model` for non-local harnesses.
- `parseHarnessName()` at CLI boundary (analogous to `parseBackendName()`).

---

## 10. Domain Principles (non-negotiable carry-through)

| Principle | How it applies here |
|---|---|
| **Honesty gate** | Cloud harness model names are free-form; no tok/s estimate is invented for cloud models. GUI status shows `unknown` throughput for cloud harnesses. |
| **Determinism** | `recommend`, `can-run`, and `catalog` are not affected by harnesses. Advice remains offline. |
| **Fail-closed integrity** | Missing env key → `ValidationError` before first network call. No silent fallback to a different provider. |
| **Loopback-only** | GUI server binds `127.0.0.1`; no opt-in flag for non-loopback in v1. |
| **No secrets in code** | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPAT_API_KEY` are only ever read from `process.env` via the injectable `getEnv` dep. |

---

## 11. Open Questions (resolve before implementation)

| # | Question | Recommended default |
|---|---|---|
| OQ1 | Should `OPENAI_COMPAT_API_KEY` allow empty string (unauthenticated endpoints)? | Yes — empty string means no `Authorization` header. |
| OQ2 | Should `llmup gui` respect the same `LOCAL_LLMUP_BACKEND` env var, or use a separate `LOCAL_LLMUP_HARNESS`? | Separate: `LOCAL_LLMUP_HARNESS` maps to `HarnessName`; `LOCAL_LLMUP_BACKEND` maps to `BackendName`. |
| OQ3 | Memory for cloud harnesses: should `migrate` be able to move cloud-harness memory to a local model? | Yes — memory is harness-agnostic. Migration source = `"claude:claude-3-5-haiku-20241022"` → `"ollama:llama3.1:8b"`. |
| OQ4 | Should the GUI support multiple simultaneous sessions (tabs)? | No in v1. Documented non-goal. |
| OQ5 | Should `llmup gui` require an active local server, or work with cloud-only harnesses even when no local server is running? | Work with any available harness. `--harness claude` with no local server is valid. |
| OQ6 | Default port conflict: if 4000 is busy, should GUI auto-increment to 4001? | No — report the conflict and let the user supply `--port`. Fail-closed. |
| OQ7 | Should API keys be settable via `llmup gui` config file (separate from `state.json`)? | No in v1. Env-only. Revisit in a separate secrets spec. |

---

## 12. Boundaries

**Always:**
- Validate all external input (HTTP request bodies, cloud API responses, env vars) with Zod.
- Call `assertSafeFetchUrl()` on every cloud API endpoint before the first fetch.
- Call `stripControl()` on every string received from a cloud API before storing or displaying.
- Bind the GUI server to `127.0.0.1` only.
- Validate the `Host` header on every GUI HTTP request.
- Run `npm test` before considering any task done.

**Ask first:**
- Adding a new built-in harness (e.g., Gemini, Mistral API).
- Changing the memory store key format for cloud harnesses.
- Any new runtime npm dependency.
- Exposing the GUI server to non-loopback addresses.
- Persisting API keys in any form.

**Never:**
- Echo API key values in error messages, logs, or HTTP responses.
- Call cloud APIs from advice commands (`recommend`, `can-run`, `catalog`, `doctor`).
- Invent throughput or cost estimates for cloud harnesses.
- Store API keys in `state.json`, `config.json`, or memory files.
- Allow path traversal in the static file server.
- Disable the Host header validation.
