# Screenshot: recommend TUI
# Record: PATH="<dir with llmup, rigspark, rigspark-gui>:$PATH" vhs assets/recommend.tape
Output assets/recommend-out.gif

Require rigspark

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 1100
Set Padding 20

Hide
Type "export RIGSPARK_HOME=$(mktemp -d) && clear"
Enter
Show

Type "rigspark recommend"
Enter
Sleep 4s
Screenshot assets/screenshot-recommend.png
Type "q"
