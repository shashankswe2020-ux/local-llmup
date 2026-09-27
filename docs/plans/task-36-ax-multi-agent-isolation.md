# Implementation Plan: Multi-Agent Orchestration with Google AX Isolation

> Status: **Draft — blocking decisions A1–A9 need sign-off; spike X0 must pass before X4**
> Related: [task-32-chat-panel-workspace-experience.md](./task-32-chat-panel-workspace-experience.md), [gui-and-harness-adapters.md](../specs/gui-and-harness-adapters.md)
> External: [google/ax](https://github.com/google/ax). Apache-2.0, Go, v0.3.1, **pre-stable: "major breaking changes prior to a stable release"**.
> Last updated: 2026-09-27

## Overview

Run a **crew** of library agents (`Kind::Agent`, with their skills and MCP
connectors) as a coordinated job. Each agent runs in its own isolated
environment, and the coordinator merges the results. Isolation is pluggable:

| Provider | Isolation | Requires | Phase |
| --- | --- | --- | --- |
| `local` (default) | Per-agent working dir, scrubbed env (`minimal_env`), per-agent tool approval, separate MCP connections | Nothing new | 1 |
| `ax` | AX **Task** sandbox on Agent Substrate, with CPU/memory limits, a pre-wired **Workspace** (git, MCP servers, skills), a **Model** resource, and suspend/resume | Kubernetes + Agent Substrate + `ax` CLI | 2 |

What AX provides, per its README:
- Declarative `ax.io/v1alpha1` manifests: `Task`, `Workspace` and `Model`.
- A gRPC control plane driven by a kubectl-shaped CLI: `apply`, `get`, `watch`, `describe`, `delete`, `suspend`, `resume`, `ssh`.
- Sandboxing through Agent Substrate.

Everything else below is a hypothesis for spike X0.

**Tension with project principles.** local-llmup is local-first and loopback-only,
while AX runs in a cluster. The plan only allows a *local* cluster by default,
and treats any path that would expose the local model server as a blocking
decision (A3).

## Blocking decisions

| # | Decision | Blocks | Proposed default | Status |
| --- | --- | --- | --- | --- |
| A1 | Integration surface: drive the `ax` CLI as a subprocess, or a gRPC client (tonic/prost — new deps and a proto pin) | X4 | **CLI subprocess** through the existing injectable `CommandRunner`; no new runtime deps | ⏳ |
| A2 | Cluster locality | X4 | Only a context whose control plane resolves to loopback (kind/k3d/minikube on this host). Remote clusters need `--allow-remote-cluster` plus a confirmation, because goals, workspaces and repo URLs leave the machine | ⏳ |
| A3 | How sandboxed agents reach a model. AX's `Model` resource example uses `provider: google`; whether it accepts an OpenAI-compatible or local endpoint is **unknown**. Reaching llmup's local server from a pod would require a non-loopback bind, which is forbidden by default. | X4 | X0 answers it. Options: (a) a per-task authenticated tunnel with the server still on loopback; (b) cloud `Model` only for AX tasks; (c) no AX until (a) is possible. **Never** bind `0.0.0.0` | ⏳ |
| A4 | Crew topologies in v1 | X1 | `sequential` and `fan-out/fan-in` (a coordinator merges); `supervisor` loops deferred | ⏳ |
| A5 | Crew definition format | X1 | JSON file `crew.json` (typed serde, `deny_unknown_fields`, ≤ 64 KiB) that references library agent ids; no inline secrets | ⏳ |
| A6 | Manifest encoding. YAML is a JSON superset, so emitting JSON avoids a `serde_yaml` dep, if `ax apply -f -` accepts JSON. | X4 | JSON; confirm in X0, else ask before adding a YAML dep | ⏳ |
| A7 | Secrets | X4 | Only Kubernetes Secret *references* go in manifests; never inline keys. Existing `redaction.rs` runs on all captured output | ⏳ |
| A8 | Version pinning | X4/X7 | Accept only a pinned AX minor version (`v0.3.x`); `doctor` and `crew run` refuse others with an upgrade note | ⏳ |
| A9 | Cost and runaway guards | X3 | Per crew: max agents (8), per-agent wall clock (10 min), total budget (30 min), max turns per agent; idle AX tasks are suspended, and all tasks are deleted on cancel | ⏳ |

## Architecture decisions

- **Pure orchestration core.**
  - `Crew`, `AgentRole`, `Topology`, `CrewPlan` and `Budget`, with pure functions: validate, schedule (a DAG with a deterministic order), and merge results.
  - It lives in `crates/llmup-runtime/src/crew.rs`, next to `agent.rs` and `library.rs`.
- **Isolation trait:**
  ```rust
  #[async_trait]
  pub trait IsolationProvider: Send + Sync {
      fn name(&self) -> &'static str;
      async fn preflight(&self, cancel: &CancellationToken) -> Result<Preflight, IsolationError>;
      async fn launch(&self, role: &AgentRole, input: &RoleInput, cancel: &CancellationToken) -> Result<RunHandle, IsolationError>;
      async fn events(&self, run: &RunHandle, sink: &mut dyn EventSink, cancel: &CancellationToken) -> Result<RoleOutput, IsolationError>;
      async fn suspend(&self, run: &RunHandle) -> Result<(), IsolationError>;
      async fn resume(&self, run: &RunHandle) -> Result<(), IsolationError>;
      async fn teardown(&self, run: &RunHandle) -> Result<(), IsolationError>; // idempotent
  }
  ```
- **Local provider is honest about limits.**
  - With `unsafe_code = forbid` there is no `pre_exec`/`setrlimit`, so the local provider offers only filesystem/env/tool isolation, **not** CPU/memory limits.
  - The UI and docs say so, and point to `ax` for resource limits.
- **Agent-to-agent trust.**
  - One agent's output is **untrusted input** to the next. The coordinator wraps it as quoted data, and tool approval policies apply per agent, so a prompt injection cannot borrow another agent's grants.
- **Events** reuse `AgentEvent`/`ToolEvent`, adding `role` and `isolation` fields. The GUI streams them over the existing SSE path.

## Dependency graph

```
X0 spike (real local kind + Substrate + AX v0.3.x; ADR + fixtures)
{A4,A5} ► X1 crew core (pure)
X1 ► X2 IsolationProvider trait + LocalProcessIsolation
{X1,X2,A9} ► X3 orchestrator engine (budgets, cancel, merge, events)
        X3 ► X5 CLI `llmup crew` (local isolation)
        X3 ► X6 GUI crew panel
── Checkpoint A: multi-agent orchestration with local isolation shippable ──
{X0 pass, A1–A3, A6–A8} ► X4 AX provider (manifest builder + ax CLI wrapper)
        X4 ► X7 doctor AX checks
{X5,X6,X4?} ► X8 docs + threat model + security audit
```

Checkpoint A does not depend on AX. If X0 shows A3 cannot be met without
exposing the model server, stop after Checkpoint A.

## Cross-cutting conventions

- Never run a real cluster, `ax` or Substrate in tests. The injected `CommandRunner` replays X0 fixtures, covering `ax version`, `ax get task -o json`-style outputs, and errors.
- Manifests are built from typed structs, and golden JSON files are asserted byte for byte.
- Cancellation always reaches `teardown`, verified in tests.
- Gates: fmt, strict Clippy, workspace tests, `cargo native-retirement`.

## Task list

### X0 — Spike: validate AX on a local cluster (no production code)
- On a local kind cluster with Agent Substrate and AX pinned at v0.3.x, answer each question with evidence:
  1. Does `ax apply -f -` accept JSON (A6)?
  2. Which `Model` providers exist, and can a Task use an OpenAI-compatible endpoint or a tunnel back to the host loopback (A3)?
  3. How does a Task return structured output (e.g. a file in `/workspace` read via `ax ssh -- cat`, logs, or status fields)?
  4. What output format do `get` and `watch` have, and is there a machine-readable mode?
  5. What does suspend/resume do to in-flight model calls?
  6. What is the failure/phase vocabulary?
  7. How does the client authenticate to the control plane (the `ax ctx` / tunnel state in `~/.ax/tunnels`)?
- **Output:** an ADR appended here, fixtures in `crates/llmup-runtime/tests/fixtures/ax/`, and a go/no-go for X4.

### X1 — Crew core
- **Acceptance:**
  1. Validation rejects unknown agent ids, cycles, empty roles, over-budget configs and duplicate role names.
  2. Scheduling is deterministic (same crew → same order).
  3. The merge output is stable and preserves each role's attribution.
- **Files:** `crates/llmup-runtime/src/crew.rs` (new), `lib.rs`, `crates/llmup-runtime/tests/crew.rs`.
- **Verify:** `cargo test -p llmup-runtime --test crew`.

### X2 — LocalProcessIsolation
- **Do:** a per-role temp workspace under the home staging dir (secure_fs rules), `minimal_env()` only, separate MCP `Connection`s per role, and per-role `SessionGrants`.
- **Acceptance:**
  1. Role A cannot read role B's workspace; tested by path.
  2. No parent env secrets leak; tested with an injected env.
  3. Teardown removes the workspace even after a panic or cancel.
- **Files:** `crates/llmup-runtime/src/isolation.rs` (new), `crates/llmup-runtime/tests/isolation.rs`.

### X3 — Orchestrator engine
- **Do:** runs a `CrewPlan` over any `IsolationProvider`, with budgets (A9), cancellation, event streaming and result merge. Model calls go through the existing `AgentChat` and harness registry.
- **Acceptance:**
  1. A fan-out of 3 roles with a mock provider gets a merged result.
  2. Hitting a budget stops and tears down every role.
  3. The first failure policy (`fail-fast` or `continue`) is honoured.
  4. Output passed between roles is quoted as data.
- **Files:** `crates/llmup-runtime/src/crew_engine.rs` (new), tests.

### X4 — AX provider (after X0 go)
- **Do:**
  - The `AxManifest` builder maps a role to a `Task`. Its `Workspace` is built from the library skills, MCP connectors and optional git repo; its `Model` follows the A3 outcome.
  - The `AxCli` wrapper covers `version`, `apply -f -` (stdin), `get`, `watch`, `suspend`, `resume` and `delete`, with strict output parsing and bounded output.
  - A2 locality and A8 version checks run in `preflight`.
- **Acceptance:**
  1. Golden manifests for a 2-role crew.
  2. The locality check refuses a non-loopback context without the flag.
  3. The wrong AX version is refused.
  4. Cancel deletes every created Task, proven by the recorded CLI calls.
  5. No secret value ever appears in manifests or logs.
- **Files:** `crates/llmup-runtime/src/isolation_ax.rs` (new), tests + fixtures.

### X5 — CLI `llmup crew`
- **Do:** `crew run <crew.json> [--isolation local|ax] [--allow-remote-cluster] [--json]`, `crew status|logs|suspend|resume|stop <id>`. This is a new subcommand, so the COMMANDS list, help goldens and public_cli rows all change.
- **Acceptance:** goldens; exit codes (0 ok, 1 role failure, 2 usage, 130 cancelled); `--isolation ax` without AX prints an actionable preflight error.
- **Files:** `native_args.rs`, `native.rs`, `crates/llmup-cli/tests/{public_cli,crew_cli}.rs`, fixtures manifest.

### X6 — GUI crew panel
- **Do:** pick agents from the library and a topology, then run. Show per-role status, streaming events, and an isolation badge (`local`: fs/env only; `ax`: sandboxed), plus stop and suspend controls.
- **Acceptance:** API contract tests and one WebDriver journey using the local provider.

### X7 — Doctor
- **Do:** report the `ax` binary presence and version, the active context, whether the control plane is local or remote, and Substrate reachability, as reported by `ax ctx`. Anything unverifiable is reported as `unknown`.

### X8 — Docs + threat model + audit
- README "Multi-agent crews" and the isolation comparison table (limits stated honestly).
- A threat model covering data egress (A2/A3), cross-agent prompt injection, secret handling and runaway cost.
- A `docs/security-audits/` entry and CHANGELOG.
