# Code Review Checkpoint 7: Task 24 (`chat` command)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T24 — the `chat` command (`src/commands/chat.ts`, `registerChat` in `src/cli.ts`, `tests/commands/chat.test.ts`). Forwards each user turn to the active backend, writes the reply, accumulates in-session context, and records each exchange via `captureExchange` (T23). Deps T12 (state+lock), T14 (resolver), T23 (capture). Spec §3.5.
> **Test suite:** 368 tests passing (29 files), typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE (with follow-ups)

**Overview:** `runChat` is a clean, well-factored recorder that meets the T24 acceptance — it forwards each turn, writes the reply, accumulates context, and the test asserts the *exact* capture payload (`config`, `store`, `{user, assistant}`, `{now}`), not just call count. The security boundary is right: every backend-sourced string (`modelId`, `endpoint`, `reply`) is `stripControl`'d before it reaches the terminal, while capture receives the raw text — and both behaviours are tested. No blocking defects. Four robustness/consistency follow-ups are worth landing before this hardens: capture is invoked *without* the runtime lock its own docstring requires, the default deps never wire an embedder (so live `chat` produces no vectors), a capture failure tears down the whole session, and the in-session `messages` array grows unbounded into context overflow.

---

## Critical Issues

None.

---

## Important Issues

### 1. `captureExchange` is called without the runtime lock its own contract requires
- **File:** `src/commands/chat.ts:167` (call site); contract in `src/memory/capture.ts` (`captureExchange` docstring: *"Intended to be called by the `chat` command while holding the runtime lock, which serializes writes to the store."*)
- **Problem:** `runChat` is a reader/recorder and deliberately skips `withLock` (unlike `up`/`down`/`switch`). But `captureExchange` does a read-modify-**rewrite** of `facts.json` (`loadFacts` → merge → `atomicWriteJson`). Two concurrent `chat` sessions on the same model both read the old facts, both add their own, and both `rename` — last-writer-wins, silently dropping one session's newly-extracted facts (a lost-update race). The same window lets a future `migrate` (T25/T26), which *does* hold the lock, snapshot/relocate the store while an unlocked `chat` is mid-append, losing the in-flight exchange. `renameSync`/`O_APPEND` keep individual files from *corrupting*, so this is data-loss-under-contention, not brick-the-store — hence Important, not Critical. The concrete defect is that the code and the capture docstring disagree about who holds the lock.
- **Fix:** Do **not** hold `withLock` for the whole (potentially hours-long) session — that would block `up`/`down`/`switch` for the session's lifetime. Instead take the lock *per exchange*, around only the capture call, so each record serializes against mutating commands while keeping the session responsive:
  ```ts
  await deps.withLock(deps.config, () =>
    deps.captureExchange(deps.config, store, { user: turn, assistant: reply }, captureOptions),
  );
  ```
  (Add `withLock` to `ChatDeps` + `createDefaultDeps`, mirroring `up.ts`/`down.ts`.) If per-exchange locking is intentionally deferred, then update the `captureExchange` docstring to drop the lock claim and record the accepted single-writer-per-model assumption, so the contract matches reality.

### 2. Default deps supply no `embedder`, so live `chat` never produces embeddings
- **File:** `src/commands/chat.ts:99` (`createDefaultDeps` omits `embedder`); contract in `src/memory/capture.ts` (`CaptureEmbedder` docstring: *"The `chat` command wires this to the backend adapter's `embed` with a fixed embedding model."*)
- **Problem:** `captureOptions` only forwards an `embedder` when `deps.embedder !== undefined`, and `createDefaultDeps` never sets one. So in real use `captureExchange` always takes the no-embedder path: `conversation.jsonl` and `facts.json` are written, but `embeddings/` is never populated. The whole embedding/similarity apparatus in T23 (`prepareEmbedding`, `writeEmbedding`, the pinned `meta.embedding`) is dead on the live path, directly contradicting the `CaptureEmbedder` contract that says `chat` wires it. Any within-model RAG/similarity read stays empty until some later `migrate` re-embeds. The tests can't catch this because they inject deps and never exercise `createDefaultDeps`.
- **Fix:** Either wire the embedder in `createDefaultDeps` (adapter `embed` behind a `CaptureEmbedder` with a fixed embedding-model id), e.g.
  ```ts
  embedder: {
    model: EMBEDDING_MODEL_ID,
    embed: (inputs) =>
      new OllamaAdapter().embed({ model: EMBEDDING_MODEL_ID, input: inputs }),
  },
  ```
  or, if live embedding is intentionally deferred to `migrate`, update the `CaptureEmbedder` docstring to say so and drop the "the `chat` command wires this" claim so the documented contract matches the shipped behaviour.

