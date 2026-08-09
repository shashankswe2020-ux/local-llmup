# Security Audit Report #33

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Current uncommitted Task U2b lifecycle review/progress UI, accessible input, prepared `up`/`switch`/`down` execution, command-scoped `--yes`, drift refresh/fail-closed behavior, lazy renderer routing, and unavailable interactive migration
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 1     |
| Medium   | 1     |
| Low      | 0     |
| Info     | 0     |

**Verdict: BLOCKED.** The prepared-command and drift boundaries prevent an unreviewed server replacement or stop, and migration remains inaccessible before store reads. However, the production progress screen deliberately consumes terminal input while implementing no cancellation, so a hung acquisition/start/stop owns the raw terminal indefinitely. Renderer faults can also turn a successfully committed lifecycle mutation into an apparent command failure, inviting a duplicate retry.

---

## Findings

### [HIGH-1] Progress mode captures Ctrl+C but never requests cancellation

- **Location:** `src/tui/screens/lifecycle.tsx:85-93`, `src/tui/lifecycle-renderer.tsx:140-145`, `src/tui/lifecycle-entry.ts:467`, `src/tui/lifecycle-entry.ts:515`, `src/tui/lifecycle-entry.ts:281`
- **Description:** `LifecycleProgressScreen` installs an empty `useInput()` handler and advertises “Ctrl+C requests safe cancellation.” The Ink renderer is mounted with `exitOnCtrlC: false`, but no `AbortController`, cancellation callback, signal forwarding, or terminal-restoration transition exists. Once progress starts, raw-mode Ctrl+C is consumed as input rather than becoming SIGINT, and `up`, `switch`, or `down` waits directly for the backend operation. This concretely realizes the unresolved cancellation risk previously tracked in issue #91.
- **Impact:** A hung or malicious local backend, stalled download, readiness probe, or stop operation can hold the terminal in raw interactive mode indefinitely and continue consuming disk, network, process, or lock resources. The operator must terminate the process out-of-band; abrupt termination can bypass ownership-safe rollback and leave partial artifacts or runtime state requiring manual recovery.
- **Proof of concept:** Start interactive `up` against an adapter whose `pull()` or `waitUntilReady()` promise never settles. After the progress screen mounts, press Ctrl+C. Ink receives the input because raw mode is active, `exitOnCtrlC` is disabled, the empty handler does nothing, and the awaited command promise remains pending. The advertised cancellation and ordinary terminal interrupt both fail.
- **Recommendation:** Wire progress input to a command-scoped `AbortController`, pass its signal through every acquisition/readiness/stop boundary, restore terminal mode immediately on cancellation, and bound cleanup with a deterministic timeout and ownership-safe escalation. Do not claim cancellation until the callback is live. For example:

  ```ts
  const controller = new AbortController();
  const progress = mountLifecycleProgress({
    ...options,
    onCancel: () => controller.abort(new CancellationError("cancelled by user")),
  });
  try {
    return await executePrepared(prepared, { signal: controller.signal });
  } finally {
    progress.unmount();
  }
  ```

  Add pseudo-TTY tests for Ctrl+C during pull, readiness, locked stop, cleanup timeout, and renderer failure; assert immediate raw-mode restoration, bounded cleanup, lock release, and an explicit partial-effect result when rollback cannot be completed.

### [MEDIUM-1] Renderer faults can report failure after a committed lifecycle mutation

- **Location:** `src/tui/lifecycle-entry.ts:467-482`, `src/tui/lifecycle-entry.ts:515-528`, `src/tui/lifecycle-entry.ts:281-292`, `src/tui/lifecycle-renderer.tsx:54-57`, `src/tui/lifecycle-renderer.tsx:145-160`
- **Description:** Each controller awaits `deps.execute(prepared)` and then performs progress emissions, final output, and `progress.unmount()` in the same error-propagating frame. `emit()` calls renderer listeners without fault isolation, and `safelyUnmount()` calls both Ink cleanup methods without preserving the already-completed domain result. A listener, terminal write, unmount, or cleanup failure after command commit therefore escapes to the CLI catch path as a command failure. There is no post-domain `renderer_runtime` fallback that restores the terminal and emits the authoritative plain result exactly once.
- **Impact:** A successful `up` can commit the new active server and then exit non-zero before its final result is shown. An operator or automation retrying the apparent failure can make the newly started server the replacement target, stop it, and repeat acquisition/startup. This causes avoidable process churn, duplicate external mutation, and temporary loss of service. Similar ambiguity affects committed `switch` and `down` actions.
- **Recommendation:** Separate domain outcome from renderer outcome. Once `executePrepared*()` resolves, never let progress or cleanup faults rewrite it. Restore/unmount in guarded cleanup, emit one stable `renderer_runtime` notice, and print the already-computed plain result once. For example:

  ```ts
  const result = await deps.execute(prepared);
  try {
    progress?.emit(completedItem(result));
  } catch {
    deps.writeStderr(
      "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
    );
  } finally {
    try {
      progress?.unmount();
    } catch {
      // Preserve the authoritative completed domain outcome.
    }
  }
  deps.writeStdout(deps.format(result));
  return { type: "completed", result };
  ```

  Add synchronized regressions for listener failure immediately after execution, terminal-write failure, `unmount()` failure, and `cleanup()` failure. Assert one execution, no fallback re-execution, restored raw mode, and exactly one authoritative result.

---

## Positive Observations

- Prepared `down` revalidates state plus authoritative listener PID/executable/start identity under the state lock before clearing state or signaling a process. Interactive drift returns to a fresh review; `down --yes` retains the same fail-closed revalidation and does not reuse stale consent.
- Prepared `up` and `switch` retain validated canonical catalog targets, recapture active listener identity under lock, and reject drift before server replacement or state commit. Weight acquisition can precede locked revalidation, but the acquired target itself is the exact reviewed canonical target; no changed runtime is stopped or committed without a fresh review.
- Confirmation snapshots reject unsafe canonical IDs, traversal segments, non-loopback endpoints, incoherent operation/target counts, and incomplete runtime identity. Picker choices are independently bounded, validated, unique, and immutable.
- Review titles, evidence lines, labels, progress fields, and visual targets are terminal-sanitized and bounded. Accessible confirmation uses cooked input, a strict numbered acceptance value, bounded buffering, EOF/empty-input cancellation, and no raw-mode transition.
- `--yes` is command-scoped: runtime probes confirmed that `up`, `switch`, and `recommend` reject it as unknown; `migrate --yes` is rejected unless `--move` is present. `down --yes` skips only the prompt and retains drift protection.
- Interactive migration displays only the unavailable screen and then throws. Plain production migration resolves catalog IDs and derived store names but fails the `supportsSecureFilesystem: false` capability gate before source/target store capture, metadata reads, planning, locking, mutation, or deletion.
- Visual lifecycle code is lazy-loaded only for TUI mode. Renderer import and progress-mount failures before execution report that no action occurred and do not fall back into a second command execution path.
- The supplied verification reports 1,358 passing tests and a real llama.cpp up/down seam smoke. Production dependencies have zero known advisories. Sensitive environment files are ignored, no `.env`/`tokens.json` history was found, and changed production source contains no `console.log`/`console.error` calls.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| 1 | High | Progress mode consumes Ctrl+C without cancellation | Wire typed abort through command/backend phases, restore immediately, and bound cleanup/escalation |
| 2 | Medium | Renderer faults can rewrite a completed mutation as failure | Isolate post-domain rendering, preserve the result, restore safely, and never re-execute |
