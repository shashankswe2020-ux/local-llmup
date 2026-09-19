# Rust Merge Readiness

Status on 2026-09-19: **not merge-ready**. No PR existed for the migration branch
when checked. No production routing switch, merge, signing exception, or release
activation is authorized by this report.

## Required End State

- Rust CLI/backend and Tauri desktop, without Node build/runtime/launcher tooling.
- No retained TypeScript implementation, npm manifests, Electron code, or Node
  verification/maintenance workflows at merge time.
- Reviewed static browser JavaScript remains permitted.
- R23-R26 gates pass with functional parity, signed artifacts, dependency/license
  review, real-runtime certification, rollback evidence, and measured budgets.

## Native Retirement Gate

```sh
cargo native-retirement
```

The command inventories tracked and nonignored untracked files, returns JSON
findings, and exits unsuccessfully when blockers remain. It rejects TypeScript,
Node module files, package/toolchain manifests, JavaScript outside an explicit
browser-script allowlist, and Node references in executable workflow/script
configuration. It does not interpret historical Markdown as executable tooling.
The current repository has 327 findings. Tests cover rejection and the allowed
browser boundary. This is a conservative source inventory, not semantic proof
that arbitrary generated/obfuscated runtime invocations are impossible. Native
builds with an empty Node PATH and code review remain required.

The Rust Merge Readiness workflow runs this as a real failing gate, without
`continue-on-error`. Passing earlier native CI does not mean retirement passed.
Repository branch-protection configuration has not been changed.

## Performance Gate

```sh
cargo build --locked --release -p llmup-cli --bin llmup-native
cargo native-performance --executable target/release/llmup-native
```

The runner makes five warm-up launches followed by twenty measured launches for
version, recommendations, can-run, and offline catalog refresh. Hardware input is
fixed and recorded. Every child has an empty PATH, a cleared environment, bounded
output, a five-second deadline, and isolated state. Output must match on every
launch, JSON must parse, catalog text must have the expected prefix, and advice
must not create runtime state. The executable hash is checked before and after.

Latency includes process creation, the OS measurement wrapper, and output
collection. These are warm-cache process measurements, not cold-disk/boot or
inference throughput measurements. Peak RSS comes from `/usr/bin/time`: bytes on
macOS, KiB converted to bytes on Linux. Unknown/invalid memory never passes.
Windows measurement is unsupported and fails explicitly.

Enforced initial budgets per probe:

| Metric | Limit |
| --- | --- |
| Process p90 | 100 ms |
| Maximum measured peak RSS | 64 MiB |
| CLI executable | 32 MiB |

Local macOS arm64 release run on 2026-09-19:

| Probe | Median | p90 | Peak RSS Bytes |
| --- | --- | --- | --- |
| Version | 8.37 ms | 8.60 ms | 8,192,000 |
| Recommend | 21.14 ms | 22.05 ms | 12,304,384 |
| Can-run | 20.35 ms | 20.80 ms | 12,419,072 |
| Catalog refresh | 30.74 ms | 31.71 ms | 12,566,528 |

All four local probes passed. Raw samples, SHA-256, timestamp, platform, hardware,
limits, and failures are emitted as JSON. Linux/macOS CI records the same evidence
in job logs and summaries. These initial absolute ceilings do not substitute for
future baseline-relative regression checks, Windows measurements, Tauri startup,
GUI responsiveness, long-lived memory, or installer/archive size budgets.

## Remaining Blockers

- Full terminal UX, capability routing, lifecycle menus, and remaining maintenance
  and browser verification tooling are not yet native.
- Signing identities are unavailable. Signed CLI/Tauri artifacts, notarization,
  platform installer verification, and release review remain required.
- Desktop RustSec findings, MPL source/notice obligations, and the remaining
  installed-runtime/embedding certification have not been resolved or waived.
- The retirement gate is red. Production TypeScript/Electron entry points must
  remain until their functional and release replacements are verified; the branch
  must not merge in that intermediate state.