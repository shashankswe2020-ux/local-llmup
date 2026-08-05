# Changelog

## 0.2.0 - 2026-08-06

Local AI Hardware Advisor (v1.0) — the tool now tells you not just what fits, but
how well it will run, with no pricing data or maintenance liability.

- `doctor` now reports an **AI Hardware Score** (0–100) and your **primary
  bottleneck** (VRAM / RAM / compute / storage); `--json` includes both.
- New **`can-run <model>`** command: a single `yes | slow | no` verdict with the
  binding reason and an estimated tok/s range. Exits non-zero only for `no`, so
  it is scriptable (`local-llmup can-run <model> && local-llmup up <model>`).
- `recommend` gains a **Verdict** (✓ yes / ⚠️ slow / ❌ no) and **Est. tok/s**
  column; `--json` gains `verdict` and `estTokPerSec` per row.
- Added a memory-bandwidth **throughput estimator** (roofline model) backed by a
  curated, cited hardware performance dataset (`data/perf.json`). Throughput is
  always a range; hardware with no profile reports `unknown` rather than a
  fabricated number (honesty gate).
- Ranking order and existing command behavior are unchanged.

## 0.1.0 - 2026-08-05

- Initial public release of local-llmup.
- Added hardware-aware model recommendation and local install/serve flows.
- Added chat, migrate, ls, catalog, and doctor commands.
- Added a curated model catalog with weekly refresh automation hooks.
