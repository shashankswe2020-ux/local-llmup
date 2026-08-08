# Project: local-llmup

A hardware-aware CLI (npm package) that scores your machine and tells you which
local LLMs will run — `yes / slow / no` plus an estimated tok/s range — before
recommending, installing, serving, and migrating them. Ollama is the sole v1
backend, abstracted behind a `BackendAdapter` interface.

## Tech Stack

- TypeScript ~5.x (`strict: true`, **no `any`**), ESM (`"type": "module"`), Node.js >= 18, native `fetch`
- `cac` (CLI parsing), `zod` (validation), `systeminformation` (hardware detection)
- Vitest, ESLint (typescript-eslint), Prettier
- Build: `tsc` — no bundler. Runtime deps limited to `cac`, `zod`, `systeminformation`.
- Backend: Ollama child process, OpenAI-compatible API on `http://127.0.0.1:11434`

## Commands

```bash
npm run build       # Build TypeScript (tsc)
npm test            # Run tests (vitest run)
npm run test:watch  # Vitest watch
npm run test:cov    # Vitest + coverage
npm run lint        # ESLint
npm run lint:fix    # ESLint + fix
npm run format      # Prettier
npm run typecheck   # tsc --noEmit
npm run dev         # Dev mode (tsx src/cli.ts)
npm run bootstrap             # Bootstrap the model catalog
npm run catalog:refresh:dry-run  # Catalog refresh dry-run
```

CLI binaries: `llmup` / `local-llmup` (→ `dist/bin.js`). Subcommands live in
`src/commands/`: `recommend` (default), `can-run`, `doctor`, `catalog`, `up`,
`chat`, `ls`, `switch`, `down`, `migrate`.

## Code Conventions

- Files: `kebab-case.ts` | Types: `PascalCase` | Functions: `camelCase` | Constants: `SCREAMING_SNAKE_CASE`
- **Named exports only** (no default exports)
- **Explicit return types** on all exported functions (ESLint enforces `explicit-module-boundary-types`)
- `@typescript-eslint/no-explicit-any` is an error — never use `any`
- Validate ALL external input with Zod: CLI args, catalog JSON, API responses, config files
- Errors throw typed errors (see `src/errors.ts`), never return error codes
- New backends implement the `BackendAdapter` interface — do not put backend logic in command code
- Tests mirror `src/` structure under `tests/` as `*.test.ts`

## Domain Principles (non-negotiable)

- **Honesty gate:** when a figure can't be sourced (unknown bandwidth, missing attention geometry), output `unknown` — never fabricate a number. Models with unknown geometry are still ranked by weights, never silently dropped.
- **Determinism:** advice commands make no network calls and use a curated, cited, offline dataset (`data/`). Advice must be reproducible.
- **Integrity, fail-closed:** `up`/`switch` verify pulled weights against a catalog digest (or size-floor fallback) and refuse to serve unverified weights.
- **Loopback-only:** servers bind `127.0.0.1` by default; never expose to the network.

## Testing

- TDD: write tests before code. For bugs, write a failing test first, then fix (Prove-It pattern).
- Mock ALL network, filesystem, and child-process interactions with `vi.fn()` — never spawn real Ollama or hit real endpoints in tests.
- Test hierarchy: unit > integration > e2e — use the lowest level that captures the behavior.
- Run `npm test` after every change. 634 tests currently passing.

## Code Quality

- Review across five axes: correctness, readability, architecture, security, performance
- Every change must pass: lint, type check, tests, build
- No secrets in code or version control
- Never mix formatting changes with behavior changes

## Implementation

- Build in small, verifiable increments: implement → test → verify → commit

## Key References

- **Specs:** `docs/specs/local-llmup.md`, `docs/specs/hardware-advisor.md`, `docs/specs/context-window-sizing.md`
- **Plans:** `docs/plans/`
- **Reviews:** `docs/reviews/` (checkpoints 1–10)
- **Security audits:** `docs/security-audits/` (1–5)
- **Data:** `data/models.json` (catalog), `data/perf.json` (throughput dataset)

## Project Map

- `src/cli.ts`, `src/bin.ts` — entry points & CLI wiring
- `src/commands/` — one file per subcommand
- `src/advisor/` — scoring, throughput, verdict, weights (the yes/slow/no engine)
- `src/hardware/` — detection + memory math (KV-cache sizing, VRAM/RAM)
- `src/catalog/` — model catalog load, schema, enrich, bootstrap, registry snapshot
- `src/backend/` — Ollama adapter, net, BackendAdapter abstraction
- `src/ranking/` — fit + rank + weights
- `src/memory/` — conversation memory capture, store, migrate
- `src/state/` — active-model / server state

## Boundaries

- **Always:** run tests before commits, validate input with Zod, keep advice deterministic and offline, bind servers to loopback, fail closed on integrity mismatch
- **Ask first:** new runtime dependencies, adding a new backend, changing the catalog schema or `data/` dataset format, changing memory-store layout
- **Never:** commit secrets, remove failing tests, skip verification, use `any`, fabricate a number where the honesty gate requires `unknown`, hit real network/Ollama in tests
