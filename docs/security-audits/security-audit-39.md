# Security Audit Report #39

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-26
> **Scope:** Harness-aware chat CLI routing and GUI bridging in `src/harness/*`, `src/commands/chat.ts`, `src/gui/server.ts`, `src/state/state.ts`, and `src/memory/store.ts`; includes review of env-gated availability checks, keying/slug safety, and test execution assumptions.
> **Dependencies:** 7 known vulnerabilities (`npm audit` result: 2 critical, 2 high, 3 moderate; all from Vitest/Vite/esbuild dev tooling, no production runtime dependency issue found)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 0     |
| Info     | 1     |

---

## Findings

No actionable code-level findings were identified in the harness-aware routing and GUI-path logic reviewed in this audit. The implemented boundaries fail closed where they must, and the design preserves the project’s offline/deterministic assumptions.

---

## Positive Observations

- Untrusted command input is constrained at the boundary: `parseHarnessName()` in [src/harness/adapter.ts](src/harness/adapter.ts) strips control bytes and resolves only against the canonical `HARNESS_NAMES` enum before a CLI request is accepted.
- Unknown or missing harness names fail closed: [src/harness/registry.ts](src/harness/registry.ts) throws `ValidationError` when a registry lookup fails, and the chat command checks `harness.isAvailable()` before routing a request in [src/commands/chat.ts](src/commands/chat.ts).
- Env-based availability checks are conservative: the remote harnesses in [src/harness/claude.ts](src/harness/claude.ts), [src/harness/openai.ts](src/harness/openai.ts), and [src/harness/openai-compatible.ts](src/harness/openai-compatible.ts) return `false` when required config is absent or malformed, instead of silently sending requests with empty credentials.
- Loopback-only runtime assumptions are preserved: the GUI binds to `127.0.0.1` and validates the `Host` header against the bound port in [src/gui/server.ts](src/gui/server.ts), while persisted state enforces loopback HTTP endpoints in [src/state/state.ts](src/state/state.ts).
- Memory key semantics are fail-closed: the store slugging logic in [src/memory/store.ts](src/memory/store.ts) rejects unsafe IDs, prevents path traversal, and rejects slug collisions by comparing the stored `modelId` metadata with the requested model before use.
- Test isolation is aligned with the project requirement: the harness tests exercise mocked `fetch` calls and never hit real network endpoints, and the repo instructions explicitly forbid live Ollama/network calls in unit tests.

---

## Action Items (Priority Order)

| #   | Severity | Finding             | Recommendation |
| --- | -------- | ------------------- | -------------- |
| 1   | Info     | Dev dependency CVEs | Keep the Vitest/Vite/esbuild upgrade path on the release checklist; the audit found no app-layer vulnerability in the runtime code reviewed here. |
