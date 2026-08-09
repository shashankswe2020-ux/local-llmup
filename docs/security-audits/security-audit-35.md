# Security Audit Report #35

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Final security audit after U2b Phase 2 fixes: typed handled lifecycle UI fault sentinel, CLI duplicate-error suppression, review/picker/pre-start/in-flight renderer failure matrix, advisory progress fallback, prepare/execute/result seams for up/switch/down, command-scoped `--yes`, switch picker filtering, and approved unavailable migrate screen
> **Dependencies:** 6 known development-toolchain vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate); 0 production vulnerabilities (`npm audit --omit=dev`)
> **Test Coverage:** 1,369 tests passing; all gates (typecheck, lint, build) pass; real llama.cpp up/down/stop seam smoke test passed

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 0     |
| Info     | 0     |

**Verdict: GO.** No production-reachable Critical, High, Medium, or Low security issue remains in the current uncommitted lifecycle UI changes. All U2b phase features have been reviewed and securely implemented. The six `npm audit` advisories are confined to Vitest/Vite development tooling and do not affect the published runtime graph.

---

## Findings

No Critical, High, Medium, Low, or Informational security vulnerabilities were identified in this final audit.

### Input Handling ✓

- **CLI argument validation:** All positional and option arguments validated against allowlists (`CAPABILITIES`, `BACKEND_NAMES`) or type-checked (port as integer 1..65535)
- **Model name resolution:** User input resolved through the model resolver with explicit error on unknown/ambiguous matches
- **Terminal output sanitization:** All user-facing strings pass through `stripControl()` before reaching stderr/stdout, removing ANSI escape sequences, control characters (C0/C1/DEL), and BiDi overrides (Trojan-Source class). Test coverage confirms bell character (0x07) is stripped.
- **Error messages:** Typed error classes provide machine-readable codes without exposing internal stack traces; all error text is sanitized before output

### Authentication & Authorization ✓

- **Process ownership verification:** Before stopping an owned server, the `captureLiveProcessIdentity()` function verifies that the stored PID, executable path, and start timestamp still match the live process. A mismatch fails the stop operation, preventing accidental killing of unrelated processes.
- **State mutation serialization:** All state writes occur under the state lock (`withLock()`), preventing concurrent modifications by parallel `up`/`down`/`switch`/`migrate` invocations
- **Confirmation drift detection:** Prepared confirmation snapshots are captured before domain execution and revalidated under the lock; any drift (process identity change, state mutation, etc.) aborts the operation with an explicit error

### Data Protection ✓

- **Sensitive file exclusion:** `.gitignore` correctly excludes `.env`, `.env.*`, `*.log`, and the `node_modules/` directory
- **Secret audit:** No `console.log()` or `console.error()` calls in production source code; no `.env` or `tokens.json` files found in git history
- **Loopback-only binding:** Verified in test suite that `up` binds servers to `127.0.0.1`, never `0.0.0.0`; all adapters (Ollama, llama.cpp, MLX) enforce loopback binding by default
- **State file atomicity:** `writeState()` uses atomic writes with lock acquisition before mutation
- **Memory store gates:** `migrate` command captures source and target store identities before any filesystem access; production gate remains fail-closed (throws `MemoryError` before invoking `loadSourceMemory` or `planMigration`)

### Infrastructure ✓

- **Endpoint validation:** All endpoint URLs are parsed and stripped before output; custom query parameters in endpoints are ignored by adapter implementations (e.g., `http://127.0.0.1:8080?ignored=yes` extracts base URL)
- **Owned process cleanup:** Backward-compatible stop-before-replace logic ensures owned processes are always cleaned up under the lock; rollback logic restores state if stop fails
- **Process identity trusted anchor:** `processExecutable`, `processStartedAt`, and listener address act as an immutable anchor to verify ownership across phases
- **Advisory observer pattern:** Execution progress observers are decoupled from domain logic; observer exceptions are caught and swallowed, preventing user-interface render failures from interrupting core business logic (lock acquisition, state write, process stop, etc.)

### Error Handling & UI Fault Isolation ✓

- **Typed error hierarchy:** `LocalLlmupError` base class with subclasses for validation, backend, memory, catalog, and state errors provides stable machine-readable codes
- **Duplicate error suppression:** When a renderer throws during review or progress, a `LifecycleUiHandledError` is thrown from the TUI entry point. The CLI catches this by name and sets exit code 1 without re-emitting the error message, preventing duplicate error output.
- **Renderer initialization fallback:** When TUI mode is implicit (not explicitly requested), a renderer init failure prints a diagnostic and continues in plain mode. When TUI mode is explicit (`--tui`), the failure is fatal (fail-closed).
- **Pre-execution failure isolation:** Renderer failures before domain execution (preparation, review, picker) prevent any state mutation or process change
- **In-flight renderer resilience:** Progress observer faults do not interrupt acquisition, verification, state write, or process cleanup phases
- **Terminal input bounds:** Accessible mode uses `createBoundedCookedLineReader()` with a 16-character input limit to prevent DoS via unbounded input

