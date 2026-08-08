# Security Audit Report #7

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Task B4 — "State schema v2 (+backend) + v1→v2 normalization." Uncommitted working-tree changes only: `STATE_SCHEMA_VERSION` bump 1→2, the `backend: z.enum(BACKEND_NAMES)` field on `ServerStateCommonSchema`, and the v1→v2 transform prepended to `normalizeLegacyRuntimeState()` in [src/state/state.ts](../../src/state/state.ts); the `backend: "ollama"` writes in [src/commands/up.ts](../../src/commands/up.ts); and their tests (`tests/state/state.test.ts`, `tests/commands/up.test.ts`).
> **Threat model:** S-sized, single-user local CLI. `state.json` lives at `~/.local-llmup/state.json` inside the user's `0700` home and is written `0600`. It is only "attacker-controllable" by a process running as the **same UID** (another tool the user ran, or same-user tampering) — there is no cross-user or network boundary to cross. The realistic adversary supplies a hostile/corrupt on-disk `state.json` that flows through `readState()` → normalization → `RuntimeStateSchema.safeParse`.
> **Dependencies:** `npm audit --omit=dev` reports **0 vulnerabilities** in the shipped runtime closure (`cac`, `zod`, `systeminformation`). Dev-only advisories tracked separately in Audit #6 [LOW-3] are unchanged and out of scope for B4.

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 0     |
| Info     | 3     |

**Verdict — Overall risk: LOW (clean).** The three threat-focus questions all resolve **fail-closed**:

1. **No prototype-pollution / field-smuggling risk** from the pre-validation spreads.
2. **`backend` is constrained to the `BACKEND_NAMES` enum** at the trust boundary — no arbitrary string is persisted or echoed.
3. **The v1→v2 default never overrides an attacker-supplied `backend`**, and a preserved-but-unknown backend is still **rejected** by the enum before it can be used.
4. **No fail-open path** — every malformed state raises `StateError(..., "invalid")`.

