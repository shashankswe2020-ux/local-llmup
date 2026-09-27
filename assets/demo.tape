# End-to-end demo of the native CLI: version → recommend TUI (details, compare) → doctor → can-run → plan
# Record: PATH="<dir with llmup, local-llmup, llmup-gui>:$PATH" vhs assets/demo.tape
Output assets/demo.gif

Require local-llmup

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 700
Set Padding 20
Set TypingSpeed 40ms
Set PlaybackSpeed 1.5

# Isolated state so the recording never shows or changes real local-llmup state.
Hide
Type "export LOCAL_LLMUP_HOME=$(mktemp -d) && clear"
Enter
Show

Type "local-llmup --version"
Enter
Sleep 1.5s

# Recommend is the default command and opens the TUI in a capable terminal.
Type "local-llmup"
Enter
Sleep 3s
Down
Sleep 500ms
Down
Sleep 500ms
Enter
Sleep 2.5s
Escape
Sleep 500ms

# Mark two models with Space, then compare them.
Space
Sleep 300ms
Down
Sleep 300ms
Space
Sleep 300ms
Type "c"
Sleep 2.5s
Type "c"
Sleep 500ms
Type "q"
Sleep 1s

Type "local-llmup doctor"
Enter
Sleep 3s
Type "q"
Sleep 1s

Type "local-llmup can-run qwen3:8b --no-tui"
Enter
Sleep 2s
Type "local-llmup can-run deepseek-r1:671b --no-tui"
Enter
Sleep 2s

Type "clear && local-llmup plan qwen3:30b-a3b"
Enter
Sleep 3s
