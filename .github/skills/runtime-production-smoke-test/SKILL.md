---
name: runtime-production-smoke-test
description: 'Runs production-level smoke tests against real local inference runtimes and real lightweight model weights. Use when: validating an Ollama, llama.cpp, MLX, or future BackendAdapter integration; running a live runtime smoke test; verifying pull→digest→serve→ready→chat/embed→stop; testing custom ports, process ownership, cache safety, or release readiness with actual binaries instead of mocks.'
argument-hint: 'Runtime name and optional scope, e.g. "llamacpp exhaustive" or "mlx pre-release"'
user-invocable: true
disable-model-invocation: false
---

# Runtime Production Smoke Test

## Purpose

Prove that a `BackendAdapter` works against a **real installed runtime process**
and a **real, verified lightweight model artifact**. Unit and contract tests remain
mandatory, but they do not replace this workflow: this test catches upstream-data
drift, process behavior, endpoint routing, listener ownership, cache permissions,
redirect behavior, and cleanup failures that mocks cannot reproduce.

The workflow supports:

- Ollama (shared daemon/store)
- llama.cpp (`llama-server`, one GGUF per process)
- MLX (`mlx_lm.server`, Apple Silicon; implementation may still be in progress)
- Future adapters that implement `BackendAdapter`

## When to Use

Invoke this skill:

- after implementing or materially changing a runtime adapter;
- after changing pull/acquisition, serve, readiness, chat, embed, stop, state, or
  runtime-selection code;
- before declaring a runtime phase shippable;
- when asked for a real/live/production smoke test;
- when catalog revisions, filenames, sizes, or digests change;
- after mocked tests pass but real behavior is unverified.

Do **not** use it for deterministic advice-only changes that never touch a runtime.

## Non-Negotiable Safety Rules

1. **Loopback only.** Bind `127.0.0.1` (or `::1`) and verify the actual listener
   address. Never use `0.0.0.0` during a smoke test.
2. **Never kill an unrelated process.** Inspect the target port first. If occupied,
   preserve that process and choose a free high port. Record its PID and verify it
   is unchanged afterward.
3. **Use production code.** Build first and import from `dist/`, or invoke the
   packaged CLI. Do not substitute test fakes, `tsx src/...`, or handwritten
   lifecycle logic for the adapter path being tested.
4. **Use a real verified artifact.** Pin an immutable revision and exact filename;
   obtain the published digest from an authoritative upstream source (for HF LFS,
   `X-Linked-ETag`) and verify the downloaded bytes independently.
5. **Prefer the lightest compatible model.** Minimize network, disk, startup time,
   and memory. Do not assume that the lightest catalog estimate is the lightest
   actual artifact—validate upstream size first.
6. **Fail closed.** A missing/mismatched digest, revision, file, listener identity,
   model identity, or process identity is a failed smoke test. Never bypass a guard
   to make the test pass.
7. **No secrets through the agent.** Do not request or echo HF tokens, API keys, or
   passwords. Public artifacts should work unauthenticated. If a runtime requires a
   secret, instruct the user to enter it directly in the terminal and stop.
8. **Mandatory cleanup.** Record every PID/port/state mutation. Stop only the
   verified process created by this run, even after inference or readiness failure.
9. **Preserve user state.** If local-llmup already records an active server, do not
   overwrite or stop it for smoke testing. Use adapter-direct mode on a free port,
   or explicitly report that CLI-mutating smoke was skipped.
10. **Do not fabricate success.** Report partial coverage and blockers precisely.

## Runtime Profile Discovery

Before running commands, derive a profile from code and the machine:

| Field | Source |
|---|---|
| adapter name/capabilities | `createDefaultRegistry().get(name)` |
| binary/install hint/default port | adapter implementation |
| model formats | `adapter.capabilities.formats` |
| pull source | validated catalog (`ollama`, `gguf`, `mlx`) |
| readiness/identity paths | adapter implementation and tests |
| chat/embed behavior | `BackendAdapter` capability flags |
| active state | `readState(loadConfig())` |
| expected process executable | installed binary / adapter spawn shape |

Known runtime characteristics (verify against current code; do not blindly assume):

- **Ollama:** shared daemon, default port 11434, daemon-managed model store,
  OpenAI-compatible chat, loopback bind via `OLLAMA_HOST`.
