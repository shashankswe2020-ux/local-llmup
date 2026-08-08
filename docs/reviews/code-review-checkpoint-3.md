# Code Review Checkpoint 3: Task T20 (`switch` command)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 5 August 2026
> **Scope:** T20 — the `switch` command (resolve target → require an active server → no-op if already active → pull target + health-check the running daemon → repoint `state.active.modelId` under lock), plus the `registerSwitch` CLI wiring. Deps T12 (state), T14 (resolver), T17 (adapter). T7 hardware fit is intentionally **not** a dep — `switch` is a repoint, not a re-fit.
> **Test suite:** 320 tests passing (25 files), typecheck clean, lint clean, build clean.

---

## Verdict: ✅ APPROVE

**Overview:** `switch` is a small, fully dependency-injected repoint that meets every T20 acceptance criterion: it switches the active model, treats switching to the already-active model as a defined stdout no-op, and preserves the prior active record on any failure because all fallible I/O (`pull`, `waitUntilReady`) runs **before** the lock and `writeState` is the last statement in the transaction. Inheriting the _inside-lock_ `active` handle and overwriting only `modelId` is the correct choice for a single shared Ollama daemon. No Critical or Important issues. Findings are Minor/Nit: the confirmation message prints the _outside-lock_ endpoint, no re-confirmation that `active.modelId` still matches the value the no-op decision was based on (benign last-writer-wins), and the usual status-to-stdout routing judgment call carried over from checkpoints 1–2.

---

## Critical Issues

None.

---

## Important Issues

None.

---

## Minor Issues

### 1. Final confirmation prints the outside-lock `current.endpoint`, not the repointed handle (Focus Q2)

- **File:** `src/commands/switch.ts` (final `deps.write(\`Switched to ... (${stripControl(current.endpoint)}).\n\`)`)
- **Problem:** The write inside the lock inherits the freshly re-read `active` handle (`{ ...active, modelId: target.id }`), which correctly picks up any endpoint/pid/port that changed while `pull`/`waitUntilReady` ran. But the confirmation message reports `current.endpoint` — the value read **before** the lock. If a concurrent `up` restarted the daemon on a new port between the outside read and the transaction, the state record is correct but the printed endpoint is stale, so the user is told an endpoint that no longer serves the model.
- **Assessment:** Low-probability and cosmetic (the persisted record is right); it only misleads the on-screen confirmation. It also mildly contradicts the code's own decision to trust the inside-lock handle everywhere else.
- **Fix:** Capture the endpoint actually written and print that. Return it from the lock callback so the message and the record share one source of truth:
  ```ts
  const endpoint = await deps.withLock(deps.config, () => {
    const active = deps.readState(deps.config).active;
    if (active === null) {
      throw new ValidationError("the active server stopped during switch; run `up` again.");
    }
    deps.writeState(deps.config, {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: { ...active, modelId: target.id },
    });
    return active.endpoint;
  });
  deps.write(`Switched to ${stripControl(target.id)} (${stripControl(endpoint)}).\n`);
  ```

### 2. No re-confirmation inside the lock that the active model still matches the no-op decision (Focus Q2)

- **File:** `src/commands/switch.ts` (inside-lock block only checks `active === null`, then writes `modelId: target.id`)
- **Problem:** The no-op / "already active" decision (`current.modelId === target.id`) is made outside the lock, and `pull` runs outside the lock. Two concurrent `switch A` / `switch B` invocations can therefore both pull and then serialize their writes; the second writer silently wins, overwriting the first repoint. `withLock` serializes the _writes_ but not the _decision_, so there is no detection that the active model changed underneath.
- **Assessment:** Acceptable for a single-user local CLI — the outcome is always a valid, on-disk-present model pointed at the live daemon (both models were pulled), so there is no corruption, just last-writer-wins. Flagged so the non-atomic decision window is a documented choice rather than an accident.
- **Fix:** Either document the last-writer-wins semantic with a one-line comment, or, if determinism is wanted, re-check inside the lock and no-op when `active.modelId === target.id` already holds (also makes the transaction idempotent under contention). No change required for correctness.

### 3. `switch` does not re-check disk/hardware fit before pulling a larger model (Focus Q3)

- **File:** `src/commands/switch.ts` (pull path — digest passed only when the resolver got an explicit `-<quant>` suffix; no fit/disk guard)
- **Problem:** By design (T7 is not a dep) `switch` never re-runs fit, so a user can repoint to a model far larger than the box can serve. `pull` only guarantees the weights are **on disk**; because Ollama loads on first inference, an over-large target will fail at _inference_ time on the shared endpoint, well after `switch` reports success. The user gets a green "Switched to …" with a model that will not actually load.
- **Assessment:** Within the accepted T20 scope (`switch` = repoint, `migrate` handles moves/fit), and a hard fit gate here would duplicate `up`. The gap is UX transparency, not correctness.
- **Fix:** Optional, low-cost: when the resolver carries `quant.diskBytes`/param metadata, print a stderr advisory (not an error) if the target is materially larger than the outgoing model, so "switched successfully but may not load" is visible. Defer a real fit check to `migrate`.

