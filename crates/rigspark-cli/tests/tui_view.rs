use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use rigspark_cli::tui_view::{ReportView, handle_key, render};

#[tokio::test]
async fn invalid_picker_choices_fail_before_terminal_or_cooked_output() {
    for choices in [
        vec![],
        (0..1001).map(|index| format!("model:{index}")).collect(),
        vec!["x".repeat(8193)],
        vec![String::new()],
        vec!["duplicate".into(), "duplicate".into()],
        vec!["unsafe\x1b[2J".into()],
    ] {
        let error = rigspark_cli::tui_view::pick("Choose", &choices, false)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        let (_sender, mut input) = tokio::sync::mpsc::channel(1);
        let mut output = Vec::new();
        assert!(
            rigspark_cli::accessible::pick_model(
                "Choose",
                &choices,
                &mut input,
                &mut output,
                &tokio_util::sync::CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert!(output.is_empty());
    }
}

#[test]
fn navigation_search_and_input_bounds_are_deterministic() {
    let mut view = ReportView::new("Catalog", "alpha\nbeta\ngamma\n", false).unwrap();
    assert!(!handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
    ));
    assert_eq!(view.selected(), 1);
    handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE),
    );
    handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE),
    );
    assert_eq!(view.selected(), 2);
    handle_key(&mut view, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE)
    ));
    assert!(ReportView::new("Title", &"x".repeat(1024 * 1024 + 1), false).is_err());
}

#[test]
fn renders_readable_content_in_small_and_large_terminals_without_control_injection() {
    for (width, height) in [(20, 5), (60, 16), (120, 40)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut view = ReportView::new(
            "Catalog",
            "model-alpha yes\nmodel-beta unknown\n\x1b[2Junsafe",
            false,
        )
        .unwrap();
        terminal.draw(|frame| render(frame, &mut view)).unwrap();
        let text = terminal.backend().to_string();
        assert!(text.contains("Catalog"));
        assert!(text.contains("model-alpha"));
        assert!(!text.contains('\x1b'));
        assert_eq!(terminal.backend().buffer().area.width, width);
        assert_eq!(terminal.backend().buffer().area.height, height);
    }
}
