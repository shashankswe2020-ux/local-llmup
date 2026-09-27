# Screenshot: can-run output
# Record: PATH="<dir with llmup, local-llmup, llmup-gui>:$PATH" vhs assets/can-run.tape
Output assets/can-run-out.gif

Require local-llmup

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 300
Set Padding 20

Hide
Type "export LOCAL_LLMUP_HOME=$(mktemp -d) && clear"
Enter
Show

# --no-tui keeps both verdicts on one screen; without it can-run opens the TUI.
Type "local-llmup can-run qwen3:8b --no-tui"
Enter
Sleep 1.5s
Type "local-llmup can-run deepseek-r1:671b --no-tui"
Enter
Sleep 1.5s
Screenshot assets/screenshot-can-run.png
Sleep 500ms
