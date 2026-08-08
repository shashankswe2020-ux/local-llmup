# Code Review Checkpoint 12: Task B3 — Fail-Closed User Config Loader

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B3 of the pluggable-backends plan — uncommitted working-tree changes only: `src/types.ts` (`BACKEND_NAMES` + `BackendName`), `src/config.ts` (`loadUserConfig` + schema/constants), `tests/config.test.ts` (+12 tests). No call sites wired (that is B5/B6).
> **Test suite:** 658 tests passing (+12) across 47 files; typecheck clean; build exit 0; eslint on the three changed files exits 0.

---

## Verdict: ✅ APPROVE

**Overview:** A tight, spec-faithful, additive loader that fails **closed** on every hostile input class (symlink, world-writable, oversized, malformed, unknown key/version/backend) using a genuinely TOCTOU-safe `open`→`fstat`→`read`-on-fd pattern. No Critical or Important findings block the commit. One cross-task coordination note (the config vocabulary intentionally leads the registry) must be honored in B5; the rest are optional polish.

---

## Answers to the three review questions

**1. Permission policy (reject `mode & 0o022`, accept `0o644`) — correct call.**
Spec §2.6 states the file header posture as "owner-only (`0600`)" but names the _rejection_ criterion explicitly: "reject the file if it is a symlink or **group/other-writable**." `mode & 0o022` (group-write `0o020` ∪ other-write `0o002`) implements that criterion exactly. The threat model justifies the lenient-on-read stance: `defaultBackend` is a non-secret enum value, so world-_readable_ leaks nothing, whereas world-_writable_ is a real redirection/tamper vector. Requiring exactly `0600` would be _stricter than the spec's own stated rule_ and would reject legitimate files created under a permissive umask. Keep it as-is. (Optional polish: a one-line comment on why readable-not-writable is the deliberate boundary — see Suggestion 2.)

**2. `BACKEND_NAMES` (all four names) in dependency-free `types.ts` — correct, with a B5 obligation.**
This is the right call and arguably _better_ than the spec's literal `z.enum([…registryNames])`. Config and state persist `backend` as a **stable wire value**; the set of _parseable_ values must not expand/contract with whatever adapters a given build happens to register, or state/config stops round-tripping across versions (e.g. a `state.json` written after serving `mlx`, then read by a build without the mlx adapter). Anchoring the vocabulary to an append-only canonical list in the dependency-free module is the honest source of truth. The documented test ("accepts a known backend that is not yet registered in Phase 0") pins the intent.
The **trade-off it creates**: config may now legitimately name a known-but-_unregistered_ backend. `select()` (B5) must treat that as "preference for a backend that can't currently serve" and fall through to auto-detect (or emit a clear `BackendError` listing servable backends) — it must **not** pass the name straight into `registry.get()`, which throws `ValidationError` on unknown/unregistered names (B2 contract). Tracked below as an Important note targeted at B5, not a defect in B3.

