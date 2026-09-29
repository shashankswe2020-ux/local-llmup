# Implementation Plan: Reasoning Auto-Decision (with switchable Jev decider)

> Status: **Draft — blocking decisions R1–R8 need sign-off**
> Related: [gui-and-harness-adapters.md](../specs/gui-and-harness-adapters.md), [task-31-gui-harness-adapters.md](./task-31-gui-harness-adapters.md)
> External references:
> - TypeSafe Jev ("System One" typed decisions)
> - [ali-master/usejev](https://github.com/ali-master/usejev): a local Laya server implementing TypeSafe's `/v1/systemone` API on `127.0.0.1:3000`
> - [open-alternative-jev](https://github.com/ikermoel/open-alternative-jev): in-process Python library only, no HTTP endpoint
>
> Last updated: 2026-09-27

## Overview

For each chat turn, decide whether a reasoning-capable model should "think".
Thinking is slow and token-hungry; skipping it hurts multi-step answers. There
are three user modes:

| Mode | Behaviour |
| --- | --- |
| `off` / `on` | Force thinking off/on (when the backend supports the toggle) |
| `auto` | Ask a **decider chain**: Jev (if enabled and reachable) → deterministic heuristic → model default |

**Jev can be enabled or disabled independently** through config, the env var
`RIGSPARK_JEV=on|off`, the flags `--jev/--no-jev`, or a GUI switch. When
enabled, Jev answers one typed question, "Does this request need multi-step
reasoning?", as a probability (TypeSafe's `noul` answer type) in a single forward
pass with no generated text. A threshold turns it into on/off.

Every reply records **what was decided and why**: `on · jev p=0.82`,
`off · heuristic`, `on · forced`, or `unsupported by backend`.

Today the gap looks like this:
- `ChatInput` has no reasoning field ([ollama_inference.rs](../../crates/rigspark-runtime/src/ollama_inference.rs#L34-L41)).
- `chat_body` never sends `think` ([ollama_inference.rs](../../crates/rigspark-runtime/src/ollama_inference.rs#L96)).
- `NativeMessage` drops `thinking` output.
- The GUI only shows a transient "Thinking…" indicator (`buildThinking()` in `chat.js`).

## Blocking decisions

| # | Decision | Blocks | Proposed default | Status |
| --- | --- | --- | --- | --- |
| R1 | Default mode. Changing the default alters every existing chat. | J4 | `model-default` (send nothing, today's behaviour); `auto` is opt-in in v1 | ⏳ |
| R2 | Jev endpoint locality. The hosted TypeSafe API sends user prompts off-machine and needs an API key. | J2 | Loopback only by default (e.g. a local Laya server). Remote needs `allowRemote: true` plus a key from `RIGSPARK_JEV_API_KEY`; the key is never written to config, never logged, never shown in the GUI | ⏳ |
| R3 | What is sent to Jev | J2 | Only the latest user message, truncated to 4,000 chars. No system prompt, tool output, files or history | ⏳ |
| R4 | Wire contract. Pin the `/v1/systemone` request/response shape from a real local server (J0), not from memory. | J2 | Strict serde, `deny_unknown_fields` on our structs, response ≤ 64 KiB checked **before** deserialization | ⏳ |
| R5 | Latency budget and failure behaviour | J2 | 400 ms timeout. Any error, timeout, 401 or 429 → fall through to the heuristic, with `source: heuristic (jev unavailable: <reason>)`. Chat never blocks on Jev | ⏳ |
| R6 | Threshold | J1 | `0.5`, configurable in `[0.05, 0.95]`; out-of-range → config error | ⏳ |
| R7 | Backend mapping. Verify each against the pinned backend version in J0. | J3 | Ollama: `think: bool` on `/api/chat`, read `message.thinking`. llama.cpp: `chat_template_kwargs.enable_thinking`. MLX / LM Studio / remote harnesses: `unknown` → report "unsupported", never pretend | ⏳ |
| R8 | Persisting thinking text | J5/J6 | Stored with the assistant message, flagged `thinking`, collapsed by default; excluded from memory/embedding and from Jev input | ⏳ |

Catalog: use the existing `reasoning` capability to decide applicability. No
catalog schema change in v1 (that would be an *ask-first* boundary).

## Architecture decisions

- **Pure heuristic in core** (`rigspark-core/src/reasoning.rs`): `heuristic(prompt) -> Decision`.
  - It is deterministic and offline, with table-driven signals: length, math/code markers, "why/prove/plan/step-by-step" cues, multi-question structure.
  - It is fully unit-tested and never claims a probability (`probability: None`).
- **Decider trait in runtime** (`rigspark-runtime/src/reasoning.rs`):
  ```rust
  #[async_trait]
  pub trait ReasoningDecider: Send + Sync {
      async fn decide(&self, prompt: &str, cancel: &CancellationToken) -> Result<Decision, DeciderError>;
  }
  pub struct Decision { pub think: bool, pub source: Source, pub probability: Option<f64> }
  ```
  - `JevDecider` uses the injected `Transport`, so there are no new dependencies.
  - `DeciderChain` implements the fall-through.
- **Applicability first.** If the model lacks the `reasoning` capability, or the backend toggle is `unknown`, the chain is skipped and the decision is `not-applicable` / `unsupported`. Jev is not called, so no data is sent.
- **Security.**
  - The Jev URL is validated like the other loopback URLs (`state::loopback`).
  - Prompt text is not logged; redaction is reused.
  - Jev responses are strictly typed, and the probability must be finite and within `[0, 1]`, else it is treated as unavailable.
- **Determinism boundary.** Advice commands are untouched. Only chat, which already depends on runtime, uses the decider.

## Dependency graph

```
J0 spike: pin Jev + backend toggle contracts (fixtures)
R6 ► J1 core Decision + heuristic (pure)
{J0,R2–R5} ► J2 JevDecider + DeciderChain (runtime)
{J0,R7} ► J3 ChatInput.reasoning + backend mapping + thinking decode
{J1,J2,J3,R1} ► J4 config v2 `reasoning` + env + resolution order
        J4 ► J5 CLI chat flags + decision line
        J4 ► J6 GUI mode toggle + Jev switch + badges + thinking block
{J5,J6} ► J7 docs + security review
```

J1, J2 and J3 can run in parallel after J0.

## Cross-cutting conventions

- Never call real Jev or TypeSafe, Ollama or llama.cpp in tests. Use the fixture Transport replaying J0 captures.
- Never mutate process env in parallel tests. Env resolution is a pure function taking a map.
- Body limits are checked before deserialization, including for error responses.
- Gates: fmt, strict Clippy, workspace tests, `cargo native-retirement`.

## Task list

### J0 — Spike: pin contracts (no production code)
- Run the local Laya server (`ali-master/usejev`) on loopback and capture:
  - a `/health` response
  - a `/v1/systemone` request/response with a single `noul` question
  - 401 and 429 bodies
- Capture an Ollama `/api/chat` exchange with `think:true` and one with `think:false` from a reasoning model.
- Capture a llama-server exchange with `chat_template_kwargs.enable_thinking`.
- Record versions.
- **Output:** fixtures in `crates/rigspark-runtime/tests/fixtures/reasoning/`, plus an ADR note in this plan confirming or correcting R4 and R7.

### J1 — Core decision + heuristic
- **Acceptance:**
  1. A table of at least 40 labelled prompts (math, code, trivia, greetings, multi-step plans) gives the documented outcome.
  2. Identical input → identical output.
  3. The threshold validator rejects NaN and out-of-range values.
- **Files:** `crates/rigspark-core/src/reasoning.rs` (new), `lib.rs`, `crates/rigspark-core/tests/reasoning.rs`.
- **Verify:** `cargo test -p rigspark-core --test reasoning`.

### J2 — JevDecider + chain
- **Acceptance:**
  1. A fixture `noul` of 0.82 → `think=true, source=jev, p=0.82`.
  2. Timeout, oversized body, malformed JSON, p=1.3, 401 and 429 each → heuristic fallback with a reason.
  3. A non-loopback URL without `allowRemote` → config error.
  4. A remote URL without an API key → error; the key is sent only as a bearer header and never appears in errors or logs.
  5. Cancellation returns promptly.
- **Files:** `crates/rigspark-runtime/src/reasoning.rs` (new), `lib.rs`, `crates/rigspark-runtime/tests/reasoning.rs`.
- **Verify:** `cargo test -p rigspark-runtime --test reasoning`.

### J3 — Backend mapping + thinking decode
- **Do:**
  - `ChatInput.think: Option<bool>`. It is a serde default, so existing callers are unchanged.
  - Ollama `chat_body` sets `think` only when `Some`. The decoder surfaces `thinking` in `ChatResult.thinking: Option<String>`.
  - Streaming deltas separate thinking from content.
  - llama.cpp / OpenAI-compatible paths map to `chat_template_kwargs` when verified; otherwise the result is typed `Unsupported`.
- **Acceptance:**
  1. With `think: None`, the request body is byte-identical to today's (golden).
  2. Fixture round-trips work in both modes.
  3. An unsupported adapter returns `Unsupported` and does not send the field.
- **Files:** `ollama_inference.rs`, `adapters.rs`, `special_adapters.rs`, `openai.rs`, `harness.rs`, their tests.
- **Verify:** `cargo test -p rigspark-runtime`.

### J4 — Configuration + resolution
- **Do:**
  - `config.json` `schemaVersion: 2` gets an optional `reasoning` object: `{ "mode": "model-default|auto|on|off", "jev": { "enabled": bool, "endpoint": "http://127.0.0.1:3000", "model": "laya", "threshold": 0.5, "timeoutMs": 400, "allowRemote": false } }`.
  - `RIGSPARK_JEV=on|off` overrides `jev.enabled`.
  - Resolution order: request flag → env → config → default.
  - Shares the v2 bump with [task-34](./task-34-pluggable-kv-cache.md) C6. Whichever plan lands first owns the migration.
- **Acceptance:**
  1. v1 configs are still accepted.
  2. Unknown fields are rejected.
  3. The resolution order is proven by a pure-function table test.

### J5 — CLI chat
- **Do:** `llmup chat --reasoning <model-default|auto|on|off> [--jev|--no-jev] [--show-thinking]`. The plain-output decision line goes to stderr, so stdout stays the answer. JSON output gains `reasoning: {think, source, probability}`.
- **Acceptance:** goldens for each mode using an injected decider and backend; `--help` golden updated.
- **Files:** `native_args.rs`, `native.rs`, `native_chat.rs`, `chat_service.rs`, `crates/rigspark-cli/tests/*chat*.rs`.

### J6 — GUI
- **Do:**
  - The composer gets an Auto / On / Off toggle; settings get a Jev on/off switch and an endpoint field. A reachability check runs on click only, never in the background.
  - Each assistant message gets a badge (`thinking · jev 0.82`).
  - A collapsible thinking block reuses the existing `.run-thinking` styles.
  - `/api/chat` validates the new fields.
- **Acceptance:**
  1. API contract tests cover each mode.
  2. The Jev switch persists.
  3. The WebDriver journey covers toggling and the badge text.
  4. Thinking text is sanitized through the same Marked/DOMPurify path as content.
- **Files:** `crates/rigspark-gui/src/{chat.rs,routes.rs,options.rs}`, `static/{chat.js,index.html,styles.css}`, `crates/rigspark-gui/tests/*`.

### J7 — Docs + security review
- README "Reasoning: auto, on, off" with the Jev setup (local Laya, optional remote), the privacy note on R2/R3, CHANGELOG, and a short security-audit entry covering data egress, key handling and response validation.
