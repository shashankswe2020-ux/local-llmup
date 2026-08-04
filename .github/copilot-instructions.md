# Project: whoop-mcp

An MCP server wrapping the WHOOP REST API for AI assistant access to health/fitness data.

## Tech Stack
- TypeScript ~5.x (strict, no `any`), Node.js >= 18, native `fetch`
- `@modelcontextprotocol/sdk`, Zod, Vitest, ESLint, Prettier
- Build: `tsc` — no bundler. No runtime deps beyond SDK + Zod.

## Commands
```bash
npm run build       # Build TypeScript
npm test            # Run tests (Vitest)
npm run lint        # ESLint
npm run lint:fix    # ESLint + fix
npm run format      # Prettier
npm run typecheck   # tsc --noEmit
npm run dev         # Dev mode (tsx)
```

## Code Conventions
- Files: `kebab-case.ts` | Types: `PascalCase` | Functions: `camelCase` | Constants: `SCREAMING_SNAKE_CASE`
- MCP tool names: `snake_case` (MCP convention)
- Named exports only (no default exports)
- Explicit return types on all exported functions
- One tool per file — handler + Zod schema co-located
- Errors throw typed errors, never return error codes
- Tests mirror `src/` structure in `tests/` directory

## Testing
- Write tests before code (TDD)
- For bugs: write a failing test first, then fix (Prove-It pattern)
- Test hierarchy: unit > integration > e2e (use the lowest level that captures the behavior)
- Mock the WHOOP API — never hit real API in tests. Use `vi.fn()` for fetch.
- Coverage target: >80% on `src/auth/` and `src/api/`, >70% overall
- Run `npm test` after every change

## Code Quality
- Review across five axes: correctness, readability, architecture, security, performance
- Every PR must pass: lint, type check, tests, build
- No secrets in code or version control

## Implementation
- Build in small, verifiable increments
- Each increment: implement → test → verify → commit
- Never mix formatting changes with behavior changes

## Key References
- **Spec:** `docs/specs/whoop-mcp-server.md`
- **Implementation plan:** `docs/specs/implementation-plan.md`
- **Code review:** `docs/reviews/code-review-checkpoint-1.md` (Tasks 1–5 approved)
- **WHOOP API base:** `https://api.prod.whoop.com/developer` (v2 endpoints)
- **OAuth:** Authorization Code flow, tokens at `~/.whoop-mcp/tokens.json` (0600 perms)

## Implementation Status
- All 10 tasks complete (scaffold, types, token store, API client, OAuth, MCP server shell, tool implementations, error handling, entry point + CLI, docs + publish prep)
- 212 tests passing, typecheck clean, build clean, lint clean
- ✅ MCP Inspector integration tested 2026-04-12 — OAuth flow, `get_profile` tool returning real data
- ✅ Claude Desktop integration tested 2026-04-12 — server connected, OAuth completed, tools accessible
- ✅ Published to npm 2026-04-12 — `whoop-ai-mcp@0.1.0` at https://www.npmjs.com/package/whoop-ai-mcp

## Boundaries
- **Always:** Run tests before commits, validate input with Zod, store tokens securely (0600)
- **Ask first:** New runtime dependencies, token storage changes, new API endpoints, OAuth flow changes
- **Never:** Commit secrets, remove failing tests, skip verification, use `any`, hit real WHOOP API in tests