- **llama.cpp:** `llama-server`, default port 8080, one GGUF per process,
  `/health`, `/props`, `/v1/models`, canonical `--alias`; embeddings normally
  disabled for a chat-serving process.
- **MLX:** Apple Silicon only; usually `mlx_lm.server`, one model/revision per
  server. The listening process may be a Python interpreter or launcher—derive
  and verify the actual executable/PID relationship rather than assuming its name.

## Workflow

### 1. Establish a Clean Baseline

- Confirm the repository working tree is clean or document pre-existing changes.
- Record HEAD, package version, OS/arch, Node version, available RAM, and free disk.
- Run the relevant mocked adapter tests and shared contract suite first.
- Run typecheck and build.
- Locate the runtime binary and capture its real version.
- Inspect default and candidate ports before starting anything.
- Read active state; choose **adapter-direct mode** if a user-owned/attached server
  is already recorded.

Stop immediately if the binary is absent, hardware/platform is incompatible, or
there is insufficient disk/RAM. Report the exact install hint or capacity blocker.

### 2. Select and Validate the Real Artifact

1. Enumerate models whose source format intersects the adapter formats.
2. Sort by actual artifact size (not only catalog estimate).
3. Prefer a small official/open-weight model suitable for one short inference.
4. Validate, before download:
   - repository exists;
   - revision is immutable and exists;
   - exact file exists at that revision;
   - reported size is plausible and fits disk;
   - published SHA-256 is available and matches catalog data.
5. If catalog data is invalid, **do not silently switch coordinates** and call the
   catalog path successful. Record a catalog production defect. A direct-adapter
   smoke may continue with separately documented verified coordinates.

For a newly integrated runtime with no catalog entry yet, direct-adapter mode may
use an official smallest artifact, but report that catalog/CLI end-to-end remains
untested.

### 3. Exercise Production Acquisition

Use the built adapter or built CLI, not `curl`, for the primary acquisition test.
Observe and assert:

- caller cancellation/timeout is wired;
- redirects stay HTTPS and within the adapter allow-list;
- bytes do not exceed the configured ceiling;
- progress advances during a long transfer;
- temp files are owner-only and remain under the cache root;
- digest verification succeeds before atomic promotion;
- final file is `0600`, cache directories are `0700`;
- no `.part` or stale lock remains after success;
- a second pull is a verified cache hit and performs no download.

If native acquisition fails or stalls, preserve the failure as evidence. A bounded
external download may be used only to continue lifecycle diagnosis; it does not
turn the acquisition result into a pass.

For an explicitly exhaustive smoke, abort one small transfer and verify no artifact
is promoted. Do not interrupt a multi-gigabyte transfer merely to test cleanup.

### 4. Start the Real Runtime Safely

- Choose a free loopback port; prefer a high alternative if the default is busy.
- Call the production adapter’s `serve()` with the exact verified model path/repo,
  canonical model id, and selected port.
- Record the returned handle immediately.
- Verify at the OS level:
  - listener is loopback-bound, not wildcard;
  - listener PID equals the spawned/returned PID where owned;
  - canonical executable and process start identity match;
  - no unrelated listener was replaced.
- Verify backend identity/readiness endpoints and expected model path/revision/alias.
- For a second `serve()` call against the same process, verify safe attachment
  semantics: no duplicate spawn and no false ownership claim.

A process that answers HTTP but fails PID/executable/model identity is **not trusted**.

### 5. Exercise Real Inference

Send a short non-streaming request through `adapter.chat()` using the **actual custom
endpoint**, not a direct HTTP request unless diagnosing adapter failure.

Use a deterministic marker prompt, low token limit, and no sensitive content, e.g.:

- request an exact marker such as `RUNTIME_SMOKE_OK`;
- verify response schema and marker;
- record prompt/completion tokens and timings when returned;
- verify `/v1/models` exposes the canonical model id/alias.

Capability checks:

- If `canEmbed:true`, send one tiny embedding request and validate vector count,
  consistent dimension, finite numbers, and endpoint routing.
- If `canEmbed:false`, verify the adapter rejects embedding and memory capture uses
  the vector-less path without fabricated vectors.

For single-model runtimes, verify requesting a different model is rejected before
prompt transmission or memory writes.

### 6. Exercise Lifecycle and State Semantics

When safe and applicable:

