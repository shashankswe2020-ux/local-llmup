# Screenshot: doctor TUI
# Record: PATH="<dir with llmup, rigspark, rigspark-gui>:$PATH" vhs assets/doctor.tape
Output assets/doctor-out.gif

Require rigspark

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 700
Set Padding 20

Hide
Type "export RIGSPARK_HOME=$(mktemp -d) && clear"
Enter
Show

Type "rigspark doctor"
Enter
Sleep 2s
Screenshot assets/screenshot-doctor.png
Sleep 1s
Type "q"
Sleep 500ms
