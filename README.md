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