- verify custom-port chat/migrate uses active state endpoint;
- verify repeated `up` does not resurrect stale ownership;
- verify cross-backend replacement uses the prior backend to stop prior ownership;
- verify prior-stop failure prevents new serve/state overwrite;
- verify a single-model runtime rejects daemon-style `switch` with actionable text;
- verify state records backend, endpoint, port, ownership, PID, executable, and
  process-start identity for owned processes;
- verify corrupt/non-loopback/mismatched-port state fails closed.

Use existing automated tests for destructive race/failure cases unless the user
explicitly requests a destructive real-system test.

### 7. Stop and Clean Up (Always)

Run cleanup even if chat/readiness fails:

1. Stop through `adapter.stop(handle)` when the handle was created by this run.
2. Verify the PID exited and the selected port is no longer listening.
3. Verify unrelated baseline listeners/PIDs are unchanged.
4. Verify state is empty/restored as appropriate.
5. Verify no partial/lock files remain.
6. Retain a verified model cache by default to avoid repeated downloads; report its
   exact size and location. Delete it only if requested.
7. Confirm the repository working tree was not modified by smoke execution.

If adapter cleanup fails, only signal the recorded PID after independently verifying
its listener address, executable, and start identity. Never kill by port or name alone.

### 8. Run Post-Smoke Quality Gates

After cleanup:

- rerun focused adapter/acquisition/contract/state/command tests;
- run the full test suite;
- run typecheck, changed-file lint, and build;
- optionally run coverage/package dry-run for release readiness;
- dispatch code and security reviewers for adapter/network/process changes.

A real smoke pass does not override failing automated gates, and automated gates do
not override a failed real smoke.

## Failure Classification

Classify every failure before changing code:

- **Catalog/upstream truth:** missing revision/file, wrong digest/size.
- **Acquisition:** timeout, redirect, cancellation, byte cap, permissions, lock,
  partial cleanup, atomic promotion.
- **Process:** binary/version, spawn args/env, output deadlock, listener PID/address,
  executable/start identity.
- **Readiness/identity:** wrong endpoint, loading state, model path/alias mismatch.
- **Inference:** request route, schema, custom port, chat/embed capability.
- **State/lifecycle:** ownership, replacement order, stale PID, stop/down/switch.
- **Environment:** unsupported platform, RAM/disk, occupied port, upstream outage.

For a code defect: reproduce with a failing automated test, implement the smallest
root-cause fix, run focused/full verification, then repeat the real step. Do not patch
around a guard or mutate curated data without authoritative evidence.

## Pass Criteria

A runtime is production-smoke **PASS** only when all applicable items hold:

- real binary/version detected;
- real immutable artifact metadata validated;
- production pull/cache hit succeeds with digest verification;
- real process binds loopback and identity matches ownership;
- readiness and model identity are correct;
- real adapter chat succeeds on the selected endpoint;
- embedding behavior matches capability declaration;
- stop releases PID/port without touching unrelated processes;
- state/cache cleanup invariants hold;
- focused and full automated gates pass.

Otherwise report **PARTIAL** or **FAIL** and list exactly what was not proven.

## Evidence Report Template

```markdown
# Runtime Production Smoke — <runtime>

## Result
PASS | PARTIAL | FAIL

## Environment
- HEAD / package version:
- OS / arch / RAM / free disk:
- runtime binary / version:
- selected port and baseline listener:

## Artifact
- model / format / quant:
- repo / immutable revision / exact file:
- published size / SHA-256:
- cache path / mode / cache-hit status:

## Runtime
- endpoint / PID / canonical executable / start identity:
- listener bind address:
- readiness and identity endpoints:
- model path / alias:

## Inference
- chat marker and response:
- token/timing evidence:
- embedding behavior:

## Cleanup
- stop result:
- port/PID released:
- unrelated listeners unchanged:
- partials/locks/state:

## Automated Gates
- focused tests:
- full tests:
- typecheck / lint / build / coverage:

## Defects or Unproven Areas
- severity, reproduction, affected files, next action
```

## Build-Agent Integration

When implementing a new runtime such as MLX, the build agent should invoke this
skill **after** unit/contract tests and **before** final review/commit. A new adapter
is not production-ready merely because it passes the shared mocked contract suite.
The first real smoke should be treated as a discovery step: any failure becomes a
RED regression test before the production fix.
