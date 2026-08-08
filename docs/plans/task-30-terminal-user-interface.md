# Implementation Plan: terminal-user-interface

> Source spec: [docs/specs/terminal-user-interface.md](../specs/terminal-user-interface.md)
> Related: [docs/specs/local-llmup.md](../specs/local-llmup.md), [docs/plans/task-plan-local-llmup.md](./task-plan-local-llmup.md)
> Status: **Draft — planning complete, awaiting human approval for dependencies and spec decisions**
> Last updated: 2026-08-08

## Overview

Deliver a command-specific interactive terminal UI that preserves local-llmup's
existing noninteractive contracts byte-for-byte unless explicitly versioned.
Implementation is phased from runtime proof to read-only surfaces, then mutating
lifecycle commands, then chat, with hard safety/performance gates at each
checkpoint.

The plan enforces these non-negotiables from the spec:

- TUI is presenter-only (no duplicated domain logic).
- Plain/JSON/piped/help/version behavior remains authoritative.
- Destructive flows require confirmation + locked snapshot revalidation.
- Terminal restoration is exact and idempotent across success, failure, signal,
  resize, and renderer faults.
- Advice commands remain deterministic and offline.

## Architecture Decisions

- Add a new TUI boundary under `src/tui/` with typed mode/capability/session/driver
  contracts; command modules remain domain orchestrators.
- Resolve UI mode before any domain side effects; lazy-import renderer only when
  visual TUI is eligible.
- Introduce controller/driver contracts per spec (`UiDriver`, `UiMode`,
  `InteractiveCommandController`) and typed progress/termination events.
- Build immutable view models from existing command results; screens render only
  view models and never access backend/state/fs dependencies.
- Treat all terminal text as untrusted; use context-aware sanitizer + bounded
  byte/grapheme/cell/frame limits.
- Add explicit lock ordering/timeout and cleanup timeout contracts so cancellation
  cannot hang indefinitely.

## Human Approval Gates (must resolve before implementation)

1. Approve runtime dependencies in spec §6.4 (Ink/React/string-width + lockfile policy).
2. Approve global flags in spec §3.1 (`--tui`, `--no-tui`, `--accessible`, `--no-color`).
3. Approve command-scoped `--yes` behavior scope (`down`, `migrate --move`).
4. Approve interactive stdout summary change for TUI chat session end (§5.6).
5. Approve performance/package gates in §9 as release blockers.

## Dependency Graph

```text
U0a policy + baselines
  -> U0b dependency/runtime proof + lazy-import safety
     -> U1a mode selection + capability predicates + reason codes
        -> U1b tui session lifecycle + restoration + sanitizer bounds
           -> U1c controller/driver abstractions + view-model builders
              -> U1d read-only command screens (recommend/can-run/doctor/catalog/ls)
                 -> U2a confirmation snapshot hashing + lock/revalidation framework
                    -> U2b lifecycle screens (up/switch/down/migrate)
                       -> U2c cancellation/compensation matrix hardening
                          -> U3a chat screen/editor/limits + memory-warning behavior
                             -> U3b performance/package hard gates + cross-platform smoke
                                -> U4 benchmark/telemetry screens (only after those commands are approved)
```

## Phase Plan

### Phase U0 — Policy, Baselines, and Runtime Proof

#### Task U0a: Freeze noninteractive compatibility baselines ✅ DONE (2026-08-08)

**Description:** Establish golden fixtures for plain/JSON/piped/help/version outputs,
exit codes, and stdout/stderr routing before any TUI refactor.

**Acceptance criteria:**

- [x] Golden fixtures exist for all implemented commands in plain and JSON modes.
- [x] Fixture harness pins locale/timezone/TERM and preserves exact final newlines; volatile version platform/Node tokens are explicitly normalized.
- [x] Regression test proves the pre-TUI CLI has no eager TUI import, and a registry-derived manifest requires one plain fixture per implemented command.

