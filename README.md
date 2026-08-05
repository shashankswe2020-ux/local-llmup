# local-llmup

Hardware-aware CLI for discovering, installing, serving, and migrating local LLMs from a single command.

## Website

- Live site: https://shashankswe2020-ux.github.io/local-llmup/
- Local preview: `cd site && python3 -m http.server 8080`

## Features

- Scores your machine (**AI Hardware Score**, 0–100) and names your primary
  bottleneck — VRAM, RAM, compute, or storage.
- Answers **yes / slow / no** for any model, with the binding reason and an
  estimated tokens-per-second range (`can-run`), before you download anything.
- Detects your hardware profile and recommends models that fit — now with a
  runnability verdict and est. tok/s alongside every ranked pick.
- Installs and serves local models through Ollama with a single `up` command.
- Keeps a curated catalog of open-weight models and supports catalog refreshes.
- Supports memory migration and local diagnostics for day-to-day model management.
- No pricing data and no network calls for advice — throughput is a
  memory-bandwidth estimate from a curated, cited dataset, and unknown hardware
  reports `unknown` rather than a made-up number.

## Why local-llmup?

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

## Quickstart

1. Install locally with `npm install -g local-llmup`.
2. Start with the built-in recommendation flow: `npx local-llmup`.
3. Check whether a model will run before pulling it: `npx local-llmup can-run <model>`.
4. Install and serve a specific model: `npx local-llmup up <model>`.
5. Chat with the active model and record memory: `npx local-llmup chat`.
6. Score your machine and spot bottlenecks: `npx local-llmup doctor`.

## One-liners

- `npx local-llmup` — run the default recommendation flow.
- `npx local-llmup can-run <model>` — get a yes/slow/no verdict + est. tok/s.
- `npx local-llmup up <model>` — install and serve a model.
- `npx local-llmup chat [-m <model>]` — chat with a model and record memory.
- `npx local-llmup doctor` — score hardware and report the primary bottleneck.
- `npx local-llmup catalog [--refresh]` — inspect or refresh the model catalog.

## Example Output

```text
npx local-llmup
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable):

Rank  Model              Params  Quant   Est. Mem  Verdict  Est. tok/s  License      Score
   1  qwen3:30b-a3b         30B  Q4_K_M  19.8 GiB  ✓ yes        28–52   apache-2.0    0.78
   2  qwen3:14b             14B  Q4_K_M   9.6 GiB  ✓ yes        22–41   apache-2.0    0.50
   3  gemma3:12b            12B  Q4_K_M   7.8 GiB  ✓ yes        24–45   gemma         0.47
   4  llama3.1:8b            8B  Q4_K_M   5.2 GiB  ✓ yes        30–56   llama-3.1     0.41
   5  gemma2:2b              2B  Q4_K_M   1.8 GiB  ✓ yes       110–204  gemma         0.43

Run the top pick:  local-llmup up qwen3:30b-a3b

Won't fit (2):
  ❌ llama3.1:70b  (ram-bound)
  ❌ mixtral:8x22b  (ram-bound)
```

Check a single model before you download it (exits non-zero only for `no`, so
it is safe to use as a gate):

```text
npx local-llmup can-run llama3.1:8b
✓ llama3.1:8b: yes — runs comfortably
Quant: Q4_K_M
Estimated throughput: 30–56 tok/s

npx local-llmup can-run llama3.1:70b
❌ llama3.1:70b: no — does not fit (ram-bound: not enough RAM)
```

Score your machine and see the bottleneck holding you back:

```text
npx local-llmup doctor
...
AI Hardware Score: 72/100
Primary bottleneck: VRAM
```

## Commands

| Command | One-liner | Purpose |
|---|---|---|
| `recommend` | `npx local-llmup` (default) or `npx local-llmup recommend` | Detect hardware and print ranked models with a runnability verdict, est. tok/s, and install commands. |
| `can-run` | `npx local-llmup can-run <model>` | Answer yes / slow / no for one model, with the binding reason and an estimated tok/s range. Exits non-zero only for `no`. |
| `up` | `npx local-llmup up <model>` | Install (if needed) and start a local server for `<model>`. |
| `chat` | `npx local-llmup chat [-m <model>]` | Interactive or piped chat that records memory. |
| `down` | `npx local-llmup down [model]` | Stop the local server owned by local-llmup. |
| `switch` | `npx local-llmup switch <model>` | Make `<model>` the active served model without moving memory. |
| `migrate` | `npx local-llmup migrate --from <a> --to <b>` | Move memory from one model to another. |
| `ls` | `npx local-llmup ls` | List installed models and the active model. |
| `catalog` | `npx local-llmup catalog [--refresh]` | Show the catalog or refresh it locally. |
| `doctor` | `npx local-llmup doctor` | Diagnose hardware, backend, disk, ports, and state, and report the AI Hardware Score + primary bottleneck. |

## Requirements

- Node.js 18 or newer.
- Ollama installed locally for model serving and lifecycle commands.
- No API keys are required for the local workflow.
