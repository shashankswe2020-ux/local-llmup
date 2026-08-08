# Code Review Checkpoint 25: Task B14c — llama.cpp pull/chat/embed + `up --backend llamacpp` wiring

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-07
> **Scope:** Task B14c — complete the `LlamaCppAdapter` surface (`pull`/`chat`/`embed`)
> on top of the B14b lifecycle, and wire `up --backend llamacpp <model>` end-to-end
> (format-aware source resolution, `modelPath` threading into `serve`).
> **Test suite:** 854 tests passing (52 files, +13 vs checkpoint 24), typecheck ✅,
> build ✅, lint (changed files) ✅. Repo-wide lint has 2 pre-existing errors in
> `site/main.js` (browser globals) — untouched by this change, out of scope.
> **Files reviewed (uncommitted working tree vs HEAD `1319dfc`):**
>
> - `src/backend/adapter.ts` (MODIFIED) — `PullWeightSource`, `PullOptions.source?`, `PullResult.modelPath?`
> - `src/backend/llamacpp.ts` (MODIFIED) — `pull`/`chat`/`embed`, injectable `acquire` seam
> - `src/commands/up.ts` (MODIFIED) — `backend?`, format-aware source resolution, `modelPath` threading
> - `src/cli.ts` (MODIFIED) — `--backend <name>` option
> - `tests/backend/llamacpp.test.ts` (MODIFIED) — chat/embed/pull tests
> - `tests/commands/up.test.ts` (MODIFIED) — backend-configurable fake, e2e llamacpp workflow + rejection

---

## Verdict: ✅ APPROVE

**Overview:** A clean, well-documented completion of the llama.cpp adapter that
faithfully mirrors the Ollama adapter's `chat` structure while correctly delegating
weight acquisition to the shared fail-closed `acquireWeight` module and honestly
failing closed on `embed`. The security reasoning for omitting `assertSafeModelId`
in `chat` is sound and verified below. No Critical issues. One Important item —
the GGUF pull path has no size-floor fallback and `up` does not surface
`digestVerified:false` — is currently **latent** (the catalog ships zero GGUF
sources today) but should be addressed before GGUF entries land in `data/models.json`.

---

## Critical Issues

None.

---

## Important Issues

### 1. GGUF pull can serve digest-unverified weights with no warning or size-floor fallback

