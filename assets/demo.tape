# Full end-to-end demo: install 0.8.1 → recommend (TUI) → doctor (TUI) → can-run
Output assets/demo.gif

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 700
Set Padding 20
Set TypingSpeed 40ms
Set PlaybackSpeed 1.5

# Install from npm
Type "npm install -g local-llmup@0.8.1"
Enter
Sleep 4s

# Verify version
Type "local-llmup --version"
Enter
Sleep 1.5s

# Show recommend TUI
Type "local-llmup recommend"
Enter
Sleep 3s

# Navigate down a few rows
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms

# Open detail panel
Enter
Sleep 2s

# Close and quit
Escape
Sleep 500ms
Type "q"
Sleep 1s

# Show doctor TUI
Type "local-llmup doctor"
Enter
Sleep 3s

# Quit doctor
Type "q"
Sleep 1s

# Show can-run (always text output)
Type "local-llmup can-run qwen3:8b"
Enter
Sleep 2s

Type "local-llmup can-run deepseek-r1:671b"
Enter
Sleep 2s