---

## Nits

### 1. Status/confirmation messages routed to stdout

- **File:** `src/commands/switch.ts` (`deps.write` for both the "already active" no-op and the final "Switched to …" line)
- Consistent with checkpoints 1–2, these are human status/confirmation lines rather than machine-parseable result _data_, yet they go to stdout while progress (`Preparing…`, per-event) correctly goes to stderr. This is the same judgment call already noted for `down` (checkpoint 2, Nit 2) and is fine to keep for cross-command consistency — noting only so the stdout=data / stderr=diagnostics split stays a deliberate, uniform choice across the CLI.

### 2. `Preparing …` is printed even when `pull` is a no-op for an already-present model

- **File:** `src/commands/switch.ts` (`deps.log(\`Preparing ${stripControl(ollamaId)}...\n\`)`before`pull`)
- Because `pull` is idempotent for already-present models, the "Preparing" line (and possibly zero progress events) prints even when nothing is downloaded. Harmless and on stderr; could be softened to "Verifying …" but not worth churn.

### 3. Health check cannot detect a dead-but-recorded daemon before repointing

- **File:** `src/commands/switch.ts` (`waitUntilReady({ endpoint: current.endpoint })` guards the endpoint, but the inside-lock guard only checks `active === null`)
- If the recorded daemon process died without clearing state, `pull` (which needs a running daemon) throws `BackendError` first and the prior record is preserved — so `switch` fails safe. The stale-record reconciliation is a cross-command concern (same class as checkpoint 2, Minor 2), not a T20 defect; cross-referencing only.

---

## What's Done Well

- **Failure genuinely preserves prior active (Focus Q1):** Every fallible operation — `resolveModel`, `pull`, `waitUntilReady` — runs before the lock, and `writeState` is the final statement of the transaction. There is no code path that mutates state on failure; the pull-failure and health-failure tests both assert the prior record survives. This is the correct ordering.
- **Inside-lock handle inheritance is the right model (Focus Q2):** Reusing the re-read `active` and overwriting only `modelId` correctly inherits `endpoint`/`pid`/`port`/`ownedByUs` from whatever daemon is actually live at commit time — exactly right for a single shared Ollama daemon whose weights live in a daemon-independent on-disk store, so a pulled target is served by any running instance.
- **Digest discipline matches the spec:** `expectedSha256`/`expectedSizeBytes` are forwarded to `pull` only when the resolver produced an explicit `-<quant>` suffix, and the `exactOptionalPropertyTypes`-safe conditional spreads avoid ever passing `undefined` — precisely the T20 requirement to pull with the catalog digest only for explicit quants.
- **Consistent sanitization:** Every externally-derived display string — `target.id`, `ollamaId`, per-event `status`, `endpoint` — is `stripControl`'d before it touches a terminal, and the `registerSwitch` handler `stripControl`s the error message before stderr. Resolver re-validates ids and rejects `..`, so no unsanitized model/registry string or path reaches output.
- **Typed errors and clean stream split:** Preconditions throw `ValidationError` (no active server, no ollama source, mid-switch disappearance); adapter failures surface as `BackendError`; result/confirmation → stdout, progress/diagnostics → stderr, and the CLI maps any throw to `exit 1`.
- **High-fidelity tests:** The suite exercises the real state layer (temp home + real `readState`/`writeState`/`withLock`) with only the adapter faked, covering no-active, already-active no-op, a full repoint (asserting endpoint/pid/port/ownedByUs are inherited), pull failure, health failure, and the explicit-quant digest path.

---

## Verification Story

| Check            | Status | Notes                                                                                                                                                                  |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 320 passing (25 files); T20 cases cover no-op, repoint, pull/health failure preservation, and explicit-quant digest against the real state layer with a faked adapter. |
| Build verified   | ✅     | `tsc` build and `--noEmit` typecheck both clean under strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.                                              |
| Security checked | ✅     | All model/registry strings `stripControl`'d before display; resolver re-validates ids and rejects `..`; typed errors; no secrets; no injection surface.                |
| Coverage         | ✅     | Both failure paths (pull, health) assert prior-active preservation; success path asserts full handle inheritance.                                                      |

---

## Action Items

| #   | Priority | Issue                                                                                                              | Target              |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| 1   | Minor    | Confirmation prints outside-lock `current.endpoint`; return and print the inside-lock endpoint                     | backlog             |
| 2   | Minor    | No inside-lock re-check of `active.modelId` vs. the no-op decision (last-writer-wins) — document or re-check       | backlog             |
| 3   | Minor    | No disk/fit advisory when repointing to a materially larger model; success may hide an inference-time load failure | backlog / `migrate` |
| 4   | Nit      | Status/confirmation messages routed to stdout rather than stderr (cross-command consistency call)                  | backlog             |
| 5   | Nit      | "Preparing …" prints even when `pull` is an idempotent no-op                                                       | backlog             |
| 6   | Nit      | Health check cannot detect a dead-but-recorded daemon before repointing (cross-command reconciliation)             | backlog             |
