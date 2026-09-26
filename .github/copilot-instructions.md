# Project: local-llmup

A hardware-aware native Rust CLI (crates.io: `llmup-cli`) that scores your machine and tells you which
local LLMs will run — `yes / slow / no` plus an estimated tok/s range — before
recommending, installing, serving, and migrating them. Backends (Ollama, llama.cpp,
MLX, attach-only LM Studio) sit behind runtime adapters in `llmup-runtime`.

## Tech Stack

- Rust 1.98.1 (pinned in `rust-toolchain.toml`), edition 2024, `unsafe_code = "forbid"`
- Workspace crates: `llmup-core`, `llmup-runtime`, `llmup-gui`, `llmup-cli`; Tauri desktop in `apps/desktop/src-tauri` (separate Cargo project)
- `clap` (CLI), `serde`/`serde_json` (validation), `sysinfo` + `rustix` (hardware), `ratatui` + `llmup-crossterm` (TUI input fork in `vendor/crossterm`), `axum` (GUI host)
- No Node.js anywhere: `cargo native-retirement` fails if Node/TypeScript tooling returns
- Backend default: Ollama child process, OpenAI-compatible API on `http://127.0.0.1:11434`

## Commands

```bash
cargo build --workspace --locked
cargo test --workspace --locked -- --test-threads=2   # slow; log to a file
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
cargo native-retirement          # Node/TypeScript retirement gate
cargo llmup                      # Dev CLI (alias in .cargo/config.toml)
cargo catalog-bootstrap          # Regenerate crates/llmup-core/data/models.json
cargo catalog-refresh --dry-run  # Catalog refresh dry-run
scripts/native-browser-journeys.sh "$CHROME" "$CHROMEDRIVER"  # WebDriver GUI journeys
```

CLI binaries: `llmup` / `local-llmup` (both `include!` `crates/llmup-cli/src/native.rs`).
Subcommands: `recommend` (default), `can-run`, `doctor`, `catalog`, `up`,
`chat`, `gui`, `ls`, `switch`, `down`, `migrate`.

## Code Conventions

- Rust naming: `snake_case` files/functions, `PascalCase` types, `SCREAMING_SNAKE_CASE` constants
- Validate ALL external input (CLI args, catalog JSON, API responses, config files) with typed `serde` models and explicit checks
- Errors are typed (`thiserror`), never sentinel codes
- New backends implement the runtime adapter traits — do not put backend logic in command code
- Integration tests live in `crates/<crate>/tests/*.rs`; extract pure decision functions to test orchestrators

## Domain Principles (non-negotiable)

- **Honesty gate:** when a figure can't be sourced (unknown bandwidth, missing attention geometry), output `unknown` — never fabricate a number. Models with unknown geometry are still ranked by weights, never silently dropped.
- **Determinism:** advice commands make no network calls and use a curated, cited, offline dataset (`crates/llmup-core/data/`). Advice must be reproducible.
- **Integrity, fail-closed:** `up`/`switch` verify pulled weights against a catalog digest (or size-floor fallback) and refuse to serve unverified weights.
- **Loopback-only:** servers bind `127.0.0.1` by default; never expose to the network.

## Testing

- TDD: write tests before code. For bugs, write a failing test first, then fix (Prove-It pattern).
- Inject network, filesystem, clock and child-process boundaries — never spawn real Ollama, download models or hit real endpoints in tests. Never mutate process env in parallel tests.
- Test hierarchy: unit > integration > e2e — use the lowest level that captures the behavior.
- Run the affected crate's tests after every change and the full workspace before commits.

## Code Quality

- Review across five axes: correctness, readability, architecture, security, performance
- Every change must pass: fmt, Clippy (`-D warnings`), tests, build, `cargo native-retirement`
- No secrets in code or version control
- Never mix formatting changes with behavior changes

## Implementation

- Build in small, verifiable increments: implement → test → verify → commit

## Key References

- **Specs:** `docs/specs/local-llmup.md`, `docs/specs/hardware-advisor.md`, `docs/specs/context-window-sizing.md`
- **Plans:** `docs/plans/`
- **Reviews:** `docs/reviews/` (checkpoints 1–10)
- **Security audits:** `docs/security-audits/` (1–5)
- **Data:** `crates/llmup-core/data/models.json` (catalog), `crates/llmup-core/data/perf.json` (throughput dataset), exposed as `llmup_core::MODELS_JSON` / `PERF_JSON`
- **Ledgers:** `docs/plans/rust-migration-ledger.md`, `docs/plans/cli-retirement-ledger.md`

## Project Map

- `crates/llmup-core/` — catalog, sizing (KV cache, memory), advice, ranking, reports; bundled `data/`
- `crates/llmup-runtime/` — hardware detection, backend adapters, lifecycle, state, memory, harnesses, MCP, workspace
- `crates/llmup-gui/` — loopback HTTP/SSE host, embedded `static/` client and `vendor/` Marked/DOMPurify
- `crates/llmup-cli/` — `native.rs` CLI, TUI, catalog maintenance binaries, retirement gate
- `vendor/crossterm/` — `llmup-crossterm` fork with bounded input parsing
- `apps/desktop/src-tauri/` — Tauri desktop shell

## Boundaries

- **Always:** run tests before commits, validate input, keep advice deterministic and offline, bind servers to loopback, fail closed on integrity mismatch
- **Ask first:** new runtime dependencies, adding a new backend, changing the catalog schema or dataset format, changing memory-store layout, publishing crates
- **Never:** commit secrets, remove failing tests, skip verification, reintroduce Node/TypeScript tooling, fabricate a number where the honesty gate requires `unknown`, hit real network/Ollama in tests
