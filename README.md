# local-llmup

Hardware-aware CLI for discovering, installing, serving, and migrating local LLMs from a single command.

## Features

- Detects your hardware profile and recommends models that fit your machine.
- Installs and serves local models through Ollama with a single `up` command.
- Keeps a curated catalog of open-weight models and supports catalog refreshes.
- Supports memory migration and local diagnostics for day-to-day model management.

## Quickstart

1. Install locally with `npm install -g local-llmup`.
2. Start with the built-in recommendation flow: `npx local-llmup`.
3. Install and serve a specific model: `npx local-llmup up <model>`.
4. Chat with the active model and record memory: `npx local-llmup chat`.
5. Inspect the catalog: `npx local-llmup catalog`.

## One-liners

- `npx local-llmup` — run the default recommendation flow.
- `npx local-llmup up <model>` — install and serve a model.
- `npx local-llmup chat [-m <model>]` — chat with a model and record memory.
- `npx local-llmup catalog [--refresh]` — inspect or refresh the model catalog.

## Example Output

```text
npx local-llmup
Ranked local LLMs for arm64/darwin (34.0 GiB ram usable):

Rank  Model              Params  Quant   Est. Mem  License              Score
	 1  qwen3:30b-a3b         30B  Q4_K_M  19.8 GiB  apache-2.0            0.78
	 2  kimi-vl-a3b           16B  Q4_K_M  10.7 GiB  modified-mit          0.66
	 3  qwen3:32b             32B  Q4_K_M  20.9 GiB  apache-2.0            0.61
	 4  deepseek-r1:32b       32B  Q4_K_M  20.9 GiB  apache-2.0            0.59
	 5  qwen2.5-coder:32b     32B  Q4_K_M  20.9 GiB  apache-2.0            0.57
	 6  gemma3:27b            27B  Q4_K_M  17.1 GiB  gemma                 0.57
	 7  qwen2.5:32b           32B  Q4_K_M  20.9 GiB  apache-2.0            0.56
	 8  yi:34b                34B  Q4_K_M  22.0 GiB  apache-2.0            0.53
	 9  mistral-small:24b     24B  Q4_K_M  15.1 GiB  apache-2.0            0.53
	10  gemma2:27b            27B  Q4_K_M  17.1 GiB  gemma                 0.52
	11  qwen3:14b             14B  Q4_K_M   9.6 GiB  apache-2.0            0.50
	12  gemma3:4b              4B  Q4_K_M   2.7 GiB  gemma                 0.49
	13  deepseek-r1:14b       14B  Q4_K_M   9.6 GiB  apache-2.0            0.48
	14  phi4:14b              14B  Q4_K_M   9.6 GiB  mit                   0.47
	15  qwen3:8b               8B  Q4_K_M   5.6 GiB  apache-2.0            0.47
	16  gemma3:12b            12B  Q4_K_M   7.8 GiB  gemma                 0.47
	17  deepseek-r1:7b         7B  Q4_K_M   5.0 GiB  apache-2.0            0.46
	18  glm4:9b                9B  Q4_K_M   5.9 GiB  mit                   0.46
	19  granite3-moe:3b        3B  Q4_K_M   2.1 GiB  apache-2.0            0.46
	20  granite3.1:2b          2B  Q4_K_M   1.6 GiB  apache-2.0            0.46
	21  qwen2.5:3b             3B  Q4_K_M   2.0 GiB  qwen                  0.45
	22  deepseek-r1:8b         8B  Q4_K_M   5.2 GiB  llama-3.1-community   0.45
	23  qwen2.5:14b           14B  Q4_K_M   9.6 GiB  apache-2.0            0.45
	24  llama3.2:3b            3B  Q4_K_M   2.1 GiB  llama-3.2-community   0.45
	25  olmo2:13b             13B  Q4_K_M   8.5 GiB  apache-2.0            0.45
	26  phi3.5:mini          3.8B  Q4_K_M   2.5 GiB  mit                   0.44
	27  qwen2.5-coder:7b       7B  Q4_K_M   5.0 GiB  apache-2.0            0.44
	28  phi3:mini            3.8B  Q4_K_M   2.5 GiB  mit                   0.44
	29  granite3.1:8b          8B  Q4_K_M   5.2 GiB  apache-2.0            0.43
	30  gemma2:2b              2B  Q4_K_M   1.8 GiB  gemma                 0.43
	31  olmo2:7b               7B  Q4_K_M   4.6 GiB  apache-2.0            0.43
	32  qwen2.5:7b             7B  Q4_K_M   5.0 GiB  apache-2.0            0.43
	33  smollm2:1.7b         1.7B  Q4_K_M   1.2 GiB  apache-2.0            0.42
	34  mistral-nemo:12b      12B  Q4_K_M   7.6 GiB  apache-2.0            0.42
	35  qwen2.5:1.5b         1.5B  Q4_K_M   1.1 GiB  apache-2.0            0.42
	36  mistral:7b             7B  Q4_K_M   4.7 GiB  apache-2.0            0.41
	37  llama3.1:8b            8B  Q4_K_M   5.2 GiB  llama-3.1-community   0.41
	38  gemma2:9b              9B  Q4_K_M   5.8 GiB  gemma                 0.40
	39  yi:6b                  6B  Q4_K_M   3.9 GiB  apache-2.0            0.40
	40  yi:9b                  9B  Q4_K_M   5.7 GiB  apache-2.0            0.40
	41  llama3.2:1b            1B  Q4_K_M   0.9 GiB  llama-3.2-community   0.40
	42  qwen2.5:0.5b         0.5B  Q4_K_M   0.4 GiB  apache-2.0            0.39
	43  smollm2:360m         360M  Q4_K_M   0.3 GiB  apache-2.0            0.38
	44  smollm2:135m         135M  Q4_K_M   0.1 GiB  apache-2.0            0.38

Run the top pick:  local-llmup up qwen3:30b-a3b

Won't fit (14):
	kimi-k2-thinking  (ram-bound)
	kimi-linear  (ram-bound)
	kimi-k2:base  (ram-bound)
	kimi-k2:instruct  (ram-bound)
	kimi-dev-72b  (ram-bound)
	qwen3:235b-a22b  (ram-bound)
	deepseek-r1:671b  (ram-bound)
	deepseek-r1:70b  (ram-bound)
	deepseek-v3  (ram-bound)
	llama3.3:70b  (ram-bound)
	qwen2.5:72b  (ram-bound)
	llama3.1:70b  (ram-bound)
	mixtral:8x22b  (ram-bound)
	mixtral:8x7b  (ram-bound)
```

