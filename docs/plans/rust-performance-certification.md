# Rust Performance Certification

Status: pending full migration. This is the test protocol for the requested deep
performance and improvement report, not a completed benchmark report.

## Measurement Rules

- User direction (2026-09-22): run comparative performance testing after migration
  is complete, against a pinned published `rigspark` npm package, not a rebuilt
  legacy checkout. No comparative benchmarks are authorized by intermediate
  migration checkpoints.
- Record the exact published package version, registry URL, tarball integrity and
  hash, installed dependency lock/resolution, Node version and platform. Install
  the baseline in an isolated external prefix; do not restore Node dependencies or
  launchers to the migrated repository. Do not use a moving `latest` tag as evidence.
- Compare that untouched published baseline with the pinned native release build
  on the same machine, OS, runtime/model revisions, inputs, and settings. Record
  dataset hashes: changed catalogs or unsupported baseline options are confounders,
  not improvements. Use common workloads and explicit exceptions where necessary.
- Record commit and binary hashes, toolchain, CPU/GPU/RAM, power mode, model digest,
  context, hardware-detection mode, sample count, failures, and raw samples.
- Separate cold filesystem/cache launches, warm process launches, first inference,
  and steady-state runs. Alternate baseline/candidate ordering to limit drift.
- Report median, p90/p95/p99 where sample counts support them, peak RSS, retained
  memory after repeated operations, CPU, disk/network I/O, and artifact sizes.
- Do not equate summed process RSS with unique physical memory. Desktop process
  trees require consistent aggregation and an explicit shared-memory caveat.
- Compare identical successful outputs and safety behavior before accepting a
  speedup. Timeouts, failed requests, dropped tokens, or lost persistence are failures.
- Preserve unknowns: no inference, desktop, or cross-platform improvement claims
  from CLI version measurements. Mock-provider UI timings exclude inference.
- Keep user state isolated; never benchmark destructive commands on user data.

## Feature Matrix

| Surface | Required Journeys | Required Measurements |
| --- | --- | --- |
| CLI advice | default recommend, task/backend/context/max-context variants, can-run yes/slow/no/unknown, catalog all/fit/refresh, doctor, installed inventory, ls | full process latency, JSON/plain parity, peak memory, filesystem/network isolation |
| CLI lifecycle | cold acquisition, digest verification, cached up, switch, attached/owned down, cancellation and recovery | stage latency, download vs verification time, CPU/I/O, cleanup, memory, state integrity |
| CLI chat | plain/accessibility/JSON; each supported harness; single/multi-turn; memory on/off; failure/cancel | orchestration vs model TTFT, completion/tok-s, stream gaps, capture overhead, retained memory |
| CLI maintenance | bootstrap, incremental refresh/no-op, freshness, coverage, live enrichment, memory dry-run/copy/move | throughput by input size, allocations/RSS, write amplification, deterministic output |
| TUI | launch, report scroll/search/details, model picker, lifecycle review/progress/recovery, accessible flows, chat edit/paste/send/cancel, resize, signal exit | input-to-frame latency, frame CPU, idle CPU, terminal bytes/frame, bounded buffers, restore latency |
| Browser GUI | first load, model list/filter, sessions/create/reload, streaming/cancel, library/context selection, connectors/approvals, workspace read/propose/apply/revert, artifacts, telemetry | navigation/LCP/interaction latency, long tasks, API percentiles, SSE lag, request count, heap/RSS over repeat journeys |
| Desktop app | packaged launch/window-ready, directory picker cancel/select/revoke, same GUI journeys, close/reopen, idle/active telemetry | window-ready time, full process-tree memory/CPU, idle wakeups, package/install size, shutdown and leaked children |
| Shared services | memory capture/migration/recovery, embeddings, library ingestion/search, MCP stdio/HTTP/SSE, agent orchestration, tools and approval boundaries | small/medium/large input scaling, concurrent latency, backpressure, peak and retained memory, cancellation deadlines |

All supported platform/backend combinations need either measured evidence or a
clearly named unverified gate. Local macOS results do not certify Windows/Linux.
No real-provider or runtime test should silently use a mock. Conversely, unit
tests must not acquire live models or make external network calls.

## Optimization Loop

1. Run functional equivalence and establish raw release baselines.
2. Profile the slow/high-memory journey; identify the responsible owning function.
3. Add a regression check for correctness and the observed resource bound.
4. Apply a narrowly scoped optimization and rerun the identical workload.
5. Report both the improvement and any size, CPU, latency-tail, or complexity cost.
6. Rerun cross-surface gates when shared code changes. Keep unsuccessful experiments
   out of production, but record negative findings in the report.

## Existing Evidence, Not Certification

The current native startup gate has 20 measured warm-cache launches after five
warm-ups for four advice probes, with limits of 100 ms p90, 64 MiB peak RSS, and
32 MiB CLI size. After adding the first TUI renderer, local macOS p90 values were
8.32/21.00/20.07/32.23 ms for version/recommend/can-run/catalog; maximum measured
RSS was 13,238,272 bytes. This only rules out a large startup regression.

A separate local `--version` comparison used 20 interleaved warm-cache launches:
Node v26 median 135.8 ms and median peak RSS 67.9 MiB; Rust median 7.5 ms and
median peak RSS 7.6 MiB. These are implementation-specific startup measurements,
not model inference, TUI, GUI, or desktop-app performance claims.

Retained CI run `35447512613` reported a Node 18 macOS startup median regression
of 13.2 ms against the 10 ms relative limit. Other retained combinations passed.
This result requires investigation/reproduction; it is not waived as noise and
does not justify changing the threshold.

## Final Report Requirements

The final report must list every matrix journey as measured, failed, unsupported,
or blocked, with commands and raw-evidence locations. Include baseline/candidate
tables, statistically justified deltas, profiler findings, implemented improvements,
remaining bottlenecks, correctness/security regressions, and platform caveats.
Do not label the report complete while migration or required measurements remain
unfinished.