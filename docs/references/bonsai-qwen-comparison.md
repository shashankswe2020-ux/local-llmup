# Bonsai 8B vs Qwen3 8B: local comparison

Completed 2026-09-30 23:27:37 UTC (2026-10-01 local time).
This is a local measurement, not a certification of Prism's published claims.

## Results

All values below are medians across 30 requests per workload per model.
Speed requests generated exactly 128 tokens with EOS ignored and prompt caching disabled.

| Workload | Bonsai tok/s | Qwen tok/s | Decode ratio (B/Q) | Bonsai total s | Qwen total s |
| --- | ---: | ---: | ---: | ---: | ---: |
| Short chat | 117.57 | 37.11 | 3.17 | 1.27 | 3.64 |
| Summarization | 102.66 | 38.62 | 2.66 | 2.70 | 5.22 |
| Coding | 116.34 | 35.86 | 3.24 | 1.22 | 3.81 |
| 4,096-token context | 63.10 | 29.31 | 2.15 | 11.99 | 15.99 |
| 16,384-token context | 24.64 | 16.85 | 1.46 | 64.28 | 75.81 |

The decode advantage does not translate directly into end-to-end speedup.
At 16K, median first-token latency was 59.26 s vs 68.29 s, and p95 total
latency was 89.55 s vs 95.43 s. At short context, p95 total latency was
2.57 s vs 4.42 s. The raw report includes median/p95 values for every workload.

Maximum post-request RSS samples were 6.67 GiB for Bonsai and 10.14 GiB for
Qwen. These are not peak total CPU/GPU memory measurements. Verified weight
files were 1,158,654,496 and 5,027,783,488 bytes respectively.

## Task Accuracy, Not General Intelligence

Twenty preselected exact-answer tasks were run once per model with natural
completion, a 256-token output limit, and thinking disabled for both.
Scoring trims surrounding whitespace but otherwise requires exact equality.
There was no LLM judge, generated code execution, or retrospective rescoring.

| Category | Bonsai | Qwen |
| --- | ---: | ---: |
| Arithmetic | 2/4 | 1/4 |
| Logic | 1/4 | 1/4 |
| Code tracing | 0/4 | 2/4 |
| Exact instructions | 3/4 | 3/4 |
| Grounding | 3/4 | 4/4 |
| Total | 9/20 (45%) | 11/20 (55%) |

Qwen led by two tasks, or ten percentage points on this small strict suite.
This does not establish an intelligence ranking. For example, both models
returned `No.` when the required output was `no`. Bonsai explained the correct
machine-rate answer instead of returning only `60`; Qwen returned the wrong
answer `45`. Both gave wrong answers for the discount calculation (56 and 58
instead of 68). Expected answers and unmodified model outputs are retained
in the raw report so formatting failures remain distinguishable from factual errors.

## Method

- Apple M4 Max, 14 CPU cores (10 performance), 32 GPU cores, 36 GB RAM;
  macOS 26.5, AC power, ordinary desktop workload.
- Stock llama.cpp b10090, commit `7347430f4`, Metal. No vendor runtime fork.
- One server at a time, context 17,408, one slot, 10 inference/batch threads,
  all layers offloaded, flash attention off, f16 K/V, temperature 0, seed 42.
- Block order: Bonsai, Qwen, Qwen, Bonsai, Bonsai, Qwen. Each block includes
  one warmup per workload and ten measured repetitions. Workload order rotates.
- 300 measured speed requests, 30 warmups, 40 task answers; no recorded errors.
- Short prompts used identical text and each model's own chat template.
  Observed prompt lengths matched: 39, 578, and 57 tokens. Long prompts use
  synthetic token padding to exactly 4,096 or 16,384 tokens. They measure
  context-length cost, not long-context understanding.
- TTFT is client wall time to first nonempty streamed content; decode throughput
  is the server's reported token-generation rate. Percentiles use nearest rank.
- Thermal state, energy consumption, and GPU power were not measured. This is
  not an FP16 comparison and does not reproduce vendor hardware or MLX claims.

## Provenance and Reproduction

| Model | Hugging Face repository | Immutable revision | SHA-256 |
| --- | --- | --- | --- |
| Bonsai-8B-Q1_0.gguf | prism-ml/Bonsai-8B-gguf | 48516770dd04643643e9f9019a2a349cf26c5dbd | 284a335aa3fb2ced3b1b01fcb40b08aa783e3b70832767f0dd2e3fdfa134bd54 |
| Qwen3-8B-Q4_K_M.gguf | Qwen/Qwen3-8B-GGUF | 7c41481f57cb95916b40956ab2f0b139b296d974 | d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785 |

The macOS-local harness is [scripts/bonsai-comparison.rb](../../scripts/bonsai-comparison.rb).
Its report hardware/runtime labels describe this verified host and build;
do not reuse them for other hardware or binaries. It verifies both weight
digests before loading, checks server PID/listener ownership, and stops only
its own server. It uses the installed Homebrew llama.cpp binary and port 48343.
The runtime download is separate; do not download models in automated tests.

```sh
ruby scripts/bonsai-comparison.rb --self-test
ruby scripts/bonsai-comparison.rb NEW_OUTPUT_DIRECTORY BONSAI_GGUF QWEN_GGUF
```

Use a new output directory to preserve previous results. Raw samples, task
outputs, startup properties, and six server logs for this run are retained
locally under `test-results/bonsai-comparison/` (ignored generated evidence).

The temporary comparison view and `/api/benchmarks` endpoint have been removed
from the GUI. Measurements remain standalone local evidence; they do not change
the catalog or published throughput calibration. An old
`RIGSPARK_HOME/benchmark-report.json` file is no longer read or served.