**Evidence:** `tests/noninteractive-compat.test.ts`, `tests/fixtures/noninteractive/`,
`tests/cli-noninteractive-contract.test.ts`, and exact output assertions in every
`tests/commands/*.test.ts` command suite. The CLI matrix freezes dispatch,
stdout/stderr error routing, special exit codes, and piped-chat EOF behavior.
Focused verification: 12 files / 192 tests passed. Full verification: 61 files /
1,074 tests, build, typecheck, and lint passed.

**Verification command:**

- `npm test -- --reporter=dot tests/commands tests/cli.test.ts`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `tests/commands/*`
- `tests/cli.test.ts`
- `tests/workflows/*` (if registry/meta coverage expands)

**Dependencies:** None

---

#### Task U0b: Renderer/dependency spike and enforcement

**Description:** Validate Ink runtime viability on Node 18/20/22/24 and establish CI
policy gates for dependency provenance, native/script checks, and package budgets.

**Acceptance criteria:**

- [ ] Spike validates renderer boot/teardown with injected streams and cleanup.
- [ ] CI gate fails on disallowed runtime dependency graph changes.
- [ ] Pack/install size checks are automated with hard thresholds from spec §9.

**Verification command:**

- `npm test -- --reporter=dot tests/shipping tests/workflows`
- `npm pack --dry-run`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `package.json`
- `docs/plans/task-30-terminal-user-interface.md` (status updates)
- `.github/workflows/*`
- `tests/workflows/*`

**Dependencies:** U0a + human dependency approval

### Checkpoint U0

**Done criteria:**

- [ ] Noninteractive contracts frozen and green.
- [ ] Dependency/runtime policy gates active.
- [ ] No renderer import on plain/JSON/ineligible paths.

---

### Phase U1 — Foundation + Read-Only Commands

#### Task U1a: Mode selection engine and fail-closed reason codes

**Description:** Implement mode resolution for `plain|json|tui|accessible` including
full precedence matrix and explicit ineligibility reason enum.

**Acceptance criteria:**

- [ ] Every row in spec normative mode table is test-covered.
- [ ] `--tui` incompatibility fails pre-domain with stable reason code.
- [ ] `--accessible` uses independent predicate (>=40x10, TTY, non-CI/non-dumb).

**Verification command:**

