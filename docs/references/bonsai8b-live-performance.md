# Bonsai 8B Live Performance Check

Local date: 2026-10-01. Benchmark timestamps: 2026-09-30T21:15Z (UTC).
Result: real inference and local throughput measured; vendor claims only partially
validated. No catalog performance calibration or release evidence was promoted.

## Environment

- MacBook Pro Mac16,6, Apple M4 Max, 14 CPU cores (10 performance, 4 efficiency),
  32 GPU cores, 36 GB unified memory; AC power.
- macOS 26.5 (25F71), Metal 4.
- Homebrew llama.cpp build 10090, commit `7347430f4`, AppleClang 21.0.0.21000099;
  ggml 0.17.0; stock Metal backend, no PrismML fork installed.
- RigSpark workspace HEAD `92408d4`, with uncommitted Bonsai admission and GUI
  honesty fixes. This is a development-worktree measurement, not a release benchmark.
- Normal desktop applications remained open. End-of-run load averages were
  6.97 / 6.20 / 6.57. Thermal state, competing GPU load and energy were not measured.

## Artifact and Live Lifecycle

Official repository `prism-ml/Bonsai-8B-gguf`, revision
`48516770dd04643643e9f9019a2a349cf26c5dbd`, file `Bonsai-8B-Q1_0.gguf`.
Downloaded through production RigSpark acquisition, then independently checked:

- File size: 1,158,654,496 bytes.
- SHA-256: `284a335aa3fb2ced3b1b01fcb40b08aa783e3b70832767f0dd2e3fdfa134bd54`.
- llama.cpp tensor payload: 1,152,704,128 bytes; 8,188,548,096 parameters.
- Cache mode: 0600. Isolated home: `/tmp/rigspark-bonsai-live.IMwScp`.

`rigspark up bonsai:8b --backend llamacpp --port 48341 --catalog-path
crates/rigspark-core/data/models.json --no-tui --json` verified and started the
model. The owned listener was `127.0.0.1:48341`, PID 25361, and `/v1/models`
identified `bonsai:8b`, Q1_0, and the expected parameter count. Adapter-backed
`rigspark chat --no-memory` returned exactly `BONSAI_SMOKE_OK` for the marker
request. A second startup reused the cached path with two progress notifications;
network traffic was not independently traced. Its owned PID was 28383.

Both servers were stopped through RigSpark. Their PIDs exited, port 48341 was
released, isolated active state was cleared, and no partial/lock files remained.
The verified cache is retained to avoid another 1.16 GB download. Normal user
runtime state was not used or modified.

## Measured Results

`llama-bench` used five repetitions with warmup enabled, 10 CPU threads, all GPU
layers (`-ngl 99`), flash attention off, f16 K/V cache, mmap on, default batch
2048 / microbatch 512, and offline mode. Values below are sample mean and sample
standard deviation reported by the tool, not confidence intervals.

| Workload | Measured rate |
| --- | --- |
| Prompt processing, 512 tokens (`pp512`) | 761.18 +/- 0.99 tok/s |
| Decode, 128 tokens, depth 0 (`tg128`) | 143.72 +/- 0.46 tok/s |
| Combined 512 prompt + 128 decode (`pp512+tg128`) | 383.84 +/- 4.08 total tok/s |

The combined rate counts prompt and generated tokens together; it is not a
decode-only rate. Reproduce the separate tests with:

```sh
llama-bench --offline -m /path/to/Bonsai-8B-Q1_0.gguf -p 512 -n 128 -r 5 -t 10 -ngl 99 -fa off -ctk f16 -ctv f16 -o json
```

Three additional direct `/completion` timing requests used a 20-token plain-text
prompt, `n_predict=128`, `ignore_eos=true`, `temperature=0`, `seed=42`, and
`cache_prompt=false`. Reported cached prompt tokens were zero. Server decode rates
were 154.36, 156.26 and 155.42 tok/s (mean 155.35); wall times were 0.894, 0.874
and 0.875 seconds. These are a different workload/configuration from llama-bench,
not a replacement for its measurements or an instruction-following quality test.

The short benchmark process reported 1,371,127,808 bytes maximum RSS (~1.28 GiB).
The production server defaulted to 65,536 context and four slots and showed
10,651,536 KiB RSS (~10.16 GiB) after inference. RSS is not a complete accounting
of Metal allocations. The vendor's 1.15 GB figure is weight storage, not total
application memory at arbitrary context/concurrency.

## Claim Assessment

- **1.15 GB weights:** consistent with the measured 1.153 GB tensor payload. The
  file is slightly larger because it contains metadata and tokenizer data.
- **Fast local decoding:** demonstrated here at approximately 144 benchmark
  tok/s and 155 server tok/s on this M4 Max.
- **85 tok/s llama.cpp Metal on M4 Pro 48 GB:** not reproduced on identical
  hardware. Our faster M4 Max result is compatible with, but does not verify, it.
- **131 tok/s on M4 Pro from the announcement:** not verified; the announcement
  and GGUF model-card results use different runtime/settings. No MLX run was made.
- **368 tok/s on RTX 4090, 4-5x energy savings, 12-14x speed/size comparisons,
  and quality benchmarks:** not empirically verified. No NVIDIA hardware, power
  measurements, FP16 baseline download/run, or quality evaluation suite was used.

Sources: [announcement](https://prismml.com/news/bonsai-8b) and
[pinned official GGUF card](https://huggingface.co/prism-ml/Bonsai-8B-gguf/blob/48516770dd04643643e9f9019a2a349cf26c5dbd/README.md).
Raw JSON, timing logs and marker response: `test-results/bonsai-performance/`.

## Limitation Found

The initial production command with `--context 4096` failed before acquisition:
`up: explicit runtime context currently requires Ollama`. The successful live run
omitted that flag and used llama.cpp's default context. The prior GUI test's
recorded llama.cpp/65K request only verified the outgoing payload, not successful
live handling of an explicit context override. That GUI start path remains
unverified/blocked until runtime context support is addressed; no guard was bypassed.

## Automated Checks

The preceding GUI/catalog workspace gates passed: 889 tests, zero failures, three
ignored; formatting, Clippy, build and native-retirement passed. Focused acquisition,
adapter and lifecycle tests passed before the live run. The benchmark does not
establish every capability (embedding, wrong-model rejection, races, migration)
needed for exhaustive runtime certification.