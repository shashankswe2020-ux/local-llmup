# Code Review Checkpoint 23: Task B14a

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 7 August 2026
> **Scope:** Task B14a — `LlamaCppAdapter` descriptor / install / capabilities / registration skeleton (Scope S)
> **Test suite:** 827 tests passing (52 files), typecheck ✅, build ✅, lint ✅ for changed files (2 pre-existing `no-undef` errors in `site/main.js`, out of scope)

---

## Verdict: ❌ REQUEST CHANGES

**Overview:** A clean, well-documented skeleton that nails the B14a acceptance surface — capabilities descriptor, `isInstalled`, `installHint` per-platform, an abort-bounded/`stripControl`-clean `version()`, typed-error stubs for the unimplemented lifecycle, and registration as `["ollama","llamacpp"]` with no advice-path determinism regression. One **Important** correctness bug in `parseVersion` (wrong version reported on real `llama-server` output, masked by an unrealistic test fixture) blocks approval. Everything else is Minor and safe to land as follow-ups.

---

## Critical Issues

None.

## Important Issues

### 1. `parseVersion` returns the compiler version, not the llama.cpp build number, on real output
- **File:** `src/backend/llamacpp.ts:141-155`
- **Problem:** The function tries the generic semver token **first** (line 142), then the `version:` build-number pattern (line 146). But real `llama-server --version` output is two lines, e.g.:
  ```
  version: 3860 (a1b2c3d)
  built with Apple clang version 15.0.0 (clang-1500.3.9.4) for arm64-apple-darwin23.6.0
  ```
  (Linux: `built with cc (Ubuntu 11.4.0-...) 11.4.0 for x86_64-linux-gnu`). `probe` combines stdout+stderr, so the first `\d+\.\d+\.\d+` match is the **compiler** version (`15.0.0` / `11.4.0`), and `version()` reports that instead of llama.cpp's authoritative build number (`3860`). For llama.cpp the `version:` build number *is* the identity; a semver-looking token is almost always the toolchain. The doc comment even states the intent ("reports a build number … prefer a semver-looking token, then the `version:` build number") — but that preference order is backwards for this backend, so it contradicts its own stated goal. Given the project's honesty principle, `doctor` surfacing the compiler version as the llama.cpp version is a mild honesty regression.
- **Why the tests don't catch it:** The fixture at `tests/backend/llamacpp.test.ts:124` uses `"version: 3860 (a1b2c3d)\nbuilt with clang\n"` — deliberately omitting the compiler's version number — so the semver branch never fires. A realistic banner (`built with Apple clang version 15.0.0 …`) would make the existing test return `15.0.0` and fail.
- **Fix:** Check the `version:` build-number pattern **before** the generic semver, and add a Prove-It test with a realistic multi-line banner:
  ```ts
  function parseVersion(output: string): string | null {
    // llama.cpp's authoritative identity is the `version:` build number; a
    // semver-looking token in the banner is usually the compiler, so match it first.
    const build = /version:\s*([0-9A-Za-z.+-]+)/i.exec(output);
    if (build !== null && build[1] !== undefined) {
      return build[1];
    }
    const semver = /\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/.exec(output);
    if (semver !== null) {
      return semver[0];
    }
    const firstLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine !== undefined ? firstLine.slice(0, VERSION_BANNER_MAX_CHARS) : null;
  }
  ```
  New test:
  ```ts
  it("extracts llama.cpp's build number even when a compiler semver is present", async () => {
    const { spawn } = fakeSpawn({
      code: 0,
      stderr:
        "version: 3860 (a1b2c3d)\nbuilt with Apple clang version 15.0.0 (clang-1500.3.9.4) for arm64-apple-darwin23.6.0\n",
    });
    const adapter = new LlamaCppAdapter({ spawn });
    await expect(adapter.version?.()).resolves.toBe("3860");
  });
  ```

## Suggestions (Minor)

### 1. Process-seam duplication between `ollama.ts` and `llamacpp.ts`
- **File:** `src/backend/llamacpp.ts:49-155`
- `defaultSpawn`, `adaptStream`, `wrapSpawnError`, `probe`, and `parseVersion` are near-copies of the Ollama versions. Acceptable for a skeleton and explicitly deferred, but it means the Important bug above (and any future spawn-seam fix) must be fixed in two places. Recommend extracting a shared `src/backend/process-seam.ts` (spawn seam + `wrapSpawnError` + a generic `probe`) when the **B16 shared adapter contract suite** lands. `llamacpp`'s `wrapSpawnError(binary, error: unknown)` is actually the better signature (normalizes non-`Error` throws internally) and should win in consolidation.

