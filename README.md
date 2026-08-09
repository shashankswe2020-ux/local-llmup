# local-llmup

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-1459%20passing-brightgreen.svg)](#development)
[![Backends](https://img.shields.io/badge/backends-Ollama%20%7C%20llama.cpp%20%7C%20MLX%20%7C%20LM%20Studio-000000.svg)](#supported-backends)

> **Know which local LLMs will actually run on your machine — before you download anything.**

`local-llmup` is a hardware-aware CLI with an interactive terminal UI for
discovering, sizing, installing, serving, and migrating local LLMs. One command
gives you a `yes / slow / no` verdict with estimated tokens-per-second for every
model in its curated catalog — then drives the entire lifecycle from pull through
chat across four supported backends.

---

## Highlights

<div align="center">
<pre style="background:#0d1117;color:#c9d1d9;padding:16px;border-radius:8px;overflow-x:auto;">
<span style="color:#58a6ff;">local-llmup / Doctor</span>                                                       <span style="color:#3fb950;">healthy</span>
<span style="color:#30363d;">─────────────────────────────────────────────────────────────────────────────</span>
  Diagnostics
  <span style="color:#3fb950;">✓ OK</span>   hardware: arm64/darwin, 34.0 GiB usable memory, 765 GiB free disk
  <span style="color:#3fb950;">✓ OK</span>   backend: ollama is installed
  <span style="color:#3fb950;">✓ OK</span>   catalog: 58 model(s), all digests verified
  <span style="color:#3fb950;">✓ OK</span>   state: no active server recorded

  <span style="color:#58a6ff;">Backends</span>
  ollama · <span style="color:#3fb950;">installed</span> · version 0.32.5 · <span style="color:#d29922;">default</span>
  llamacpp · <span style="color:#3fb950;">installed</span> · version 10090
  lmstudio · <span style="color:#3fb950;">installed</span> · CLI commit: 71bd99c

  <span style="color:#58a6ff;">Score: 80/100</span> · Bottleneck: <span style="color:#d29922;">RAM</span>
  VRAM <span style="color:#3fb950;">1</span> · RAM <span style="color:#d29922;">0.5625</span> · Compute 0.65 · Storage <span style="color:#3fb950;">1</span>
<span style="color:#30363d;">─────────────────────────────────────────────────────────────────────────────</span>
  <span style="color:#8b949e;">q/Esc Quit · ? Help</span>
</pre>
</div>

- **Runnability verdicts.** `yes / slow / no` with binding reason and est. tok/s — **before** any download.
- **Interactive TUI.** Rich terminal interface with search, filtering, keyboard navigation, and screen-reader accessible mode. Falls back gracefully to plain text when not in a TTY.
- **4 backends.** Ollama, llama.cpp, MLX (Apple Silicon), and LM Studio — auto-selected or user-chosen.
- **AI Hardware Score (0–100).** Diagnose your machine's bottleneck in one command.
- **Context-window sizing.** KV-cache-aware memory estimates with GQA-correct attention geometry.
- **Honesty gate.** Unknown figures render as `unknown` — never fabricated.
- **Integrity-verified installs.** SHA-256 digest checks; fail-closed on mismatch.
- **Loopback-only.** Servers bind `127.0.0.1` — nothing exposed to the network.
- **Portable memory.** Chat history follows you between models via `migrate`.
- **Scriptable.** Stable text + `--json`, clean exit codes, zero network for advice.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Terminal UI](#terminal-ui)
- [Commands](#commands)
- [Supported Backends](#supported-backends)
- [How Advice Works](#how-advice-works)
- [Scripting & Exit Codes](#scripting--exit-codes)
- [local-llmup vs. Ollama](#local-llmup-vs-ollama)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Install

```bash
npm install -g local-llmup
```

Or run without installing:

```bash
npx local-llmup
```

**Requirements:** Node.js 18+ · No API keys · No cloud accounts

For lifecycle commands (`up`, `down`, `chat`, `switch`, `migrate`), you need at
least one backend installed:
- [Ollama](https://ollama.com) (recommended default)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (`brew install llama.cpp`)
- [MLX](https://github.com/ml-explore/mlx-lm) (`pip install "mlx-lm==0.31.3"`, Apple Silicon only)
- [LM Studio](https://lmstudio.ai) (attach-only, bring your own server)

---

## Quick Start

```bash
# 1. What can this machine run?
local-llmup

# 2. Check a specific model
local-llmup can-run llama3.1:8b

# 3. Pull + verify + serve (loopback-only)
local-llmup up llama3.1:8b

# 4. Chat (records memory)
local-llmup chat

# 5. Migrate memory to a better model
local-llmup migrate --from llama3.1:8b --to qwen3:14b
local-llmup switch qwen3:14b

# 6. Stop when done
local-llmup down
```

```mermaid
flowchart LR
    HW([Your Hardware]) --> REC["recommend<br/>rank what fits"]
    REC --> CR{"can-run?"}
    CR -- "yes / slow" --> UP["up<br/>pull + verify + serve"]
    CR -- "no" --> REC
    UP --> CHAT["chat<br/>records memory"]
    CHAT --> MIG["migrate<br/>carry memory over"]
    MIG --> SW["switch<br/>change active model"]
    SW --> DOWN["down<br/>stop server"]
```

---

## Terminal UI

v0.6.0 introduces a full interactive terminal UI that activates automatically
when running in a capable terminal (TTY with ≥60 columns, ≥16 rows).

### Features

| Feature | Description |
|---------|-------------|
| **Interactive model list** | Search, filter, scroll through ranked models with keyboard |
| **Model details & comparison** | Mark models and compare side-by-side |
| **Lifecycle progress** | Real-time pull/verify/serve progress with cancellation |
| **Chat screen** | Multi-line input, streaming responses, session summary |
| **Doctor dashboard** | Box-drawn diagnostics with backend table and score breakdown |
| **Accessible mode** | Cooked line-oriented fallback for screen readers (`--accessible`) |
| **Graceful degradation** | Falls back to plain text in non-TTY / piped / CI environments |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` or `j` / `k` | Navigate list |
| `Enter` | Select / confirm |
| `/` | Search / filter |
| `m` | Mark model for comparison |
| `c` | Compare marked models |
| `d` | Show model details |
| `q` / `Esc` | Quit / back |
| `Ctrl+C` | Cancel operation (with compensation) |

### TUI Screenshots

**Recommend screen** — interactive model list with search and details:

<div align="center">
<pre style="background:#0d1117;color:#c9d1d9;padding:16px;border-radius:8px;overflow-x:auto;">
<span style="color:#58a6ff;">local-llmup / Recommend</span>                                        <span style="color:#8b949e;">arm64/darwin 34 GiB</span>
<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
  Rank  Model              Params  Verdict     Est. tok/s   Score
     1  qwen3:30b-a3b         30B  <span style="color:#3fb950;">✓ yes</span>       55.6–103.3    0.78
  <span style="color:#58a6ff;">►</span>  2  kimi-vl-a3b           16B  <span style="color:#3fb950;">✓ yes</span>       55.6–103.3    0.66
     3  qwen3:32b             32B  <span style="color:#d29922;">⚠️ slow</span>        5.2–9.7    0.61
     4  deepseek-r1:32b       32B  <span style="color:#d29922;">⚠️ slow</span>        5.2–9.7    0.59
     5  qwen2.5-coder:32b     32B  <span style="color:#d29922;">⚠️ slow</span>        5.2–9.7    0.57
     …
<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
  <span style="color:#8b949e;">↑↓ Navigate · Enter Select · / Search · m Mark · c Compare · d Details · q Quit</span>
</pre>
</div>

**Doctor dashboard** — hardware diagnostics and backend status:

<div align="center">
<pre style="background:#0d1117;color:#c9d1d9;padding:16px;border-radius:8px;overflow-x:auto;">
<span style="color:#58a6ff;">local-llmup / Doctor</span>                                                       <span style="color:#3fb950;">healthy</span>
<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
Diagnostics
<span style="color:#3fb950;">✓ OK</span>      hardware: arm64/darwin, 34.0 GiB usable memory, 765.1 GiB free disk
<span style="color:#3fb950;">✓ OK</span>      backend: ollama is installed
<span style="color:#3fb950;">✓ OK</span>      catalog: 58 model(s), all digests verified
<span style="color:#3fb950;">✓ OK</span>      state: no active server recorded

<span style="color:#58a6ff;">Backends</span>
ollama · <span style="color:#3fb950;">installed</span> · version 0.32.5 · <span style="color:#d29922;">default</span> · brew install ollama
llamacpp · <span style="color:#3fb950;">installed</span> · version 10090 · not default · brew install llama.cpp
mlx · <span style="color:#f85149;">not installed</span> · not default · python3 -m pip install "mlx-lm==0.31.3"
lmstudio · <span style="color:#3fb950;">installed</span> · CLI commit: 71bd99c · not default

<span style="color:#58a6ff;">Score: 80/100</span> · Bottleneck: <span style="color:#d29922;">RAM</span>
VRAM <span style="color:#3fb950;">1</span> · RAM <span style="color:#d29922;">0.5625</span> · Compute 0.65 · Storage <span style="color:#3fb950;">1</span>
<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
<span style="color:#8b949e;">q/Esc Quit · ? Help</span>
</pre>
</div>

**Lifecycle progress** — real-time pull/verify/serve with cancellation:

<div align="center">
<pre style="background:#0d1117;color:#c9d1d9;padding:16px;border-radius:8px;overflow-x:auto;">
<span style="color:#58a6ff;">local-llmup / Up</span>                                                      <span style="color:#8b949e;">llama3.1:8b</span>
<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
Stage: Pulling weights

  <span style="color:#3fb950;">✓</span> Preflight checks passed
  <span style="color:#58a6ff;">●</span> Pulling llama3.1:8b (Q4_K_M)...
    pulling 8eeb52dfb3bb: 67% <span style="color:#3fb950;">▕████████████</span><span style="color:#30363d;">░░░░░░▏</span> 3.2/4.7 GB  42 MB/s
  <span style="color:#8b949e;">○</span> Verifying digest
  <span style="color:#8b949e;">○</span> Starting server

<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
<span style="color:#8b949e;">Ctrl+C Cancel (partial state will be cleaned up)</span>
</pre>
</div>

**Chat screen** — streaming responses with session summary:

<div align="center">
<pre style="background:#0d1117;color:#c9d1d9;padding:16px;border-radius:8px;overflow-x:auto;">
<span style="color:#58a6ff;">local-llmup / Chat</span>                                    <span style="color:#8b949e;">llama3.1:8b @ 127.0.0.1:11434</span>
<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
  <span style="color:#d29922;">user:</span> What is the meaning of life?
  <span style="color:#3fb950;">assistant:</span> The question of life's meaning has occupied philosophers for
  millennia. Some find it in connection, others in creation...

  <span style="color:#d29922;">user:</span> <span style="color:#58a6ff;">█</span>

<span style="color:#30363d;">────────────────────────────────────────────────────────────────────────────────────</span>
<span style="color:#8b949e;">Enter Send · Ctrl+J Newline · Esc/Ctrl+C Exit</span>
</pre>
</div>

### Modes

The UI auto-selects the best mode for your terminal:

| Mode | When | Behavior |
|------|------|----------|
| **Visual** | TTY ≥60×16 | Full Ink-rendered interactive UI |
| **Accessible** | `--accessible` or `TERM_PROGRAM=screen-reader` | Line-oriented cooked input |
| **Plain** | Non-TTY, piped, `--json`, `--no-tui` | Traditional text output |

---

## Commands

| Command | Usage | Purpose |
|---------|-------|---------|
| `recommend` | `local-llmup [--task <t>] [--context <n>] [--json]` | Rank models that fit (default command) |
| `can-run` | `local-llmup can-run <model> [--json]` | `yes/slow/no` for one model |
| `doctor` | `local-llmup doctor [--json]` | Hardware + backend diagnostics |
| `up` | `local-llmup up <model> [--port <p>] [--backend <b>]` | Pull, verify, serve |
| `chat` | `local-llmup chat [-m <model>]` | Interactive chat with memory |
| `ls` | `local-llmup ls` | Show active server |
| `switch` | `local-llmup switch <model>` | Change active model |
| `down` | `local-llmup down [model]` | Stop server |
| `migrate` | `local-llmup migrate --from <a> --to <b> [--dry-run]` | Move memory between models |
| `catalog` | `local-llmup catalog [--all] [--refresh]` | Browse model catalog |

### Global Options

```
--task <task>         Boost models for: chat|code|vision|reasoning|tools|embedding
--context <tokens>    Size KV cache at N tokens and re-rank
--max-context         Report largest holdable context per model
--backend <name>      Scope to: ollama|llamacpp|mlx|lmstudio
--available-backends  Only show models an installed backend can serve
--json                Machine-readable JSON output
--no-tui              Force plain text mode
--accessible          Force accessible mode
-h, --help            Help
-v, --version         Version
```

### Machine-Readable Output

```json
{
  "hardware": { "arch": "arm64", "platform": "darwin", "usableBytes": 36507222016 },
  "ranked": [
    {
      "rank": 1,
      "id": "qwen3:30b-a3b",
      "params": "30B",
      "quant": "Q4_K_M",
      "verdict": "yes",
      "score": 0.78,
      "throughput": { "known": true, "lowTokPerSec": 55.6, "highTokPerSec": 103.3 },
      "backends": ["ollama", "llamacpp", "lmstudio"]
    }
  ],
  "wontFit": [{ "id": "llama3.1:70b", "reason": "ram-bound" }]
}
```

---

## Supported Backends

| Backend | Platform | Lifecycle | Notes |
|---------|----------|-----------|-------|
| **Ollama** | All | Full (pull/serve/stop) | Default. Managed daemon. |
| **llama.cpp** | All | Full (pull/serve/stop) | Self-managed GGUF with HF acquisition |
| **MLX** | macOS (Apple Silicon) | Full (pull/serve/stop) | `mlx-lm` Python package |
| **LM Studio** | All | Attach-only | User manages the server; llmup attaches |

**Auto-selection logic:**
- Apple Silicon → MLX preferred (when installed)
- Everywhere else → Ollama preferred (when installed)
- Override with `--backend <name>`

All backends bind to `127.0.0.1` only. Integrity verification is SHA-256 for
self-managed pulls; LM Studio uses delegated integrity with a named trust boundary.

---

## How Advice Works

```mermaid
flowchart TD
    A["Model + quant"] --> B{"Weights + KV cache<br/>fit in usable memory?"}
    B -- No --> C["❌ no<br/>ram/vram/disk/context-bound"]
    B -- Yes --> D{"Bandwidth-limited?"}
    D -- Yes --> E["⚠️ slow"]
    D -- No --> F["✓ yes"]
```

| Principle | Implementation |
|-----------|---------------|
| **Offline** | Zero network calls. Curated dataset in `data/` |
| **Deterministic** | Same hardware → same output, always |
| **Memory-bandwidth model** | tok/s from hardware bandwidth × model size |
| **KV-cache aware** | `--context N` includes fp16 KV (GQA-correct geometry) |
| **Honest** | Unknown → `unknown`, never fabricated |

**AI Hardware Score** is a blend of VRAM, RAM, compute, and storage sub-scores
(each 0–1). The lowest sub-score is surfaced as your bottleneck:

```mermaid
xychart-beta
    title "AI Hardware Score breakdown (total 80/100)"
    x-axis ["VRAM", "RAM", "Compute", "Storage"]
    y-axis "sub-score" 0 --> 1
    bar [1, 0.5625, 0.65, 1]
```

---

## Scripting & Exit Codes

| Command | Exit 0 | Exit 1 |
|---------|--------|--------|
| `can-run` | `yes` or `slow` | `no` |
| `doctor` | All checks pass | Any check fails |
| `recommend` | Success | Invalid input |
| `up` | Model served | Verification/pull failed |

```bash
# CI gate example
if local-llmup can-run llama3.1:8b; then
  local-llmup up llama3.1:8b
fi
```

---

## local-llmup vs. Ollama

| Feature | Ollama | local-llmup |
|---------|--------|-------------|
| Run inference | ✅ | ✅ (via backends) |
| Hardware-aware recommendations | ❌ | ✅ |
| Quantization selection | ❌ | ✅ |
| Multi-backend (4 runtimes) | ❌ | ✅ |
| Integrity-verified pulls (SHA-256) | ❌ | ✅ |
| Context-window sizing | ❌ | ✅ |
| Memory migration between models | ❌ | ✅ |
| Interactive TUI | ❌ | ✅ |
| AI Hardware Score | ❌ | ✅ |
| Accessible mode (screen readers) | ❌ | ✅ |

> **Homebrew for local LLMs** — hardware-aware model selection with a consistent
> workflow across runtimes.

---

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # 1459 tests (Vitest)
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format       # Prettier
npm run dev          # Dev mode (tsx src/cli.ts)
npm run bootstrap    # Regenerate data/models.json
```

### Architecture

```
src/
├── cli.ts, bin.ts       Entry points & CLI wiring
├── commands/            One file per subcommand
├── advisor/             Scoring, throughput, verdict engine
├── hardware/            Detection + memory math (KV-cache sizing)
├── catalog/             Model catalog, schema, enrichment
├── backend/             Ollama, llama.cpp, MLX, LM Studio adapters
├── ranking/             Fit + rank + weights
├── memory/              Conversation memory capture & migration
├── state/               Active-model / server state
└── tui/                 Terminal UI (Ink 5 + React 18)
    ├── screens/         Visual components (recommend, chat, lifecycle, doctor)
    ├── session.ts       Terminal resource ownership & restoration
    ├── capabilities.ts  Mode selection (visual/accessible/plain)
    ├── cancellation.ts  Signal handling + compensation
    ├── chat-limits.ts   Draft validation & session summary
    └── keys.ts          Keyboard binding definitions
```

### Testing Philosophy

- **TDD.** Failing test → minimal implementation → refactor.
- **All mocked.** No real network/Ollama/filesystem in Vitest tests.
- **87 test files, 1459 assertions.** Unit > integration > e2e.
- **Coverage gates.** 80% lines+branches on core modules.
- **Runtime smoke.** Real backend processes tested separately via production builds.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `up` fails with size mismatch | Re-run — likely an interrupted download |
| `ollama is not installed` | Install from [ollama.com](https://ollama.com); advice commands still work |
| Throughput shows `unknown` | Your hardware bandwidth isn't in the dataset |
| TUI not rendering | Check terminal size ≥60×16, or use `--no-tui` |
| Screen reader not working | Use `--accessible` flag |
| KV Cache shows `unknown` | Model's attention geometry isn't in the dataset |

---

## License

[MIT](LICENSE)