- `npm test -- --reporter=dot tests/tui/capabilities.test.ts tests/cli.test.ts`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/capabilities.ts`
- `src/cli.ts`
- `tests/tui/capabilities.test.ts`
- `tests/cli.test.ts`

**Dependencies:** U0b

---

#### Task U1b: TUI session lifecycle and sanitizer primitives

**Description:** Build `TuiSession` lifecycle (mount/unmount, cursor/raw/listeners,
resize debounce) and terminal-safe sanitizer with bounded limits.

**Acceptance criteria:**

- [ ] Restoration is idempotent and runs once on success/error/signal/renderer fault.
- [ ] Sanitizer passes adversarial fixture corpus (ANSI/OSC/CR/bidi/NUL/surrogates).
- [ ] Bounds enforced: cell/detail/chat/frame/message caps from spec §7.4.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/session.test.ts tests/tui/sanitize.test.ts`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/session.ts`
- `src/tui/sanitize.ts`
- `src/tui/keys.ts`
- `tests/tui/session.test.ts`
- `tests/tui/sanitize.test.ts`

**Dependencies:** U1a

---

#### Task U1c: Controller/driver contracts + command view-model adapters

**Description:** Introduce typed UI driver/controller interfaces and pure
view-model builders for read-only command results.

**Acceptance criteria:**

- [ ] UI driver cannot access backend/state/fs dependencies by type shape.
- [ ] Existing result formatters remain plain/JSON source of truth.
- [ ] `complete(screen, viewModel)` accepts only command-specific mapped view models.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/controller-contract.test.ts`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/presenter.ts`
- `src/tui/types.ts`
- `src/commands/*` (additive adapter wiring)
- `tests/tui/controller-contract.test.ts`

**Dependencies:** U1b

---

#### Task U1d: Read-only screens rollout

**Description:** Ship TUI screens for `recommend`, `can-run`, `doctor`, `catalog`,
`ls` with keyboard navigation/help/search/filter and accessible mode parity.

**Acceptance criteria:**

- [ ] No read-only key path triggers mutation/network beyond existing explicit flags.
- [ ] Unknown/honesty-gated values are shown as unknown with evidence.
- [ ] Visible action surface is complete (no hidden key-only action).

**Verification command:**

- `npm test -- --reporter=dot tests/tui/screens/read-only/*.test.ts tests/commands/*`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/screens/recommend.tsx`
- `src/tui/screens/can-run.tsx`
- `src/tui/screens/doctor.tsx`
- `src/tui/screens/catalog.tsx`
- `src/tui/screens/ls.tsx`
- `tests/tui/screens/read-only/*`

**Dependencies:** U1c

### Checkpoint U1

**Done criteria:**

- [ ] Read-only command TUIs shipped with accessibility path.
- [ ] Noninteractive contracts remain byte-stable.
- [ ] Terminal safety suite green.

---

### Phase U2 — Lifecycle Commands and Safety Hardening

#### Task U2a: Confirmation snapshots + locked revalidation framework

**Description:** Implement snapshot object hashing and lock-time revalidation
framework for destructive/replaceable operations.

**Acceptance criteria:**

- [ ] Snapshot hashes are RFC-8785 canonical JSON SHA-256 lowercase hex.
- [ ] Drift after confirm fails closed and returns to fresh review.
- [ ] `--yes` never bypasses drift protection.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/snapshots.test.ts tests/state/state.test.ts tests/memory/*`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/snapshots.ts`
- `src/commands/down.ts`
- `src/commands/switch.ts`
- `src/commands/migrate.ts`
- `src/commands/up.ts`
- `tests/tui/snapshots.test.ts`

**Dependencies:** U1d

---

#### Task U2b: Lifecycle screens (`up`, `switch`, `down`, `migrate`)

**Description:** Add staged review/progress/confirmation screens while preserving
existing domain stage order and side-effect semantics.

**Acceptance criteria:**

- [ ] `up` stage order matches spec and existing orchestration.
- [ ] `down` default action is cancel; attached/owned consequences explicit.
- [ ] `migrate` preview is pure/read-only; materialization only after acceptance.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/screens/lifecycle/*.test.ts tests/commands/{up,down,switch,migrate}.test.ts`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/screens/up.tsx`
- `src/tui/screens/switch.tsx`
- `src/tui/screens/down.tsx`
- `src/tui/screens/migrate.tsx`
- `tests/tui/screens/lifecycle/*`

**Dependencies:** U2a

---

#### Task U2c: Cancellation/compensation model + lock/cleanup timeouts

**Description:** Enforce typed termination effects, bounded cleanup timeout,
lock-order policy, and signal semantics (`129/130/143`) after cleanup.

**Acceptance criteria:**

- [ ] Cleanup timeout and lock timeout are explicit constants and test-covered.
- [ ] Repeated Ctrl+C never bypasses ownership checks or forces unsafe exit.
- [ ] Partial completion states report exact remediation, not generic success.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/cancellation.test.ts tests/commands/*`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/presenter.ts`
- `src/tui/session.ts`
- `src/commands/{up,down,switch,migrate}.ts`
- `tests/tui/cancellation.test.ts`

**Dependencies:** U2b

### Checkpoint U2

**Done criteria:**

- [ ] Mutating command TUIs shipped with snapshot revalidation.
- [ ] Cancellation/cleanup and race suites green.
- [ ] No duplicate domain execution across renderer faults.

---

### Phase U3 — Chat TUI + Release Hardening

#### Task U3a: Chat interaction model and limits

**Description:** Implement chat screen/editor, request-in-progress behavior,
response/draft bounds, and memory-capture warning semantics.

**Acceptance criteria:**

- [ ] Draft limits enforced (32 KiB, 8192 graphemes, 256 lines).
- [ ] No fake token streaming; pending-state explicit.
- [ ] Auto TUI chat emits session-end summary only; `--no-tui` preserves transcript.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/screens/chat.test.ts tests/commands/chat.test.ts`
- `npm run typecheck && npm run build`

**Files likely touched:**

- `src/tui/screens/chat.tsx`
- `src/commands/chat.ts`
- `tests/tui/screens/chat.test.ts`
- `tests/commands/chat.test.ts`

**Dependencies:** U2c

---

#### Task U3b: Performance/package gates + real terminal smoke

**Description:** Add automated budget checks and required smoke matrix across
macOS/Linux/Windows terminal environments.

**Acceptance criteria:**

- [ ] Plain/JSON cold-start regression and interactive latency budgets pass.
- [ ] Tarball/install-size gates pass with committed lockfile.
- [ ] Required smoke jobs prove no stuck raw mode/hidden cursor/orphan process.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/perf/*.test.ts tests/shipping`
- `npm run typecheck && npm run lint && npm run build && npm pack --dry-run`

**Files likely touched:**

- `tests/tui/perf/*`
- `.github/workflows/*`
- `docs/specs/terminal-user-interface.md` (status + evidence links)

**Dependencies:** U3a

### Checkpoint U3 (Release Candidate)

**Done criteria:**

- [ ] U0/U1/U2/U3 acceptance criteria all green.
- [ ] Code review: no unresolved Critical/Important.
- [ ] Security audit: no unresolved Critical/High/Medium.

---

### Phase U4 — Future Commands (Gated)

#### Task U4a: Benchmark screen (only after benchmark command approval)

**Acceptance criteria:**

- [ ] Quiet-window barrier enforced; no render callback inside measured interval.
- [ ] JSON/protocol behavior unchanged.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/screens/benchmark.test.ts`
- `npm run typecheck && npm run build`

**Dependencies:** benchmark command acceptance + U3b

---

#### Task U4b: Telemetry screen (only after telemetry command approval)

**Acceptance criteria:**

- [ ] TUI telemetry screen emits no events/network requests.
- [ ] On/off disclosures and retention messaging match approved contract.

**Verification command:**

- `npm test -- --reporter=dot tests/tui/screens/telemetry.test.ts`
- `npm run typecheck && npm run build`

**Dependencies:** telemetry command acceptance + U3b

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Mode precedence regressions break scripts | High | Freeze golden compatibility in U0a and gate every mode-table row in U1a. |
| Renderer fault triggers duplicate side effects | High | One-shot controller execution guard + lifecycle fault-injection suite in U2c. |
| Cancellation hangs indefinitely | High | Add explicit cleanup timeout and lock timeout contracts with deterministic outcomes in U2c. |
| Snapshot drift corrupts destructive actions | High | Post-confirm + lock-time revalidation, fail-closed drift path in U2a. |
| Terminal injection/spoofing | High | Context-aware sanitizer + adversarial fixtures + strict bounds in U1b. |
| Dependency bloat/perf regression | Medium | Runtime policy gates, lazy import checks, tarball/install/cold-start budgets in U0b/U3b. |
| Cross-platform terminal divergence | Medium | Required smoke matrix across ConPTY/tmux/POSIX terminals in U3b. |

## Files to Deliver (target end state)

- `src/tui/capabilities.ts`
- `src/tui/session.ts`
- `src/tui/presenter.ts`
- `src/tui/theme.ts`
- `src/tui/keys.ts`
- `src/tui/sanitize.ts`
- `src/tui/components/*`
- `src/tui/screens/{recommend,can-run,doctor,catalog,up,chat,ls,switch,down,migrate}.tsx`
- `tests/tui/**/*`
- updates in `src/cli.ts` and command modules for mode wiring only
- workflow/package/perf gates under `.github/workflows/*` and `tests/workflows/*`

## Sub-agent Review Inputs Applied

- Architecture review applied: strict presenter/domain split, one-shot execution,
  mode-matrix gate, progressive phase ordering.
- Security audit applied: added lock timeout/cleanup timeout, reason-code
  requirement, argv-safe command handoff guard, and dependency policy blockers.
- Test strategy review applied: MVP phase matrix, deterministic transcript/golden
  strategy, performance/package gate sequencing, and smoke split.
