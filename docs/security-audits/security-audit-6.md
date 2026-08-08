# Security Audit Report #6

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B3 — new fail-closed user config loader. Uncommitted working-tree changes only: `loadUserConfig()` + supporting constants/schema in `src/config.ts`, `BACKEND_NAMES`/`BackendName` in `src/types.ts`, and `tests/config.test.ts`. Compared against the existing 0600/0700 fail-closed posture in `src/memory/store.ts` and `src/state/state.ts`.
> **Threat model:** S-sized, single-user local CLI. The config lives at `~/.local-llmup/config.json` inside the user's own `0700` home directory. There is no cross-user or network attack surface for this loader (it is deliberately off the deterministic advice path and makes no network calls). The realistic adversaries are: (a) a corrupt/hostile file dropped by another tool the same user ran, and (b) same-user misconfiguration. There is no privilege boundary to cross within a single UID.
> **Dependencies:** `npm audit` reports 6 vulnerabilities (2 critical, 1 high, 3 moderate). **All are dev-only** (`esbuild`/`vite`/`vite-node`/`@vitest/mocker`/`vitest`/`@vitest/coverage-v8`) and are not shipped in the published package's runtime dependency set (`cac`, `zod`, `systeminformation`). None are introduced by B3. See [LOW-3].

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 3     |
| Info     | 3     |

**Verdict:** The B3 loader is well-designed and fails closed. The core question posed — _is the fd-bound TOCTOU defense airtight?_ — is **yes for the final path component on POSIX**: binding `fstat`/`read` to the descriptor returned by `openSync(..., O_NOFOLLOW)` eliminates the classic stat→open swap. The residual items are defense-in-depth gaps that are only reachable by a same-UID actor (no privilege boundary) and are therefore Low/Info under this threat model. No Critical or High findings, so **no GitHub issues are created** (per the "Critical/High only" instruction for this audit).

---

## Findings

### [LOW-1] Size cap is enforced on a pre-read `fstat`, not on the bytes actually read

- **Location:** [src/config.ts](../../src/config.ts) — `loadUserConfig`, the `stats.size > MAX_USER_CONFIG_BYTES` check followed by `readFileSync(fd, "utf8")`.
- **Description:** The size guard reads `stats.size` from `fstatSync(fd)` and rejects `> 4096` bytes. `readFileSync(fd)` then reads to EOF. For a **regular file** (already enforced via `!stats.isFile()`) Node sizes its buffer from the descriptor but continues reading in a loop until EOF, so if the file **grows** between our `fstat` and `readFileSync`'s internal read, the number of bytes actually loaded into memory can exceed `MAX_USER_CONFIG_BYTES`. The 4096-byte cap is therefore advisory against the _observed_ size, not a hard bound on the _read_ size.
- **Impact:** Bounded local memory over-read. Only a process running as the **same user** can append to a file that must be non-group/other-writable inside a `0700` home, so there is no privilege escalation — the user can only inflate their own memory usage. This is a robustness/defense-in-depth gap, not an exploitable DoS across a trust boundary.
- **Proof of concept:** None with cross-user impact. Locally: start growing `~/.local-llmup/config.json` in a tight loop while repeatedly invoking the loader; a race window exists where more than 4096 bytes are read before `JSON.parse`.
- **Recommendation:** Bound the read itself rather than trusting the prior `fstat`. Read at most `MAX_USER_CONFIG_BYTES + 1` bytes from the descriptor and reject if the read fills the buffer, e.g.:
  ```ts
  const buf = Buffer.allocUnsafe(MAX_USER_CONFIG_BYTES + 1);
  const n = readSync(fd, buf, 0, buf.length, 0);
  if (n > MAX_USER_CONFIG_BYTES) {
    throw new ValidationError(
      `config file ${path} is too large (> ${MAX_USER_CONFIG_BYTES} bytes)`,
    );
  }
  const raw = buf.toString("utf8", 0, n);
  ```
  This keeps the cap and the read on the same descriptor and makes the bound hold regardless of a concurrent append.

### [LOW-2] `O_NOFOLLOW` only guards the final component; no containment check for intermediate symlinks or the Windows fallback

