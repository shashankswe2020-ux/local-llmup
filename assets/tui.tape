# Screenshots: recommend TUI table, fuzzy search and side-by-side compare
# Record: PATH="<dir with rigspark>:$PATH" vhs assets/tui.tape
Output "/tmp/rigspark-tui.gif"

Require rigspark

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1400
Set Height 900
Set Padding 20

Hide
Type "export RIGSPARK_HOME=$(mktemp -d) RIGSPARK_NO_MOUSE=1 && clear"
Enter
Show

Type "rigspark recommend"
Enter
Sleep 5s
Screenshot assets/screenshot-recommend.png

Type "/qwen"
Sleep 500ms
Screenshot assets/screenshot-tui-search.png
Enter
Sleep 300ms
Ctrl+U
Sleep 300ms

Type@200ms " j j c"
Sleep 1s
Screenshot assets/screenshot-tui-compare.png

Type "q"
Sleep 500ms
