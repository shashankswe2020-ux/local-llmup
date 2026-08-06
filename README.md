# local-llmup

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-634%20passing-brightgreen.svg)](#development)
[![Ollama](https://img.shields.io/badge/runtime-Ollama-000000.svg)](https://ollama.com)

**Know which local LLMs will actually run on your machine — `yes / slow / no`,
with an estimated tokens-per-second range — in one command, before you download
anything.**

`local-llmup` is a hardware-aware CLI for discovering, sizing, installing,
serving, and migrating local LLMs. It detects your hardware, scores it, and
ranks a curated catalog of open-weight models by what fits and how fast it will
go — then drives the whole Ollama lifecycle from a single tool.

---

## Table of contents

- [What makes it different](#what-makes-it-different)
- [Requirements](#requirements)
- [Install](#install)
- [60-second tour (end-to-end)](#60-second-tour-end-to-end)
- [Command reference (with real output)](#command-reference-with-real-output)
  - [`recommend`](#recommend--the-default-command)
  - [`can-run`](#can-run)
  - [`doctor`](#doctor)
  - [`catalog`](#catalog)
  - [`up`](#up)
  - [`chat`](#chat)
  - [`ls`](#ls)
  - [`switch`](#switch)
  - [`down`](#down)
  - [`migrate`](#migrate)
- [How the advice is computed](#how-the-advice-is-computed)
- [Scripting & exit codes](#scripting--exit-codes)
- [local-llmup vs. using Ollama directly](#local-llmup-vs-using-ollama-directly)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## What makes it different

Most tools tell you a model exists. `local-llmup` tells you whether **your**
machine can run it, how fast, and how much context it can hold — and it never
makes up a number to do so.

- **Runnability, not vibes.** Every model gets a `yes / slow / no` verdict with
  the *binding reason* (`ram-bound`, `vram-bound`, `disk-bound`,
  `context-bound`) and an estimated tok/s range — computed **before** any
  download.
- **AI Hardware Score (0–100) + bottleneck.** `doctor` scores your machine and
  names the one thing holding you back (VRAM, RAM, compute, or storage).
- **Context-window-aware KV-cache sizing.** `recommend --context <n>` re-ranks
  with the KV cache sized at your chosen window; `recommend --max-context`
  reports the largest context each model can hold on *your* RAM/VRAM. Attention
  geometry is sourced from a cited dataset — GQA-correct — and fp16 KV is stated
  explicitly.
- **An honesty gate, everywhere.** When a figure can't be sourced (unknown
  hardware bandwidth, missing attention geometry), the output says `unknown`
  rather than guessing. Models with unknown geometry are still ranked by their
  weights — never silently dropped.
- **No network calls for advice. No pricing data.** Throughput is a
  memory-bandwidth estimate from a curated, cited, offline dataset. Advice is
  deterministic and reproducible.
- **Integrity-verified installs.** `up` verifies pulled weights against a
  catalog digest (or a size fallback) and **fails closed** on a mismatch — it
  never serves unverified weights.
- **Loopback-only serving.** Servers bind `127.0.0.1` by default; nothing is
  exposed to your network.
- **Portable memory.** `chat` records conversation memory; `migrate` moves it
  between models (remapping context and re-embedding as needed).
- **Scriptable by design.** Stable text output, `--json` on the advice
  commands, and a clean exit-code contract (`can-run` exits non-zero *only* for
  `no`).

## Requirements

- **Node.js 18+** (uses native `fetch`).
- **[Ollama](https://ollama.com)** installed locally for serving and lifecycle
  commands (`up`, `down`, `switch`, `chat`, `migrate`). The advice commands
  (`recommend`, `can-run`, `doctor`, `catalog`) work without it.
- No API keys. No accounts. No cloud.

## Install

```bash
# Global install
npm install -g local-llmup

# …or run without installing
npx local-llmup
```

Verify the install:

```text
$ local-llmup --version
0.3.0
```

The top-level `--help` lists every command:

```text
$ local-llmup --help
local-llmup/0.3.0

Usage:
  $ local-llmup

Commands:
  recommend        Detect hardware and print ranked local LLMs + install commands.
  can-run <model>  Answer yes|slow|no whether this machine can run <model>, with an estimated tok/s range.
  up <model>       Install (if needed) and start a local server for <model>.
  chat             Interactive/piped chat that records memory.
  down [model]     Stop a server owned by local-llmup, or detach+forget an attached daemon without stopping it.
  switch <model>   Make <model> the active served model (no memory move).
  migrate          Move all memory from one model to another.
  ls               List active server state from local state (not installed-model inventory).
  catalog          Show or refresh the model catalog.
  doctor           Diagnose hardware, backend, disk, ports, and state.

Options:
  --task <task>       Boost models for a task: chat|code|vision|reasoning|tools|embedding
  --context <tokens>  Size the KV cache at this context (tokens) and re-rank
  --max-context       Report the largest context each model can hold on this hardware
  --json              Emit machine-readable JSON
  -h, --help          Display this message
  -v, --version       Display version number
```

## 60-second tour (end-to-end)

A typical first session, start to finish:

```text
# 1. What can this machine run, and how fast?
$ npx local-llmup

# 2. Sanity-check one model as a scriptable gate.
$ npx local-llmup can-run llama3.1:8b

# 3. Pull + serve it (loopback-only, integrity-verified).
$ npx local-llmup up llama3.1:8b

# 4. Chat with the active model; the exchange is recorded to memory.
$ npx local-llmup chat

# 5. See what is currently active.
$ npx local-llmup ls

# 6. Move that memory to a stronger model, then serve it.
$ npx local-llmup migrate --from llama3.1:8b --to qwen3:14b
$ npx local-llmup switch qwen3:14b

# 7. Stop the server when you are done.
$ npx local-llmup down
```

Each of those commands is shown with real output below.

---

## Command reference (with real output)

> The logs below are captured from a real run on an Apple Silicon machine
> (arm64/darwin, 34.0 GiB usable memory). Your numbers will differ — that's the
> point. Long tables are trimmed to the top rows; the tool prints the full list.

### `recommend` — the default command

Detect hardware and print every catalog model that fits, ranked, each with a
verdict, estimated throughput, license, and a fitness score. `recommend` is the
**default command**, so `npx local-llmup` and `npx local-llmup recommend` are
the same.

```text
$ npx local-llmup recommend
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable):

Rank  Model              Params  Quant   Est. Mem  Verdict     Est. tok/s  License              Score
   1  qwen3:30b-a3b         30B  Q4_K_M  19.8 GiB  ✓ yes       55.6–103.3  apache-2.0            0.78
   2  kimi-vl-a3b           16B  Q4_K_M  10.7 GiB  ✓ yes       55.6–103.3  modified-mit          0.66
   3  qwen3:32b             32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.61
   4  deepseek-r1:32b       32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.59
   5  qwen2.5-coder:32b     32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.57
   6  gemma3:27b            27B  Q4_K_M  17.1 GiB  ⚠️ slow       6.2–11.5  gemma                 0.57
   7  qwen2.5:32b           32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.56
   8  yi:34b                34B  Q4_K_M  22.0 GiB  ⚠️ slow        4.9–9.1  apache-2.0            0.53
   … 36 more fitting models …

Run the top pick:  local-llmup up qwen3:30b-a3b

Won't fit (14):
  ❌ kimi-k2-thinking  (ram-bound)
  ❌ qwen3:235b-a22b  (ram-bound)
  ❌ deepseek-r1:671b  (ram-bound)
  ❌ llama3.3:70b  (ram-bound)
  ❌ llama3.1:70b  (ram-bound)
  ❌ mixtral:8x22b  (ram-bound)
  … 8 more …
```

**Bias the ranking toward a task** with `--task` (`chat`, `code`, `vision`,
`reasoning`, `tools`, `embedding`). Task-capable models are boosted; the rest
still appear:

```text
$ npx local-llmup recommend --task code
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable):

Rank  Model              Params  Quant   Est. Mem  Verdict     Est. tok/s  License              Score
   1  qwen3:30b-a3b         30B  Q4_K_M  19.8 GiB  ✓ yes       55.6–103.3  apache-2.0            0.78
   2  qwen3:32b             32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.61
   3  deepseek-r1:32b       32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.59
   4  qwen2.5-coder:32b     32B  Q4_K_M  20.9 GiB  ⚠️ slow        5.2–9.7  apache-2.0            0.57
   … more …
```

**Size the KV cache at a specific context window** with `--context <tokens>`.
This re-ranks using weights **plus** the fp16 KV cache at that context, and adds
`Weights` and `KV Cache` columns. A model that fits at 4K can OOM at 128K — this
catches it. `unknown` in the `KV Cache` column means the model's attention
geometry isn't in the dataset yet; it is still ranked by its weights:

```text
$ npx local-llmup recommend --context 32768
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable): — sized at 32768-token context (KV fp16)

Rank  Model              Params  Quant    Weights  KV Cache  Est. Mem  Verdict   Est. tok/s  License              Score
   1  qwen3:30b-a3b         30B  Q4_K_M  17.2 GiB   unknown  19.8 GiB  ✓ yes     55.6–103.3  apache-2.0            0.78
   6  mistral-small:24b     24B  Q4_K_M  13.1 GiB   5.0 GiB  18.8 GiB  ⚠️ slow       7–12.9  apache-2.0            0.56
   9  qwen2.5:14b           14B  Q4_K_M   8.4 GiB   6.0 GiB  14.8 GiB  ✓ yes      11.9–22.1  apache-2.0            0.50
   … more …
```

**Ask how far each model's context can stretch** on your hardware with
`--max-context`. The `Bound-By` column tells you what caps it: `hardware`
(memory), `model` (the model's own context limit), or `unknown` (geometry not in
the dataset):

```text
$ npx local-llmup recommend --max-context
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable): — largest holdable context per model (KV fp16)

Rank  Model              Params  Quant   Est. Mem  Max Context  Bound-By  Verdict   Est. tok/s  License              Score
   1  qwen3:30b-a3b         30B  Q4_K_M  19.8 GiB      unknown  unknown   ✓ yes     55.6–103.3  apache-2.0            0.78
   5  qwen2.5-coder:32b     32B  Q4_K_M  20.9 GiB       40,268  hardware  ⚠️ slow       5.2–9.7  apache-2.0            0.57
   9  mistral-small:24b     24B  Q4_K_M  15.1 GiB       32,768  model     ⚠️ slow        7–12.9  apache-2.0            0.53
   … more …
```

`--context` and `--max-context` are **mutually exclusive**. Both add fields to
`--json` additively (including `"kvPrecision": "fp16"`) and leave the default
no-flag output unchanged. Invalid input fails fast with a non-zero exit:

```text
$ npx local-llmup recommend --context 0
recommend: --context must be an integer in 1..10000000: 0

$ npx local-llmup recommend --context 8192 --max-context
recommend: --context and --max-context are mutually exclusive
```

**Machine-readable output** with `--json`:

```json
{
  "hardware": { "arch": "arm64", "platform": "darwin", "usableBytes": 36507222016 },
  "ranked": [
    {
      "rank": 1,
      "id": "qwen3:30b-a3b",
      "params": "30B",
      "quant": "Q4_K_M",
      "requiredBytes": 21260320768,
      "verdict": "yes",
      "score": 0.78,
      "throughput": { "known": true, "lowTokPerSec": 55.6, "highTokPerSec": 103.3 }
    }
  ],
  "wontFit": [ { "id": "llama3.1:70b", "reason": "ram-bound" } ],
  "command": "local-llmup up qwen3:30b-a3b"
}
```

### `can-run`

Answer `yes / slow / no` for a single model, with the binding reason and an
estimated throughput range. It **exits non-zero only for `no`**, so it works as
a gate in scripts and CI.

```text
$ npx local-llmup can-run llama3.1:8b
✓ llama3.1:8b: yes — runs comfortably
Quant: Q4_K_M
Estimated throughput: 20.9–38.7 tok/s
```

```text
$ npx local-llmup can-run llama3.1:70b
❌ llama3.1:70b: no — does not fit (ram-bound: not enough RAM)
```

With `--json`:

```text
$ npx local-llmup can-run qwen3:14b --json
{
  "model": "qwen3:14b",
  "verdict": "yes",
  "quant": "Q4_K_M",
  "reason": null,
  "throughput": {
    "known": true,
    "lowTokPerSec": 11.9,
    "highTokPerSec": 22.1
  }
}
```

### `doctor`

Diagnose hardware, backend, disk, ports, and recorded state, then report the AI
Hardware Score (0–100) and your primary bottleneck. Exits non-zero if any check
fails.

```text
$ npx local-llmup doctor
Check     Status  Detail
hardware  OK      arm64/darwin, 34.0 GiB usable memory, 776.1 GiB free disk
backend   OK      ollama is installed
catalog   OK      58 model(s), all digests verified
state     OK      no active server recorded

AI Hardware Score: 80/100
Primary bottleneck: RAM

All checks passed.
```

`--json` emits the full report including the score breakdown:

```text
$ npx local-llmup doctor --json
{
  "checks": [
    { "name": "hardware", "status": "ok", "detail": "arm64/darwin, 34.0 GiB usable memory, 776.1 GiB free disk" },
    { "name": "backend",  "status": "ok", "detail": "ollama is installed" },
    { "name": "catalog",  "status": "ok", "detail": "58 model(s), all digests verified" },
    { "name": "state",    "status": "ok", "detail": "no active server recorded" }
  ],
  "ok": true,
  "hardwareScore": {
    "total": 80,
    "sub": { "vram": 1, "ram": 0.5625, "compute": 0.65, "storage": 1 },
    "bottleneck": "ram"
  }
}
```

### `catalog`

Inspect the curated catalog. By default it shows only models that fit your
hardware; `--all` shows every model; `--refresh` runs local enrichment and
prints a dry-run diff without writing.

```text
$ npx local-llmup catalog
Catalog (Filter: fits, shown: 44/58)
Model              Params  Arch   Quant   Need GiB  Fit  Release
qwen3:14b          14B     dense  Q4_K_M       9.6  fit  2025-04-28
qwen3:30b-a3b      30B     moe    Q4_K_M      19.8  fit  2025-04-28
qwen3:32b          32B     dense  Q4_K_M      20.9  fit  2025-04-28
qwen3:8b           8B      dense  Q4_K_M       5.6  fit  2025-04-28
glm4:9b            9B      dense  Q4_K_M       5.9  fit  2025-04-14
gemma3:12b         12B     dense  Q4_K_M       7.8  fit  2025-03-12
gemma3:27b         27B     dense  Q4_K_M      17.1  fit  2025-03-12
mistral-small:24b  24B     dense  Q4_K_M      15.1  fit  2025-01-30
…
```

### `up`

Bring a model online end-to-end: resolve the name against the catalog, preflight
free disk against the selected quant, ensure the backend is installed, pull and
**verify** the weights, start a loopback-only server, wait for a health probe to
pass, and record the active server. If verification fails, `up` **fails closed**
and never records a running server.

```text
$ npx local-llmup up llama3.1:8b
Pulling llama3.1:8b (Q4_K_M)...
  pulling manifest
  pulling 8eeb52dfb3bb: 100% ▕██████████████████▏ 4.7 GB
  verifying sha256 digest
  writing manifest
  success
llama3.1:8b ready at http://127.0.0.1:11434
```

Use `--port <port>` to bind a non-default port (still loopback-only).

> Note: `up` verifies the download against the catalog. If a model has no
> recorded digest, it falls back to an exact size check and rejects a mismatch —
> so a catalog whose recorded size is approximate can block the pull. See
> [Troubleshooting](#troubleshooting).

### `chat`

Chat with the active model (or `-m <model>`). Reads a turn from stdin, prints the
reply to stdout, and records the exchange to memory under a lock. Works
interactively or piped.

```text
$ echo "Give me a one-line haiku about running models locally." | npx local-llmup chat
Chatting with llama3.1:8b (http://127.0.0.1:11434). End input to exit.
Silicon whispers — your words never leave the room.
```

### `ls`

Show the active server recorded in local state (not your full installed-model
inventory).

```text
$ npx local-llmup ls
No active model.
```

After an `up`, it reports the active model and endpoint.

### `switch`

Make an already-served model the active one without moving memory. With no
active server it tells you what to do:

```text
$ npx local-llmup switch llama3.1:8b
switch: no active server to switch. Run `local-llmup up <model>` first.
```

### `down`

Stop the server owned by local-llmup (or detach+forget an attached daemon). Safe
to run when nothing is active:

```text
$ npx local-llmup down
No active server to stop.
```

### `migrate`

Move all memory from one model to another: remap the context window, carry or
re-embed the vector index, and write the target store under a lock. `--dry-run`
prints the plan and writes nothing; `--move` deletes the source after a
successful migration.

```text
$ npx local-llmup migrate --from llama3.1:8b --to qwen3:14b --dry-run
[dry-run] no changes written.
[dry-run] Planned migration: llama3.1:8b -> qwen3:14b
  turns carried:       128
  turns summarized:    12
  vectors re-embedded: 0
  context strategy:    remap
  embedding strategy:  reuse
```

---

## How the advice is computed

- **Memory footprint.** Estimated as resident weights (from the selected quant)
  plus runtime overhead. With `--context`, the flat overhead is replaced by an
  explicit fp16 **KV cache** sized from the model's attention geometry (GQA-aware),
  and the reported footprint is the larger of the two — never double-counted.
- **Verdict (`yes / slow / no`).** `yes` fits with throughput headroom; `slow`
  fits but is memory-bandwidth-limited; `no` does not fit, with the binding
  reason: `ram-bound`, `vram-bound`, `disk-bound`, or `context-bound`.
- **Throughput (est. tok/s).** A range derived from a **memory-bandwidth model**
  over a curated, cited dataset. No live benchmarking, no network calls. When
  bandwidth for your hardware is unknown, throughput reports `unknown` instead of
  guessing.
- **AI Hardware Score.** A 0–100 blend of VRAM, RAM, compute, and storage
  sub-scores; the lowest sub-score is surfaced as your bottleneck.
- **The honesty gate.** Any figure that cannot be sourced — hardware bandwidth,
  attention geometry — renders as `unknown`. Models with unknown geometry are
  ranked by weights, not dropped.

## Scripting & exit codes

- `can-run` exits `0` for `yes`/`slow` and `1` for `no` — use it as a gate:

  ```bash
  if npx local-llmup can-run llama3.1:8b; then
    npx local-llmup up llama3.1:8b
  fi
  ```

- `doctor` exits non-zero if any check fails.
- `recommend` (and its flags) exit non-zero on invalid input (bad `--context`,
  bad `--task`, or `--context` + `--max-context` together).
- `recommend`, `can-run`, and `doctor` accept `--json` for stable,
  machine-readable output.

## local-llmup vs. using Ollama directly

Ollama is the local model runtime: it downloads models, runs inference, and
provides the serving API. `local-llmup` uses Ollama underneath, but adds the
hardware-aware workflow around it.

| Feature | Ollama | local-llmup |
|---|---|---|
| Install runtime | ✅ | ✅ |
| Detect hardware | ⚠️ Internal only | ✅ User-facing |
| Recommend best model | ❌ | ✅ |
| Recommend best quantization | ❌ | ✅ |
| Choose best runtime (Ollama, llama.cpp, MLX, vLLM...) | ❌ | 🛠️ Planned |
| One-command setup | ⚠️ Partial | ✅ |

Think of it as:

> Homebrew for local LLMs.

Ollama is the sole runtime supported in the current release. The backend
interface is designed for future adapters such as llama.cpp and MLX; runtime
selection is not yet implemented.

### Using Ollama Directly vs. local-llmup

| Using Ollama directly | Using `local-llmup` |
|---|---|
| Choose a model and run commands such as `ollama pull`, `ollama run`, and `ollama serve`. | Detect hardware and get ranked model recommendations with `recommend`. |
| Decide yourself whether a model's memory requirements fit your machine. | Filter and score catalog models using hardware and estimated memory requirements. |
| Manage model switching and lifecycle commands yourself. | Install, start, stop, and switch models with `up`, `down`, and `switch`. |
| Manage conversations and any model-to-model context transfer yourself. | Record chat memory and migrate it between models with `chat` and `migrate`. |
| Troubleshoot the runtime and local setup manually. | Check hardware, backend, ports, disk, catalog, and state with `doctor`. |

Use Ollama directly when you only need a lightweight runtime or want full
manual control. Use `local-llmup` when you want hardware-aware model
selection and a consistent model-and-memory workflow. It is not a replacement
for Ollama; Ollama remains a requirement for serving models.

## Commands at a glance

| Command | Usage | Purpose |
|---|---|---|
| `recommend` | `local-llmup` (default) or `local-llmup recommend [--task <t>] [--context <n>] [--max-context] [--json]` | Rank models that fit, with verdict, est. tok/s, and KV-cache sizing. |
| `can-run` | `local-llmup can-run <model> [--json]` | `yes / slow / no` for one model. Exits non-zero only for `no`. |
| `up` | `local-llmup up <model> [--port <p>]` | Pull, verify, and serve a model on loopback. |
| `chat` | `local-llmup chat [-m <model>]` | Interactive or piped chat that records memory. |
| `ls` | `local-llmup ls` | Show the active served model recorded in state. |
| `switch` | `local-llmup switch <model>` | Make an already-served model active (no memory move). |
| `down` | `local-llmup down [model]` | Stop the server owned by local-llmup. |
| `migrate` | `local-llmup migrate --from <a> --to <b> [--move] [--dry-run]` | Move memory between models. |
| `catalog` | `local-llmup catalog [--all] [--refresh]` | Show or refresh the curated catalog. |
| `doctor` | `local-llmup doctor [--json]` | Diagnose hardware/backend/disk/ports/state + AI Hardware Score. |

## Troubleshooting

- **`up` fails with `size mismatch ... expected N bytes, found M`.** The model
  has no recorded digest, so `up` falls back to an exact size check against the
  catalog's recorded size. If that size is approximate, the check rejects the
  otherwise-valid pull. Until the catalog records a digest for that model, use
  `ollama pull <model>` directly, or pick a model that verifies (run
  `local-llmup doctor` — it reports how many catalog digests are verified).
- **`ollama is not installed`.** Install Ollama from
  [ollama.com](https://ollama.com); the advice commands (`recommend`,
  `can-run`, `doctor`, `catalog`) still work without it.
- **Throughput shows `unknown`.** Your hardware's memory bandwidth isn't in the
  dataset. `local-llmup` reports `unknown` rather than guessing.
- **`KV Cache` / `Max Context` shows `unknown`.** The model's attention geometry
  isn't in the dataset yet; the model is still ranked by its weights.

## Development

```bash
npm install          # install dev dependencies
npm run build        # compile TypeScript to dist/
npm test             # run the Vitest suite
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run bootstrap    # regenerate data/models.json
```

Local website preview:

```bash
cd site && python3 -m http.server 8080
```

## Requirements recap

- Node.js 18 or newer.
- Ollama installed locally for serving and lifecycle commands.
- No API keys are required for the local workflow.

