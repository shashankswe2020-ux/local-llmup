# Skill: Demo Recording

Record terminal demos and screenshots of local-llmup using **vhs** (charm.sh
terminal recorder). Produces reproducible GIFs and PNGs from `.tape` files.

---

## When to Use

- Before a release — refresh demo GIF and screenshots to match current UI
- After TUI changes — re-record affected screenshots
- When adding new commands — create tape files for new screenshots

---

## Prerequisites

- `vhs` installed (`brew install vhs`)
- `local-llmup` installed globally (`npm install -g local-llmup`)
- Tape files live in `assets/*.tape`
- Output images go to `assets/` (GIF for demos, PNG for screenshots)

---

## Tape File Conventions

```tape
# Every tape must have an Output directive (required for Screenshot to work)
Output assets/<name>-out.gif

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height <appropriate-height>   # 700 for short, 1100+ for full TUI
Set Padding 20
```

### Key Rules

1. **Output directive is mandatory** — without it, `Screenshot` silently fails
2. **Never pipe commands** — piping disables the TUI (vhs provides a real PTY)
3. **Use `Sleep`** generously after commands to let the TUI fully render
4. **Screenshot path** — `Screenshot assets/screenshot-<name>.png`
5. **Quit TUI** — send `Type "q"` after screenshot to exit cleanly

---

## Standard Tapes

| Tape | Purpose | Height |
|------|---------|--------|
| `assets/demo.tape` | Full end-to-end GIF (install → recommend → doctor → can-run) | 700 |
| `assets/recommend.tape` | Screenshot of recommend TUI | 1100 |
| `assets/doctor.tape` | Screenshot of doctor TUI | 700 |
| `assets/can-run.tape` | Screenshot of can-run verdicts | 700 |

---

## Recording Workflow

1. **Verify installation** — ensure `local-llmup` is at the target version:
   ```bash
   local-llmup --version
   ```

2. **Record all tapes**:
   ```bash
   vhs assets/demo.tape
   vhs assets/recommend.tape
   vhs assets/doctor.tape
   vhs assets/can-run.tape
   ```

3. **Inspect output** — visually confirm screenshots are complete (not cut off)

4. **Commit assets**:
   ```bash
   git add assets/*.tape assets/*.gif assets/*.png
   git commit -m "docs: refresh demo and screenshots for v<version>"
   ```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Screenshot is blank/missing | Add `Output assets/<name>-out.gif` directive |
| TUI not rendering (plain text) | Remove any `\|` pipes from commands |
| Content cut off at bottom | Increase `Set Height` (try 1100+) |
| Content cut off at top | TUI is taller than terminal; increase height |
| Command not found | Ensure `local-llmup` is in PATH (global install) |
| Old version shown | `npm install -g local-llmup@latest` first |

---

## Cleanup

- The `-out.gif` files produced by tapes that only need a Screenshot can be
  gitignored or deleted — only the PNG screenshots matter for those tapes
- Add `assets/*-out.gif` to `.gitignore` if they're not used in README