- **File:** [src/commands/up.ts](../../src/commands/up.ts#L203-L214), acquisition contract at [src/backend/acquire.ts](../../src/backend/acquire.ts#L56-L79)
- **Problem:** The Ollama branch always passes `expectedSizeBytes: quant.diskBytes`
  as a size-floor fallback, so an Ollama pull is either digest-verified or size-floor-verified.
  The GGUF branch passes **only** `sha256` (conditionally) and there is no size-floor
  parameter in `AcquireRequest` at all. When a catalog GGUF entry omits `sha256`,
  `acquireWeight` returns `digestVerified:false` and the file is served anyway —
  `up` never inspects `pullResult.digestVerified` nor emits a warning. The pinned
  commit (`X-Repo-Commit` == `revision`) is _always_ verified, so this is not
  fully-unverified content, but the domain's "refuse to serve unverified weights"
  posture and the honesty gate argue for at least a visible signal. Impact today is
  zero — `data/models.json` currently contains no `gguf` sources — so this is latent
  plumbing, but it becomes live the moment a GGUF entry without a digest is added.
- **Fix:** When `pullResult.digestVerified === false`, emit an explicit warning via
  `deps.log` on the GGUF path (mirroring how the size-only Ollama fallback is a
  deliberate, surfaced degradation), e.g.:
  ```ts
  if (!pullResult.digestVerified) {
    deps.log(
      `up: ${stripControl(model.id)} weights are commit-pinned but the catalog has no sha256; serving digest-unverified (honesty gate)\n`,
    );
  }
  ```
  Longer term, prefer requiring `sha256` on GGUF catalog entries at the schema
  boundary so this branch is unreachable, or thread a size floor into `AcquireRequest`.

---

## Minor Issues

### 1. `chat` hardcodes port 8080, ignoring a custom `up --port`

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L745-L746)
- **Problem:** `chat` builds its endpoint from `buildEndpoint(DEFAULT_BIND_HOST, LLAMACPP_DEFAULT_PORT)`,
  so `up --backend llamacpp --port 9090` serves on 9090 while `chat` targets 8080.
  This is exact **parity** with the Ollama adapter ([src/backend/ollama.ts](../../src/backend/ollama.ts#L1005)),
  which also hardcodes its default port, and `ChatRequest` carries no endpoint —
  so it is a pre-existing whole-of-project design limitation, not a regression
  introduced here. Flagging so it is tracked: when `chat` learns the active
  endpoint from persisted server state, both adapters should be fixed together.
- **Fix:** Out of scope for B14c. Track for a future slice that plumbs the active
  server endpoint/port into `ChatRequest`.

### 2. Progress sequence says "downloading" then "cached" on a cache hit

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L451-L461)
- **Problem:** `pull` unconditionally emits `downloading <file>` _before_ calling
  `acquire`, then emits `cached <file>` when the artifact was already present. The
  two-line sequence ("downloading X" → "cached X") reads as mildly contradictory.
  Cosmetic only; no behavioral effect.
- **Fix:** Consider dropping the pre-emit, or wording it as `resolving <file>`.

---

## Nits

### 1. Post-schema `choices[0]` guard is required, not dead

- **File:** [src/backend/llamacpp.ts](../../src/backend/llamacpp.ts#L790-L794)
- The `const [first] = parsed.data.choices; if (first === undefined) throw` guard
  looks redundant after the schema's `.min(1)`, but `noUncheckedIndexedAccess`
  types the destructured element as `T | undefined`, so the guard is what keeps
  this `!`-free. This is the correct, repo-idiomatic destructure-and-guard pattern —
  keep it.

### 2. `chat` error-path test coverage has two small gaps

- **File:** [tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L160-L214)
- Covered: success round-trip, non-2xx, transport failure, malformed (empty `choices`).
  Not covered: the `json()`-throws branch (invalid JSON) and the `typeof json !== "function"`
  branch. Both mirror already-tested Ollama behavior, so value is low, but two
  one-line fakes would close the matrix.

### 3. Missing assertion that "downloading" progress precedes completion

- **File:** [tests/backend/llamacpp.test.ts](../../tests/backend/llamacpp.test.ts#L216-L240)
- The pull tests assert `events` _contains_ `downloaded`/`cached` but never assert
  ordering relative to the initial `downloading` emit. Optional.

---

## Security Review

| Check                                | Status                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` omitting `assertSafeModelId`  | ✅ Verified safe       | The model id travels **only** inside the `JSON.stringify(...)` body (control chars are JSON-escaped), the URL is a fixed literal (`/v1/chat/completions`), and `chat` spawns no process — so there is no argv or URL-path injection surface. Skipping the stricter Ollama validator is correct here: that validator rejects legitimate uppercase HF names (`Qwen3-14B`), which `llama-server` accepts in the body. Reasoning holds. |
| GGUF acquisition safety              | ✅ Delegated correctly | `pull` forwards to `acquireWeight`, which enforces HTTPS-only + HF host allow-list, traversal-checked file, `0700`/`0600` cache perms, commit-pin + digest verification, and atomic rename (never promotes a partial). No new URL/path construction added at the adapter layer.                                                                                                                                                     |
| Loopback-only                        | ✅                     | `chat` binds `DEFAULT_BIND_HOST` (127.0.0.1); `serve` continues to force loopback (B14b).                                                                                                                                                                                                                                                                                                                                           |
| Fail-closed / honesty gate           | ✅                     | `embed` rejects (declares `canEmbed:false`, no fabricated vectors); `pull` refuses without a pinned source; `digestVerified` is surfaced honestly.                                                                                                                                                                                                                                                                                  |
| No secrets / no `any` / typed errors | ✅                     | Typecheck + lint clean on changed files; all failures throw `BackendError`/`ValidationError`.                                                                                                                                                                                                                                                                                                                                       |

---

## Ollama Path Parity

- **Happy path: byte-identical.** For the Ollama adapter, `formats.includes("ollama")`
  is true, so `ollamaId = model.source.ollama` and the pull call is unchanged
  (`modelId`, conditional `expectedSha256`, `expectedSizeBytes`, `onProgress`).
- **One error-message change (edge case):** an Ollama model with _no_ `ollama` source
  previously threw `model <id> has no ollama source to pull`; it now falls through to
  `model <id> has no source that backend ollama can serve`. Both are `ValidationError`
  and no test asserts the old text (all 854 pass), so this is a benign message change —
  worth noting only against the strict "byte-identical" bar.

---

## What's Done Well

- **Security reasoning is explicit and correct.** The doc comment on `chat` states
  precisely _why_ `assertSafeModelId` is skipped (body-only, JSON-escaped, no argv/URL),
  which is exactly the kind of decision that needs to be legible to the next engineer.
- **Honest `embed` failure.** Rejecting with a message that names the capability flag
  and the degradation path (`memory capture uses the vector-less path`) is a textbook
  honesty-gate implementation — no stub vectors, no silent success.
- **Clean injectable `acquire` seam.** `AcquireFn` + `defaultAcquire` keep the network
  fully out of tests while reusing the shared fail-closed downloader, so pull tests
  assert the exact `AcquireRequest` shape without touching disk or HF.
- **Format-aware source resolution reads well.** The `up` branch structure (Ollama by
  model id → GGUF by pinned source → typed rejection) is straightforward and the
  comment explains the daemon-vs-self-managed distinction crisply.

---

## Verification Story

| Check            | Status | Notes                                                                                                                                      |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Tests reviewed   | ✅     | 854 passing (+13); new chat/embed/pull unit tests + `up --backend llamacpp` e2e + no-servable-source rejection all present and meaningful. |
| Build verified   | ✅     | `npm run build` clean.                                                                                                                     |
| Typecheck        | ✅     | `tsc --noEmit` clean (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).                                                   |
| Lint (scope)     | ✅     | ESLint clean on all 6 changed files; 2 repo-wide errors are pre-existing in `site/main.js`, out of scope.                                  |
| Security checked | ✅     | `assertSafeModelId` omission validated; acquisition safety delegated to hardened `acquireWeight`; loopback preserved.                      |
| Coverage         | ⚠️     | Strong; two low-value `chat` error branches (`json()` throws, missing `json`) and pull progress ordering untested.                         |

---

## Action Items

| #   | Priority   | Issue                                                                                                                                                            | Target                                         |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Important  | GGUF pull: warn (or fail) when `digestVerified:false`; no size-floor fallback exists on the acquire path                                                         | before GGUF entries land in `data/models.json` |
| 2   | Minor      | `chat` hardcodes default port, ignoring `up --port` (parity with Ollama; both need the active endpoint threaded into `ChatRequest`)                              | future slice (whole-project)                   |
| 3   | Minor      | pull progress emits "downloading" then "cached" on a cache hit                                                                                                   | backlog                                        |
| 4   | Nit        | Add `chat` tests for invalid-JSON and missing-`json` branches; assert pull progress ordering                                                                     | backlog                                        |
| 5   | Carry-over | Checkpoint 24 Important #1 (owned-spawn readiness never consults `/health`) remains open; unaffected by B14c but relevant now that llama.cpp is wired end-to-end | confirm against target `llama-server` version  |
