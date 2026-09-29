# Screenshot: can-run output
# Record: PATH="<dir with llmup, rigspark, rigspark-gui>:$PATH" vhs assets/can-run.tape
Output assets/can-run-out.gif

Require rigspark

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 300
Set Padding 20

Hide
Type "export RIGSPARK_HOME=$(mktemp -d) && clear"
Enter
Show

# --no-tui keeps both verdicts on one screen; without it can-run opens the TUI.
Type "rigspark can-run qwen3:8b --no-tui"
Enter
Sleep 1.5s
Type "rigspark can-run deepseek-r1:671b --no-tui"
Enter
Sleep 1.5s
Screenshot assets/screenshot-can-run.png
Sleep 500ms