```text
local-llmup up qwen3:30b-a3b
Pulling qwen3:30b-a3b (Q4_K_M)...
	pulling manifest ⠋ pulling manifest ⠹ pulling manifest ⠹ pulling manifest ⠼ pulling manifest ⠼ pulling manifest ⠴ pulling manifest ⠦ pulling manifest ⠧ pulling manifest ⠇ pulling manifest ⠏ pulling manifest ⠋ pulling manifest ⠙ pulling manifest ⠹ pulling manifest ⠸ pulling manifest ⠴ pulling manifest ⠴ pulling manifest ⠧ pulling manifest ⠧ pulling manifest ⠇ pulling manifest ⠏ pulling manifest ⠋ pulling manifest ⠙ pulling manifest ⠹ pulling manifest ⠸ pulling manifest ⠼ pulling manifest ⠴ pulling manifest ⠦ pulling manifest ⠧ pulling manifest ⠇ pulling manifest ⠏ pulling manifest ⠋ pulling manifest ⠙ pulling manifest ⠹ pulling manifest ⠼ pulling manifest
	pulling 58574f2e94b9:   0% ▕                  ▏ 2.7 MB/ 18 GB                  pulling manifest
	pulling 58574f2e94b9:   0% ▕                  ▏ 4.2 MB/ 18 GB                  pulling manifest
	pulling 58574f2e94b9:   0% ▕                  ▏ 8.4 MB/ 18 GB                  pulling manifest
	pulling 58574f2e94b9:   0% ▕                  ▏  11 MB/ 18 GB                  pulling manifest
	pulling 58574f2e94b9:   0% ▕                  ▏  11 MB/ 18 GB                  pulling manifest   verifying sha256 digest ⠧ pulling manifest
	pulling 58574f2e94b9: 100% ▕█████████████████ ▏  18 GB/ 18 GB   45 MB/s      0s
	verifying sha256 digest ⠇ pulling manifest
	pulling 58574f2e94b9: 100% ▕█████████████████ ▏  18 GB/ 18 GB   45 MB/s      0s
	verifying sha256 digest
	writing manifest
	success
```

## Commands

| Command | One-liner | Purpose |
|---|---|---|
| `recommend` | `npx local-llmup` (default) or `npx local-llmup recommend` | Detect hardware and print ranked models plus install commands. |
| `up` | `npx local-llmup up <model>` | Install (if needed) and start a local server for `<model>`. |
| `chat` | `npx local-llmup chat [-m <model>]` | Interactive or piped chat that records memory. |
| `down` | `npx local-llmup down [model]` | Stop the local server owned by local-llmup. |
| `switch` | `npx local-llmup switch <model>` | Make `<model>` the active served model without moving memory. |
| `migrate` | `npx local-llmup migrate --from <a> --to <b>` | Move memory from one model to another. |
| `ls` | `npx local-llmup ls` | List installed models and the active model. |
| `catalog` | `npx local-llmup catalog [--refresh]` | Show the catalog or refresh it locally. |
| `doctor` | `npx local-llmup doctor` | Diagnose hardware, backend, disk, ports, and state. |

## Requirements

- Node.js 18 or newer.
- Ollama installed locally for model serving and lifecycle commands.
- No API keys are required for the local workflow.