### Command-Scoped Flags ✓

- **`--yes` command scoping:** The flag is registered only on `down` and `migrate`, with additional validation that on `migrate` it is accepted only when paired with `--move`. Attempts to use `--yes` without `--move` are rejected with a clear diagnostic.
- **Drift protection retention:** Even with `--yes`, the prepared confirmation snapshot is revalidated under the lock, ensuring that process identity and state have not changed since the user approved the operation.
- **Confirmation default:** Interactive review screens default to "Cancel" to prevent accidental destructive operations when the user simply presses Enter without selecting an option.

### Switch Picker Filtering ✓

- **Backend capability restriction:** The `filterSwitchModelChoices()` function checks the active backend; if it is not Ollama (e.g., llama.cpp or MLX single-model server), an empty list is returned, directing the user away from impossible in-place switch targets.
- **Active model exclusion:** Available switch targets exclude the currently active model, preventing no-op switches and reducing user confusion.
- **Multi-model daemon assumption:** Ollama supports multiple pulled models and dynamic switching; llama.cpp, MLX, and LM Studio are single-model servers and require `up` for model replacement.

### Approved Unavailable Migrate Screen ✓

- **Interactive migration gate:** When migrate is invoked in interactive mode without `--from` and `--to` flags, `runInteractiveMigrateUnavailable()` is called, which:
  1. Displays a review screen stating "Migration is unavailable on this runtime"
  2. Explains the node.js descriptor-relative filesystem limitation
  3. Instructs the user that migration remains fail-closed
  4. Throws a `MemoryError` after the user acknowledges
- **Production readiness:** The production migration capability gate from security-audit-32 remains fail-closed; no memory store is accessed or mutated before the error is thrown.

### Dependency Security ✓

- **Development toolchain:** `npm audit` reports 6 advisories (2 critical, 1 high, 3 moderate) all confined to Vitest/Vite/esbuild development dependencies
- **Production graph:** `npm audit --omit=dev` reports 0 advisories; the published npm package ships only `dist/` and `data/`, excluding development tooling
- **Known vulnerabilities:** All six advisories are known issues in the Vitest/Vite ecosystem with fixes available via `npm audit fix --force` (at the cost of breaking semver); they do not affect runtime behavior or security of the published package

---

## Positive Observations

- **Comprehensive error isolation:** The three-phase execution model (prepare, execute, result) cleanly separates concerns and makes renderer failures/user cancellations fail-closed without risking process/state mutations.
- **Observer-driven progress:** Progress listeners are truly advisory; failures in rendering or progress capture never interrupt the authoritative domain execution path, ensuring reliability and security are not traded for UI convenience.
- **Fail-safe defaults:** Interactive prompts default to cancellation (Cancel is the Enter-default action), rendering confirmation screens never requires active user choice to be safe.
- **Loopback-only guarantee:** All backend adapters respect loopback binding by default and in production code; tests validate this invariant for Ollama, llama.cpp, and MLX.
- **Owned process identity anchor:** Storing and verifying `processExecutable`, `processStartedAt`, and listener address creates an immutable anchor that survives process state changes and prevents PID recycling attacks.
- **Sanitization depth:** Control character, ANSI, and BiDi/zero-width character removal covers the full OWASP list and protects against Trojan-Source-style injection attacks; test coverage confirms real examples (bell character) are stripped.
- **Drift detection:** Revalidation under the lock before every state mutation, combined with confirmation snapshot comparison, provides a robust defense against TOCTOU races and unexpected state changes.
- **Command-scoped authority:** Destructive operations (`--yes`) are carefully scoped to the commands where they make sense, with additional validation rules that prevent accidental misuse.
- **Clean dependencies:** Production npm graph is free of known vulnerabilities; the published package is minimal and audit-clean.
- **Test suite breadth:** 1,369 tests covering unit, integration, and e2e scenarios; real llama.cpp up/down smoke test validates production paths.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| —   | —        | None    | No security action required; final audit pass. All U2b features securely implemented. Ready for release. |

---

## Verification Summary

✓ Full test suite: 1,369 tests passing
✓ Type checking: `npm run typecheck` clean
✓ Linting: `npm run lint` clean
✓ Build: `npm run build` succeeds
✓ Production advisories: 0 under `npm audit --omit=dev`
✓ Real llama.cpp up/down smoke test: Passed
✓ No console.log/error in production source
✓ No secrets in git history
✓ Input validation: All CLI arguments validated
✓ Output sanitization: All terminal text sanitized
✓ Error isolation: Renderer faults fail-closed
✓ Drift protection: Active under --yes
✓ Process identity verification: Confirmed
✓ Loopback-only binding: Verified
