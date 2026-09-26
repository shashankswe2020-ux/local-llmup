const TUI_SOURCES: &[(&str, &str)] = &[
    ("tui_view.rs", include_str!("../src/tui_view.rs")),
    ("tui_lifecycle.rs", include_str!("../src/tui_lifecycle.rs")),
    ("tui_models.rs", include_str!("../src/tui_models.rs")),
    (
        "terminal_events.rs",
        include_str!("../src/terminal_events.rs"),
    ),
];

// Ratatui renders through upstream crossterm, which parses stdin itself when asked for the
// cursor position; only the bounded llmup-crossterm fork may read terminal input.
#[test]
fn terminal_input_is_only_read_through_the_bounded_crossterm_fork() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains(
        "crossterm = { package = \"llmup-crossterm\", version = \"0.29.0\", path = \"../../vendor/crossterm\""
    ));
    for (name, source) in TUI_SOURCES {
        for forbidden in [
            "ratatui::crossterm",
            "Viewport::Inline",
            "get_cursor_position",
            "cursor::position",
            "terminal.clear()",
        ] {
            assert!(!source.contains(forbidden), "{name} uses {forbidden}");
        }
    }
    assert!(
        TUI_SOURCES[0]
            .1
            .contains("Terminal::new(CrosstermBackend::new(")
    );
}