### 2. Backend-generic process-seam types live in `ollama.ts`
- **File:** `src/backend/llamacpp.ts:32`
- `import type { ProcessOutputStream, SpawnFn, SpawnedProcess } from "./ollama.js";` makes the llama.cpp adapter depend on the Ollama module purely for generic seam types, an odd sibling-to-sibling dependency direction. These types aren't Ollama-specific; relocating them to `adapter.ts` (or the future `process-seam.ts`) would keep adapters independent. Track alongside Suggestion 1 for B16.

### 3. `stripControl` version test is trivially satisfied
- **File:** `tests/backend/llamacpp.test.ts:135-141`
- Fixture `"version: 3\u001b[31m860\n"` makes `parseVersion` stop the `version:` capture at the ESC and return `"3"`, so the assertion `not.toMatch(/\u001b/)` passes without meaningfully exercising `stripControl`. Prefer a fixture where the control char survives parsing into the returned token (e.g. a semver/build token containing an interior control byte) so the test actually proves `stripControl` scrubs the output.

### 4. `VERSION_CAPTURE_MAX_BYTES` is compared against `text.length` (chars, not bytes)
- **File:** `src/backend/llamacpp.ts:43,120-125`
- The cap uses UTF-16 code-unit length, not byte length, so the name slightly overstates precision. Harmless as a memory bound (mirrors Ollama's line-buffer approach); rename to `_CHARS` or document the approximation if consolidating in B16.

### 5. Windows `winget` package id is unverified
- **File:** `src/backend/llamacpp.ts:200`
- `winget install ggml.llamacpp` — worth confirming this package id exists in the winget repo. Low risk since the hint also carries the releases-URL fallback; verify before Phase 2 ship (D4).

## What's Done Well

- **`canEmbed:false` is the honest, correct call.** A single chat-serving `llama-server` cannot also serve embeddings without a dedicated `--embedding` instance; declaring `false` routes memory capture to the vector-less path rather than calling a disabled endpoint or fabricating vectors — squarely aligned with the honesty gate. The inline rationale (llamacpp.ts:173-179) is exemplary.
- **Determinism preserved.** `backendsForModel` filters `registry.all()` by format intersection; `llamacpp` advertises `["gguf"]` and the catalog has zero `gguf` sources today, so ollama-format models still resolve to `["ollama"]`. Adding the adapter to `createDefaultRegistry()` changes advice output only once B15 introduces gguf sources — exactly as intended.
- **Security posture is solid:** every spawn is `shell:false` with a discrete arg array, `version()` is abort-bounded (1.5s) so a wedged binary can't block `doctor`, output is capture-capped (8 KiB) and `stripControl`-clean at the source, and unimplemented lifecycle methods fail closed with a typed `BackendError` rather than pretending to work.
- **Registration + unimplemented-stub tests** assert the full contract (`all()` order, `get("llamacpp")` resolution, and that serve/pull/chat/embed/waitUntilReady/stop all reject with `BackendError`), and the process seam is fully injected — no real `llama-server` is ever spawned.

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ⚠️ | Coverage of the descriptor/install/stub surface is thorough; `version()` fixtures are unrealistic and mask Important #1 and weaken Suggestion #3. |
| Build verified | ✅ | `tsc` clean; `tsc --noEmit` clean. |
| Security checked | ✅ | `shell:false` arg arrays, abort-bounded probe, output capped + `stripControl`-clean, fail-closed typed-error stubs, loopback default port 8080. |
| Coverage | ⚠️ | Behavior covered, but the version happy-path fixture doesn't reflect real `llama-server` output. |
| Lint (changed files) | ✅ | `src/backend/*.ts` + tests clean. 2 pre-existing `no-undef` in `site/main.js` are unrelated to B14a. |
| Determinism / advice path | ✅ | No gguf catalog sources → `backendsForModel` unchanged for existing models. |

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | `parseVersion` matches compiler semver before the `version:` build number → wrong version on real `llama-server` output; add realistic Prove-It test | B14a (before merge) |
| 2 | Minor | Extract shared process seam (`defaultSpawn`/`adaptStream`/`wrapSpawnError`/`probe`/`parseVersion`) to a common module | B16 |
| 3 | Minor | Relocate `SpawnFn`/`SpawnedProcess`/`ProcessOutputStream` types out of `ollama.js` into a shared module | B16 |
| 4 | Minor | Strengthen `stripControl` version test with a fixture where the control byte survives parsing | B14a/backlog |
| 5 | Minor | Rename/clarify `VERSION_CAPTURE_MAX_BYTES` (chars vs bytes) | B16 |
| 6 | Minor | Verify Windows `winget` package id `ggml.llamacpp` | Phase 2 ship (D4) |