### 3. A capture failure tears down the entire chat session mid-loop
- **File:** `src/commands/chat.ts:167`
- **Problem:** `await deps.captureExchange(...)` has no surrounding `try/catch`, so any throw (embedder/network outage, `ENOSPC`, a `MemoryError` from a corrupt `facts.json`) propagates out of the `for (;;)` loop and ends the session — after the reply has already been printed and the model has already responded. A failure in the *auxiliary* memory subsystem thus kills an otherwise-healthy *primary* conversation and discards every subsequent turn. Because capture runs its fallible embed before any disk write, the failing turn persists nothing (good), but the user still loses the whole session to a background-recording error.
- **Fix:** Treat capture as best-effort: catch, warn to stderr (sanitized), and continue the loop so the conversation survives a memory hiccup:
  ```ts
  try {
    await deps.captureExchange(deps.config, store, { user: turn, assistant: reply }, captureOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`warning: failed to record exchange: ${stripControl(message)}\n`);
  }
  ```
  Add a test asserting a rejecting `captureExchange` logs and the session proceeds to the next turn.

### 4. Unbounded in-session `messages` growth overflows the context window
- **File:** `src/commands/chat.ts:150,161,164`
- **Problem:** `messages` accumulates every user + assistant turn for the life of the session and the *entire* array is sent to the backend on each turn (`messages: [...messages]`). A long session monotonically grows the prompt until it exceeds the model's `contextLength` (8192 in the test catalog), at which point the backend returns a 400 / silently truncates — and per finding #3 that thrown error also ends the session. Separately, spreading the whole array every turn is O(n) per turn → O(n²) over the session. There is no window, no cap, and no summarization at the session level (session-boundary summarization is `migrate`'s job, not a within-session bound).
- **Fix:** Bound the transcript sent to the backend — keep the most recent N turns (optionally always retaining a leading system turn), e.g. slice a trailing window before the `chat` call. Even a simple `messages.slice(-MAX_TURNS)` prevents the overflow while leaving full history to `captureExchange` (which already receives each raw exchange independently).

---

## Suggestions (Minor)

### 1. "streams reply" is a misnomer — the adapter is non-streaming
- **File:** `src/commands/chat.ts:2-4` (module docstring: *"streams the reply back"*)
- The v1 `BackendAdapter.chat` is explicitly non-streaming (`ChatResult { content }`); `runChat` writes the whole reply in one `deps.write`. The T24 acceptance ("streams reply") is functionally met by forwarding the full reply, but the docstring implies token streaming that does not exist. Reword to "writes the reply back" to avoid implying a capability the adapter lacks.