**3. `O_NOFOLLOW` + fd-based `fstat`/`read` — sound.**
Textbook TOCTOU closure: the symlink refusal (`O_NOFOLLOW`→`ELOOP`), the regular-file check, the permission check, the size check, and the read all operate on the **same descriptor/inode** obtained by the single `openSync`, so there is no stat↔open swap window. `fstatSync` does not move the file offset, so the subsequent `readFileSync(fd)` reads from 0. `fd` is closed in `finally`. Correct. Documented limits are acceptable for v1: `O_NOFOLLOW` guards only the final path component (intermediate dir symlinks under the tool's own `homeDir` are out of model), and on platforms lacking it the flag degrades to `0` with the mode bits effectively inert (Windows) — both are called out in the doc comment.

---

## Critical Issues

None.

## Important Issues

### 1. B5 must gracefully handle a config naming a known-but-unregistered/uninstalled backend

- **File:** `src/config.ts:69` (`defaultBackend: z.enum(BACKEND_NAMES)`), consumed later by `select()` (B5).
- **Problem:** By design (and correctly — see answer 2), `loadUserConfig` accepts `defaultBackend: "mlx" | "llamacpp" | "lmstudio"` before those adapters are registered. `BackendRegistry.get()` throws `ValidationError` on an unregistered name (B2). If B5's create-intent path does `registry.get(userConfig.defaultBackend)` without a guard, a perfectly valid config will surface as a confusing "unknown backend" validation error instead of falling through to auto-detect.
- **Fix (in B5, not B3):** In the config → resolution step, prefer the named backend only when it is present in the registry _and_ `isInstalled()` on the serving path; otherwise fall through to auto-detect (spec §2.6: "selection falls through to auto-detect"). Concretely, branch on registry membership rather than letting `get()` throw:
  ```ts
  const preferred = userConfig?.defaultBackend;
  const fromConfig =
    preferred && registry.all().some((a) => a.name === preferred)
      ? registry.get(preferred)
      : undefined; // known name, not (yet) registered → defer to auto-detect
  ```
  Add a B5 test: config names `mlx`, only `ollama` registered → resolves to auto-detect, no throw. **This does not block committing B3** (the loader has no call site yet — confirmed no runtime references outside `config.ts`/its test).

## Suggestions

### 1. No test exercises the non-regular-file branch (`!stats.isFile()`)

- **File:** `src/config.ts:113-115`; `tests/config.test.ts`.
- Every other rejection branch has a case, but a directory (or FIFO) at the `config.json` path — which `O_NOFOLLOW` permits opening — is uncovered. A one-liner closes it:
  ```ts
  it("rejects a non-regular file (directory at config.json)", () => {
    mkdirSync(join(home, "config.json"));
    expect(() => loadUserConfig(config)).toThrow(ValidationError);
  });
  ```

### 2. Document _why_ readable-but-not-writable is accepted

- **File:** `src/config.ts:117-121`.
- The `mode & 0o022` check reads as "reject writable" but the deliberate omission of the read bits (the answer to review question 1) isn't stated at the call site. A short comment — e.g. `// defaultBackend is not a secret: world-readable is fine; only world/group-writable is a tamper vector` — preserves the rationale for the next reader and preempts a future "shouldn't this be 0600?" churn.

### 3. Note the platform caveat nearer the permission check (optional)

- **File:** `src/config.ts:117`.
- The doc comment covers `O_NOFOLLOW` degradation, but the `mode & 0o022` gate is likewise a near-no-op on Windows (synthesized mode bits). Already implied by the general Windows posture; a half-line reference keeps the two platform caveats together. Purely optional.

## What's Done Well

- **Genuine TOCTOU closure.** `open(O_NOFOLLOW)` → `fstat(fd)` → `read(fd)` on one descriptor is the correct pattern, not the common `statSync(path)`-then-`readFileSync(path)` anti-pattern — and the doc comment explains precisely why, so the intent survives future edits.
- **Fail-closed vocabulary is honest and forward-safe.** Anchoring `BACKEND_NAMES` in the dependency-free module as an append-only wire-value source of truth (shared by config, state, registry, `select()`) is exactly right for values that get persisted; the "not-yet-registered" acceptance is a deliberate, tested decision rather than an oversight.
- **`schemaVersion: z.literal(1)` + `.strict()`** makes both forward-incompatible layouts and unknown keys fail closed instead of being silently coerced (spec §2.6, review finding M3).
- **Byte cap before read.** `fstat.size > MAX_USER_CONFIG_BYTES` short-circuits before `readFileSync`, so a hostile multi-GB `config.json` can't be pulled into memory — a real, cheap DoS guard for a file that should only ever hold a couple scalars.
- **Test design fits the problem.** Permission/symlink semantics can't be faithfully mocked, so real temp dirs (`mkdtempSync`) under an explicit `process.umask(0)` — restored in `afterEach` — are the right tool and stay within the "temp dir only" convention. 12 cases cover absent/blank/valid/forward-name/`0o644`/unknown-key/wrong-version/unknown-backend/bad-JSON/oversized/`0o666`/symlink.
- **Conventions honored throughout:** named exports, explicit return types, typed `ValidationError` with `cause` chaining (never error codes), no `any`, kebab-case, thorough JSDoc. `fd` closed in `finally` on every path.

## Verification Story

| Check            | Status | Notes                                                                                                                                                                                                                                                                             |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 12 new cases; every rejection branch covered except `!isFile()` (Suggestion 1). Real-FS + `umask(0)` is appropriate and correctly scoped to a temp dir.                                                                                                                           |
| Build verified   | ✅     | `npm run typecheck` clean; `npm run build` exit 0; full suite 658 passing (+12); eslint on the three files exits 0.                                                                                                                                                               |
| Security checked | ✅     | TOCTOU-safe fd inspection; symlink refused (`O_NOFOLLOW`/`ELOOP`); world/group-writable refused; byte-capped before read; all external input Zod-validated at the boundary and fails closed; no secrets; loader confirmed off the advice path and not yet wired to any call site. |
| Coverage         | ⚠️     | Strong; single uncovered branch is `!stats.isFile()` (directory/FIFO at path).                                                                                                                                                                                                    |

## Action Items

| #   | Priority   | Issue                                                                                                                                      | Target                       |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 1   | Important  | `select()` must defer (not throw via `registry.get()`) when config names a known-but-unregistered/uninstalled backend; add regression test | task B5                      |
| 2   | Suggestion | Add a `!isFile()` (directory-at-path) rejection test                                                                                       | task B3 (optional) / backlog |
| 3   | Suggestion | Comment the deliberate readable-but-not-writable permission boundary                                                                       | task B3 (optional) / backlog |
| 4   | Suggestion | Co-locate the Windows caveat for the `mode & 0o022` gate                                                                                   | backlog (optional)           |

---

_No Critical findings — no GitHub issues created (per review request, issues are filed for Critical findings only). The single Important item is a forward-looking obligation on B5, not a defect in B3, and does not block committing this task._