No Critical/High/Medium/Low findings, so **no GitHub issues are created** (consistent with the Audit #6 precedent of tracking issues only for Low-and-above findings). The three Info items below are defense-in-depth notes, none introduced by B4.

---

## Verification performed

The core claims were confirmed empirically, not just by inspection:

- **Spread semantics** (`node -e`): spreading a `JSON.parse`d object carrying an own `__proto__` data property creates another **own** `__proto__` data property via `CreateDataProperty` (it does **not** invoke the `__proto__` setter). `({}).polluted` stayed `undefined` after `{ backend, ...activeRecord }`, `{ ...candidate, ... }`, and the `{ pid, ...rest }` destructuring rest. `Object.prototype` is never mutated.
- **End-to-end fail-closed** (`tsx` against the real `readState`): a v1 `state.json` whose `active` contained both a poisoned `"__proto__": { x: 1 }` key **and** `backend: "evil"` was **rejected** with `StateError.kind === "invalid"`, and global `({}).x` remained `undefined`. A v2 file with `backend: "attacker"` was likewise **rejected** with kind `"invalid"`.

Why it holds: object spread cannot pollute the prototype, and any leftover own `__proto__` (or any other unexpected key) is caught by the `.strict()` Zod objects as an unrecognized key. The discriminated union on `ownedByUs` plus `.strict()` on every branch means a malformed `active` either fails the discriminator or fails the strict key check — both surface as `"invalid"`.

---

## Findings

_(No Critical/High/Medium/Low findings. Informational observations only.)_

### [INFO-1] v1→v2 transform stamps `schemaVersion: 2` before validation, but validation still gates acceptance

- **Location:** [src/state/state.ts](../../src/state/state.ts) — `normalizeLegacyRuntimeState`, lines 77–92.
- **Observation:** When `candidate["schemaVersion"] === 1`, the function unconditionally rewrites `schemaVersion: STATE_SCHEMA_VERSION` and reshapes `active`, even if the rest of the object is garbage. This is **not** a fail-open: the reshaped object is still passed through `RuntimeStateSchema.safeParse`, which enforces `schemaVersion: z.literal(2)`, the `.strict()` shapes, the `backend` enum, and the discriminated union. A v1 wrapper around junk is therefore still rejected as `"invalid"`. The version stamp only normalizes shape; it grants no trust. No change required; noted so a future reader does not mistake the unconditional stamp for a bypass.

### [INFO-2] Default-backend guard keys on `=== undefined`, correctly preserving (not laundering) an existing value

- **Location:** [src/state/state.ts](../../src/state/state.ts) — `migratedActive = { backend: V1_DEFAULT_BACKEND, ...activeRecord }`, line 85, gated by `activeRecord["backend"] === undefined` on line 84.
- **Observation:** The `"ollama"` default is injected **only** when `backend` is absent, and the spread order (`{ backend: DEFAULT, ...activeRecord }`) means any present `backend` — including an attacker's — overwrites the default rather than the reverse. This is the correct least-surprise property: the migration never fabricates a backend over a stated one. Crucially, preserving a hostile value is **safe** because it is not trusted downstream: `z.enum(BACKEND_NAMES)` rejects anything outside `{ollama, llamacpp, mlx, lmstudio}`, so an unknown/hostile backend name cannot slip past validation into `up`/`switch`/spawn logic. A `null` `active` short-circuits correctly (the `typeof active === "object" && active !== null` guard), so v1 idle states migrate cleanly.

### [INFO-3] `endpoint` is validated as a URL but not constrained to loopback (pre-existing, not introduced by B4)

- **Location:** [src/state/state.ts](../../src/state/state.ts) — `endpoint: z.string().url()` in `ServerStateCommonSchema`, line 29.
- **Observation:** A same-UID actor who can write `state.json` can set `active.endpoint` to any syntactically valid URL (including a non-loopback host). Later commands that read state and connect to `endpoint` would then talk to that host. This predates B4 (the field and its schema are unchanged by this task) and is bounded by the same-UID threat model — an actor who can rewrite `state.json` can already act as the user. It is called out only as an optional defense-in-depth hardening for parity with the project's "loopback-only" domain principle: consider asserting the persisted `endpoint` resolves to `127.0.0.1`/`::1` (or a `localhost` host) at read time. **Out of scope for B4; no action required for this task.**

---

## Positive Observations

- **Spread-over-`Object.assign` is the right primitive.** The normalization uses object spread and destructuring rest exclusively — both use `CreateDataProperty` and cannot trigger the `__proto__` setter. Had the code used `Object.assign(target, parsed)` or `target[key] = ...`, a `__proto__` key could have polluted `Object.prototype`. The chosen pattern is pollution-safe by construction, and was confirmed so empirically.
- **`.strict()` everywhere + discriminated union = defense in depth.** Even the theoretically-possible leftover own `__proto__` key (or any smuggled field) is rejected as an unrecognized key rather than silently carried into `RuntimeState`. Unknown keys cannot ride through the discriminated union into a matched branch.
- **`backend` constrained at the boundary.** `z.enum(BACKEND_NAMES)` guarantees the persisted/round-tripped `backend` is one of four known identifiers; no arbitrary string can be stored, echoed, or fed to backend selection.
- **Fails closed on every corrupt-input path.** `readState` distinguishes `empty` / `unparseable` / `invalid` and throws typed `StateError`; there is no branch that returns a partially-trusted object. `writeState` re-validates via `safeParse` before the atomic write and refuses to persist an invalid state.
- **Atomic, least-privilege persistence unchanged.** Writes go to a per-pid/UUID temp file created with `FILE_MODE` (0600) in the staging dir, `chmod`ed, then `rename`d over the target — a partial write can never be observed as live state, and permissions stay tight. The v2 change did not weaken any of this.
- **Migration is honest.** v1 attached servers are migrated **without** inventing a `pid` (the legacy `pid: 0` sentinel is stripped), and the default backend is the only backend v1 could actually have served — no fabricated data, consistent with the project's honesty gate.

---

## Action Items (Priority Order)

_No Critical/High/Medium/Low action items. B4 is safe to land as-is._

| #   | Severity | Finding                                                     | Recommendation                                                                                                                          |
| --- | -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Info     | [INFO-3] `endpoint` not loopback-constrained (pre-existing) | Optionally assert persisted `endpoint` is loopback at read time, for parity with the loopback-only principle. Track separately from B4. |
| 2   | Info     | [INFO-1] Unconditional v1 version stamp                     | None required; documented so the stamp is not mistaken for a validation bypass.                                                         |
| 3   | Info     | [INFO-2] Default-backend preservation of hostile value      | None required; value is enum-gated downstream and safe.                                                                                 |