### 2. No readiness check before the first `adapter.chat`
- **File:** `src/commands/chat.ts:159`
- `runChat` trusts `state.active` and calls `adapter.chat` directly; `up`/`switch`/`doctor` all call `waitUntilReady` first. If the server died but `state.json` is stale, the first turn throws a raw network error and (per #3) ends the session. Acceptable for a reader since the error is surfaced, but a single pre-flight `deps.adapter.waitUntilReady({ endpoint: active.endpoint })` before the loop would fail fast with a clearer message.

### 3. Re-resolving the already-canonical active model through the fuzzy resolver
- **File:** `src/commands/chat.ts:132`
- When `-m` is omitted, `resolveModel(catalog, active.modelId)` runs an already-canonical id (produced by a prior resolve at `up` time) back through the *fuzzy* resolver. If the catalog changed since `up` (entry removed, or now ambiguous), `chat` throws `ModelResolutionError` for a server that is genuinely running. Consider exact-matching the id when it comes from `active.modelId`, reserving fuzzy resolution for user-supplied `-m` input.

### 4. `createStdinReader` buffering logic is untested
- **File:** `src/commands/chat.ts:64-97`
- `chat.ts` is not excluded from coverage (only `cli.ts` is), and `createStdinReader` holds non-trivial `pending`/`waiters` queue logic that no test exercises (tests inject `readTurn`). Extracting it to its own small module with a focused unit test (drive `rl` `line`/`close` events, assert queueing when a waiter is/ isn't pending) would cover the one piece of real branching logic in this file.

### 5. No cancellation / `AbortSignal` wiring
- **File:** `src/commands/chat.ts:159`
- `ChatRequest` accepts an optional `signal`, but `runChat` never passes one, so a long or hung backend turn can't be interrupted (no Ctrl-C-to-cancel-turn). Fine for v1 scope; worth a follow-up if interactive UX matters.

---

## What's Done Well

- **Exact-payload capture assertion.** The test `"invokes capture with the exact user/assistant payload"` asserts `toHaveBeenCalledWith(config, store, { user, assistant }, { now })` — precisely the T24 acceptance ("asserted payload, not just call count").
- **Sanitization boundary is correct and tested.** `modelId`, `endpoint`, and every `reply` are `stripControl`'d before reaching stdout/stderr, while `captureExchange` receives the raw reply — the `"strips control/ANSI … but captures it raw"` test pins both halves.
- **`exactOptionalPropertyTypes`-correct option assembly.** `captureOptions` uses conditional spreads (`...(deps.now !== undefined ? { now } : {})`) rather than assigning `undefined`, which is the right pattern under this tsconfig.
- **Clean stdout/stderr discipline.** Reply data → `write` (stdout); the "Chatting with …" banner and prompts → `log` (stderr), matching the CLI convention.
- **Thorough error-path coverage.** No-active-server, no-ollama-source, blank/whitespace-turn skipping, fuzzy `-m` resolution, and default-to-active are all tested.
- **Correct error surface via the CLI wrapper.** `registerChat` catches, `stripControl`s the message, writes `chat: <msg>` to stderr, and sets `exitCode = 1` — so `resolveModel`'s `ValidationError`/`ModelResolutionError` (candidates included) reach the user sanitized and consistently.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 9 chat tests; exact-payload, raw-vs-sanitized, context accumulation, and all error paths asserted. Gap: `createDefaultDeps`/`createStdinReader` unexercised (Suggestion 4). |
| Build verified | ✅ | `tsc` clean; `npm run build` clean. |
| Typecheck | ✅ | `tsc --noEmit` clean under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. |
| Lint | ✅ | `eslint .` clean. |
| Security checked | ✅ | All backend-sourced terminal output `stripControl`'d; raw persisted by capture (which re-sanitizes). CLI wrapper sanitizes error messages. No secrets, no injection surface. |
| Coverage | ⚠️ | Branch logic covered via injected deps; `createDefaultDeps` + `createStdinReader` in `chat.ts` (not coverage-excluded) are untested. |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Capture invoked without the runtime lock its docstring requires — per-exchange `withLock` or reconcile the contract | T24 follow-up |
| 2 | Important | `createDefaultDeps` supplies no `embedder`; live `chat` produces no embeddings, contradicting `CaptureEmbedder` contract | T24 follow-up |
| 3 | Important | Capture failure ends the whole session — catch, warn, continue | T24 follow-up |
| 4 | Important | Unbounded `messages` growth overflows the context window — bound the sent transcript | T24 follow-up |
| 5 | Minor | "streams reply" docstring misnomer (non-streaming adapter) | backlog |
| 6 | Minor | No `waitUntilReady` pre-flight before first `adapter.chat` | backlog |
| 7 | Minor | Fuzzy-resolving the already-canonical `active.modelId` can spuriously fail for a running server | backlog |
| 8 | Minor | `createStdinReader` buffering logic untested | backlog |
| 9 | Minor | No `AbortSignal`/cancellation wiring on `adapter.chat` | backlog |