- **Location:** [src/config.ts](../../src/config.ts) — `openSync(path, constants.O_RDONLY | O_NOFOLLOW_FLAG)`, where `O_NOFOLLOW_FLAG = 0` when `constants.O_NOFOLLOW` is undefined (Windows).
- **Description:** Two gaps, both same-UID-only:
  1. **Intermediate directories.** `O_NOFOLLOW` rejects a symlink at the _final_ path component (`config.json`) but does **not** stop traversal through a symlinked _parent_ — e.g. if `~/.local-llmup` itself is a symlink, `open` follows it. `src/memory/store.ts` defends the whole chain with `realpathSync` + an `isWithin(root, real)` containment check (`assertWithinRoot`); the config loader has no equivalent.
  2. **Windows.** On Windows `O_NOFOLLOW_FLAG` collapses to `0`, so a junction/symlink planted at `config.json` is silently followed. (Creating one typically needs Developer Mode or elevation, and it is the user's own machine.)
- **Impact:** A same-user actor who can plant a symlink at or above `~/.local-llmup` could redirect the read to an arbitrary file the user can already read. Because the content is then still forced through `.strict()` Zod validation (only `schemaVersion: 1` + `defaultBackend` enum survive), the worst outcome is that the loader either throws `ValidationError` or, in the vanishingly rare case the redirected file _is_ a valid config, honors a `defaultBackend` the user did not intend. No secret is disclosed (the loader emits nothing but the enum value) and no code executes. This is a low-value target under a single-UID model.
- **Recommendation:** For parity with `store.ts`, after `openSync` optionally assert containment: compare `realpathSync(path)` against `realpathSync(config.homeDir)` with the existing `isWithin` helper and reject on escape. This closes the intermediate-symlink gap on all platforms and restores a real symlink defense on Windows where `O_NOFOLLOW` is a no-op. Given the threat model this is a hardening nicety, not a required fix — document the accepted residual if you choose not to add it.

### [LOW-3] Dev-dependency advisories (esbuild / vite / vite-node / vitest) — not shipped, out of B3 scope

- **Location:** `package.json` devDependencies (transitive via `vitest` / `@vitest/coverage-v8`).
- **Description:** `npm audit` reports 6 advisories (2 critical, 2… rated critical/high upstream, incl. `GHSA-67mh-4wv8-2f99`, the esbuild dev-server request-reflection issue). Every one is a **development/test** dependency. None appear in the package's runtime dependency closure (`cac`, `zod`, `systeminformation`), so they are not delivered to end users of the `llmup`/`local-llmup` CLI.
- **Impact:** No runtime exposure for users of the published package. The esbuild advisory only affects a running vite/esbuild dev server, which this project does not run in production. Risk is limited to a developer's machine while the test toolchain's dev server is listening.
- **Recommendation:** Track separately from B3 (these predate this change). Plan the `vitest@4` upgrade (`npm audit fix --force` pulls `vitest@4.1.10`, a breaking change) as its own maintenance task with a full test re-run. Do not block B3 on it. No production remediation is required.

---

## Positive Observations

- **TOCTOU eliminated on the hot path.** All three checks (`isFile`, permission bits, size) and the read run against the descriptor from a single `openSync(..., O_NOFOLLOW)`. Once bound to an inode, a subsequent path rename/replace cannot redirect `fstatSync(fd)`/`readFileSync(fd)`. This is the correct pattern and is stronger than a `statSync(path)` → `readFileSync(path)` sequence.
- **Prototype-pollution safe.** `JSON.parse` creates an own `__proto__` property rather than mutating `Object.prototype`, and the Zod schema is `.strict()` with only `schemaVersion` + `defaultBackend` permitted, so `__proto__`/`constructor` (or any other unexpected key) is rejected as an unknown key. No pollution reaches consumers.
- **Injection-safe output.** `defaultBackend` is constrained to the `BACKEND_NAMES` enum, so a hostile config cannot smuggle an arbitrary string into later backend selection/spawn logic — the value can only ever be one of four known identifiers.
- **Appropriate permission policy.** Rejecting group/other-**writable** while **accepting** world-readable is the right call here: `defaultBackend` is a non-secret preference, so the stricter exact-`0600` policy used by `store.ts`/`state.ts` (which may hold conversation content) is intentionally and defensibly relaxed. Integrity (nobody else can tamper) is preserved; confidentiality is not needed.
- **Fails closed, cleanly.** Symlink (`ELOOP`), non-regular file, over-permissive mode, oversize, invalid JSON, and schema violations all throw typed `ValidationError`; only genuine absence (`ENOENT`) and blank content return `undefined` ("no preference"). `closeSync(fd)` is in a `finally`, so the descriptor is released on every path.
- **No sensitive data in errors.** Error messages include only the user's own home-relative config path and (as `cause`) the underlying `fs`/Zod error. There is no cross-user path, credential, or content disclosure.
- **Blast radius contained.** The loader is not yet wired into any command (only defined + tested), makes no network calls, and is explicitly kept off the deterministic advice path — so even the residual Low items above have no live consumer today.
- **Test coverage matches the threat model.** `tests/config.test.ts` exercises symlink rejection, `0o666` rejection, oversize rejection, unknown-key/`__proto__`-style strictness, wrong version, unknown backend, and blank/absent — using a real temp dir with `umask(0)` so the permission assertions are meaningful.

---

## Action Items (Priority Order)

| #   | Severity | Finding                                                             | Recommendation                                                                                                                   |
| --- | -------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Low      | [LOW-1] Size cap on pre-read `fstat`, not on bytes read             | Read ≤ `MAX+1` bytes from the fd with `readSync` and reject on overflow, instead of trusting `stats.size`.                       |
| 2   | Low      | [LOW-2] `O_NOFOLLOW` misses intermediate symlinks; no-op on Windows | Optional `realpath` + `isWithin(homeDir, real)` containment check for parity with `store.ts`; or document the accepted residual. |
| 3   | Low      | [LOW-3] Dev-only `vite`/`esbuild`/`vitest` advisories               | Track a `vitest@4` upgrade as separate maintenance; not shipped, do not block B3.                                                |

---

## GitHub Issues

No Critical or High findings were identified, so **no GitHub issues were created** for this audit (per the "create issues only for Critical/High" instruction for B3). The three Low items are recorded here as tracked action items; [LOW-1] and [LOW-2] are optional hardening within B3's scope, and [LOW-3] is a pre-existing, out-of-scope dev-dependency maintenance task.
