# Security Audit Report #34

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Current uncommitted Task U2b after security-audit-33 remediation: lifecycle progress input ownership, advisory domain observers, renderer listener/cleanup fault isolation, post-commit authoritative stdout, renderer/picker fail-safe paths, switch target eligibility, command-scoped `--yes`, drift revalidation, and fail-closed interactive migration
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 0     |
| Info     | 0     |

**Verdict: GO.** No production-reachable Critical, High, or Medium issue remains in the reviewed U2b boundary. Security-audit-33 HIGH-1 and MEDIUM-1 are technically closed by the current implementation. GitHub issues #155 and #156 remain administratively open and should be closed against this audit.

---

## Findings

No Critical, High, Medium, Low, or Informational findings were identified in this re-audit.

The broader cancellation/compensation design tracked for a later task remains unimplemented, but U2b progress no longer installs an input handler, receives no `stdin` stream, enters no raw mode, and makes no cancellation claim. Ordinary terminal SIGINT behavior is therefore not intercepted by this progress presenter. A runtime probe confirmed zero raw-mode transitions and zero data listeners on the supplied input stream before, during, and after progress rendering.

The six `npm audit` advisories are confined to Vitest/Vite development tooling. The published runtime graph reports zero advisories under `npm audit --omit=dev`; the package allowlist ships only `dist` and `data`.

---

## Positive Observations

- **Security-audit-33 HIGH-1 is closed:** `LifecycleProgressScreen` has no `useInput()` hook or cancellation text, and progress rendering does not receive the lifecycle input stream. Stalled domain work no longer causes the progress presenter to consume Ctrl+C or hold the terminal in raw mode.
- **Security-audit-33 MEDIUM-1 is closed:** `executePreparedUp()`, `executePreparedSwitch()`, and `executePreparedDown()` treat progress observers as advisory and swallow observer faults. The renderer removes faulty listeners, clears listeners before teardown, and swallows post-execution unmount/cleanup faults. The authoritative formatted stdout is emitted once after successful domain execution, with no fallback re-execution path.
- Progress events now originate at actual command orchestration boundaries. Listener failures cannot interrupt acquisition, locked revalidation, rollback, state commit, or owned-process cleanup.
- Renderer initialization, picker, review, and progress-mount failures occur before domain execution. Auto mode falls back only when an explicit model can continue safely; omitted-model failures cancel without inventing a target. Explicit renderer failures remain fail-closed.
- The switch picker excludes the active model and returns no eligible targets for single-model llama.cpp/MLX backends, directing execution away from impossible in-place switch targets. `prepareSwitch()` independently enforces backend capability restrictions.
- `down --yes` bypasses only confirmation. Prepared snapshots are still revalidated under the state lock against authoritative process/listener identity, and drift fails closed. `--yes` remains registered only on `down` and `migrate`, with migration accepting it only alongside `--move`.
- Interactive migration renders only the unavailable status and throws before invoking `runMigrate()` or accessing a memory store. The production migration capability gate from security-audit-32 remains fail-closed.
- External terminal text remains sanitized and bounded; runtime endpoints remain loopback-only; owned stop/replace paths retain PID, executable, start-identity, listener, lock, and rollback protections.
- Independent verification passed: 81 test files and 1,358 tests, type checking, repository lint, build, package dry-run, and `git diff --check`. The supplied real llama.cpp up/down seam smoke is consistent with the reviewed ownership boundary.
- Sensitive environment files are ignored, no `.env`/`tokens.json` or tracked key-material history was found, and changed production source contains no `console.log`/`console.error` calls. The sole source-tree console call is a non-secret catalog bootstrap diagnostic under `scripts/`.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| —   | —        | None    | No release-blocking security action required for Task U2b; close remediated issues #155 and #156 against this audit |
