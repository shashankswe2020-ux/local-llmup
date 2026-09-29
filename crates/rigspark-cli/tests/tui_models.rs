use rigspark_cli::{accessible_catalog, accessible_installed, accessible_recommend, tui_models};

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use tui_models::{ModelOutcome, ModelRow, ModelView, handle_event, handle_key, render};

fn key(view: &mut ModelView, code: KeyCode) -> Option<ModelOutcome> {
    handle_key(view, KeyEvent::new(code, KeyModifiers::NONE))
}

fn view() -> ModelView {
    ModelView::new(
        "Catalog",
        vec!["Machine: offline fixture".into()],
        vec![
            ModelRow::new("alpha", "alpha code", "alpha; KV unknown; license MIT").unwrap(),
            ModelRow::new("beta", "beta chat", "beta; throughput unknown").unwrap(),
        ],
        false,
    )
    .unwrap()
}

#[test]
fn filters_and_resets_without_losing_selection_identity() {
    let mut view = view();
    key(&mut view, KeyCode::Down);
    assert_eq!(view.selected().unwrap().label(), "beta");
    key(&mut view, KeyCode::Char('/'));
    for character in "chat".chars() {
        key(&mut view, KeyCode::Char(character));
    }
    assert_eq!(view.visible_count(), 1);
    assert_eq!(view.selected().unwrap().label(), "beta");
    key(&mut view, KeyCode::Enter);
    handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL),
    );
    assert_eq!(view.visible_count(), 2);
    assert_eq!(view.selected().unwrap().label(), "beta");
}

#[test]
fn details_back_and_quit_are_distinct_and_catalog_cannot_print() {
    let mut view = view();
    assert_eq!(key(&mut view, KeyCode::Char('p')), None);
    assert_eq!(key(&mut view, KeyCode::Enter), None);
    assert!(view.detail_focused());
    assert_eq!(key(&mut view, KeyCode::Esc), None);
    assert!(!view.detail_focused());
    assert_eq!(
        key(&mut view, KeyCode::Esc),
        Some(ModelOutcome::Exit { code: 0 })
    );
}

#[test]
fn renders_evidence_and_handles_tiny_resizes_in_monochrome() {
    let mut view = view();
    let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
    terminal.draw(|frame| render(frame, &mut view)).unwrap();
    let output: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert!(output.contains("KV unknown"));
    assert!(output.contains("license MIT"));
    for (width, height) in [(1, 1), (12, 4), (39, 10), (80, 24), (120, 30)] {
        terminal.backend_mut().resize(width, height);
        terminal.autoresize().unwrap();
        terminal.draw(|frame| render(frame, &mut view)).unwrap();
        for cell in &terminal.backend().buffer().content {
            assert_eq!(cell.fg, ratatui::style::Color::Reset);
            assert_eq!(cell.bg, ratatui::style::Color::Reset);
        }
    }
}

fn draw(view: &mut ModelView, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| render(frame, view)).unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(usize::from(width))
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn help_is_modal_and_escape_restores_the_underlying_screen() {
    let mut view = view();
    key(&mut view, KeyCode::Enter);
    key(&mut view, KeyCode::Char('?'));
    let output = draw(&mut view, 100, 24);
    assert!(output.contains("Keyboard help"));
    assert!(output.contains("Space"));
    assert!(output.contains("max 4"));
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Char('/'));
    assert!(draw(&mut view, 100, 24).contains("Keyboard help"));
    assert_eq!(key(&mut view, KeyCode::Esc), None);
    assert!(view.detail_focused());
    key(&mut view, KeyCode::Esc);
    key(&mut view, KeyCode::Char('?'));
    key(&mut view, KeyCode::Char('?'));
    assert!(!draw(&mut view, 100, 24).contains("Keyboard help"));
    key(&mut view, KeyCode::Char('?'));
    assert_eq!(
        key(&mut view, KeyCode::Char('q')),
        Some(ModelOutcome::Exit { code: 0 })
    );
}

#[test]
fn comparison_uses_marked_evidence_even_when_filter_hides_models() {
    let mut view = view();
    key(&mut view, KeyCode::Char('c'));
    assert!(draw(&mut view, 100, 24).contains("Mark at least 2 models"));
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Down);
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("chat".into()));
    key(&mut view, KeyCode::Enter);
    key(&mut view, KeyCode::Char('c'));
    let output = draw(&mut view, 100, 24);
    assert!(output.contains("Compare 2 models"));
    assert!(output.contains("alpha"));
    assert!(output.contains("KV unknown"));
    assert!(output.contains("license MIT"));
    assert!(output.contains("beta"));
    assert!(output.contains("throughput unknown"));
    key(&mut view, KeyCode::Char('?'));
    assert_eq!(key(&mut view, KeyCode::Esc), None);
    assert!(draw(&mut view, 100, 24).contains("Compare 2 models"));
    assert_eq!(key(&mut view, KeyCode::Esc), None);
    assert_eq!(view.selected().unwrap().label(), "beta");
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Char('c'));
    assert!(draw(&mut view, 100, 24).contains("Mark at least 2 models"));
    assert_eq!(
        key(&mut view, KeyCode::Esc),
        Some(ModelOutcome::Exit { code: 0 })
    );
}

#[test]
fn marks_are_bounded_and_use_row_identity_not_duplicate_labels() {
    let rows = (0..5)
        .map(|index| {
            ModelRow::new(
                "duplicate",
                &format!("id-{index}"),
                &format!("evidence-{index}"),
            )
            .unwrap()
        })
        .collect();
    let mut view = ModelView::new("Models", vec![], rows, false).unwrap();
    for _ in 0..5 {
        key(&mut view, KeyCode::Char(' '));
        key(&mut view, KeyCode::Down);
    }
    assert!(draw(&mut view, 100, 24).contains("Mark limit 4"));
    key(&mut view, KeyCode::Char('c'));
    let output = draw(&mut view, 100, 24);
    assert!(output.contains("Compare 4 models"));
    for index in 0..4 {
        assert!(output.contains(&format!("evidence-{index}")));
    }
    assert!(!output.contains("evidence-4"));
    key(&mut view, KeyCode::Char('c'));
    assert!(!draw(&mut view, 100, 24).contains("Compare 4 models"));
}

#[test]
fn empty_selection_and_repeated_toggle_keys_do_not_change_marks() {
    let mut view = view();
    key(&mut view, KeyCode::Char(' '));
    assert!(draw(&mut view, 100, 24).contains("* alpha"));
    for code in [KeyCode::Char(' '), KeyCode::Char('?'), KeyCode::Char('c')] {
        let mut repeat = KeyEvent::new(code, KeyModifiers::NONE);
        repeat.kind = KeyEventKind::Repeat;
        assert_eq!(handle_key(&mut view, repeat), None);
    }
    assert!(draw(&mut view, 100, 24).contains("Marked 1/4"));
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("? c no match".into()));
    assert_eq!(key(&mut view, KeyCode::Esc), None);
    key(&mut view, KeyCode::Char(' '));
    let output = draw(&mut view, 100, 24);
    assert!(output.contains("No model selected to mark"));
    assert!(output.contains("Marked 1/4"));
    key(&mut view, KeyCode::Char('c'));
    assert!(draw(&mut view, 100, 24).contains("Mark at least 2 models"));
    handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL),
    );
    key(&mut view, KeyCode::Char(' '));
    assert!(draw(&mut view, 100, 24).contains("Marked 0/4"));

    let mut empty = ModelView::new("Empty", vec![], vec![], false).unwrap();
    key(&mut empty, KeyCode::Char(' '));
    assert!(draw(&mut empty, 100, 24).contains("No model selected to mark"));
    key(&mut empty, KeyCode::Char('?'));
    assert!(draw(&mut empty, 100, 24).contains("Keyboard help"));
}

#[test]
fn comparison_and_help_scroll_restore_and_resize_in_monochrome() {
    let evidence = format!("{}; FINAL EVIDENCE", "wide \u{754c} evidence ".repeat(40));
    let mut view = ModelView::new(
        "Models",
        vec![],
        vec![
            ModelRow::new("alpha", "alpha", "first evidence").unwrap(),
            ModelRow::new("beta", "beta", &evidence).unwrap(),
        ],
        false,
    )
    .unwrap();
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Down);
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Char('c'));
    let first = draw(&mut view, 22, 8);
    assert!(!first.contains("FINAL EVIDENCE"));
    key(&mut view, KeyCode::PageDown);
    assert_ne!(draw(&mut view, 22, 8), first);
    key(&mut view, KeyCode::End);
    let last = draw(&mut view, 22, 8);
    assert!(last.contains("FINAL EVIDENCE"));
    key(&mut view, KeyCode::Char('?'));
    let help_first = draw(&mut view, 22, 8);
    key(&mut view, KeyCode::End);
    assert_ne!(draw(&mut view, 22, 8), help_first);
    key(&mut view, KeyCode::Home);
    assert_eq!(draw(&mut view, 22, 8), help_first);
    key(&mut view, KeyCode::Esc);
    assert_eq!(draw(&mut view, 22, 8), last);
    key(&mut view, KeyCode::Home);
    assert_eq!(draw(&mut view, 22, 8), first);
    let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
    for help in [false, true] {
        if help {
            key(&mut view, KeyCode::Char('?'));
        }
        for (width, height) in [(1, 1), (12, 4), (39, 10), (80, 24), (120, 30)] {
            handle_event(&mut view, Event::Resize(width, height));
            terminal.backend_mut().resize(width, height);
            terminal.autoresize().unwrap();
            terminal.draw(|frame| render(frame, &mut view)).unwrap();
            for cell in &terminal.backend().buffer().content {
                assert_eq!(cell.fg, ratatui::style::Color::Reset);
                assert_eq!(cell.bg, ratatui::style::Color::Reset);
            }
        }
    }
    key(&mut view, KeyCode::Esc);
    assert_eq!(key(&mut view, KeyCode::Char('p')), None);
    assert_eq!(
        key(&mut view, KeyCode::Char('q')),
        Some(ModelOutcome::Exit { code: 0 })
    );
}

#[test]
fn navigation_pages_home_end_and_empty_results_are_bounded() {
    let rows = (0..100)
        .map(|index| {
            ModelRow::new(
                &format!("model-{index}"),
                &format!("model-{index}"),
                "unknown",
            )
            .unwrap()
        })
        .collect();
    let mut view = ModelView::new("Models", vec![], rows, false).unwrap();
    draw(&mut view, 100, 24);
    key(&mut view, KeyCode::PageDown);
    assert_ne!(view.selected().unwrap().label(), "model-0");
    assert_ne!(view.selected().unwrap().label(), "model-99");
    key(&mut view, KeyCode::PageUp);
    assert_eq!(view.selected().unwrap().label(), "model-0");
    key(&mut view, KeyCode::End);
    key(&mut view, KeyCode::Char('j'));
    assert_eq!(view.selected().unwrap().label(), "model-99");
    key(&mut view, KeyCode::Home);
    key(&mut view, KeyCode::Char('k'));
    assert_eq!(view.selected().unwrap().label(), "model-0");
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("no match".into()));
    assert_eq!(view.visible_count(), 0);
    assert!(view.selected().is_none());
    key(&mut view, KeyCode::Esc);
    for code in [
        KeyCode::Down,
        KeyCode::PageDown,
        KeyCode::End,
        KeyCode::Enter,
    ] {
        assert_eq!(key(&mut view, code), None);
    }
    assert!(!view.detail_focused());
    assert!(draw(&mut view, 30, 10).contains("No results"));
}

#[test]
fn search_edits_graphemes_and_does_not_dispatch_action_keys_or_paste() {
    let mut view = view();
    let mut release = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
    release.kind = KeyEventKind::Release;
    assert_eq!(handle_key(&mut view, release), None);
    assert_eq!(handle_event(&mut view, Event::Paste("q\np".into())), None);
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("e\u{301}".into()));
    assert_eq!(view.visible_count(), 0);
    key(&mut view, KeyCode::Backspace);
    assert_eq!(view.visible_count(), 2);
    assert_eq!(key(&mut view, KeyCode::Char('q')), None);
    assert_eq!(key(&mut view, KeyCode::Char('p')), None);
    assert_eq!(
        handle_key(
            &mut view,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ),
        Some(ModelOutcome::Exit { code: 130 })
    );
}

#[test]
fn unicode_paste_is_bounded_and_sanitized_without_splitting_utf8() {
    let mut view = view();
    key(&mut view, KeyCode::Char('/'));
    handle_event(
        &mut view,
        Event::Paste(format!("\u{1b}[31m{}\nq", "\u{754c}".repeat(500))),
    );
    let output = draw(&mut view, 400, 5);
    assert!(!output.contains('\u{1b}'));
    assert!(output.matches('\u{754c}').count() <= 256 / 3);
    assert_eq!(handle_event(&mut view, Event::Resize(1, 1)), None);
}

#[test]
fn scrolls_long_details_and_overview_then_returns_to_same_model() {
    let evidence = format!("{}; FINAL EVIDENCE", "wide \u{754c} evidence ".repeat(40));
    let mut view = ModelView::new(
        "Models",
        vec!["Machine".into(), "Won't fit: actual reason".into()],
        vec![ModelRow::new("alpha", "alpha", &evidence).unwrap()],
        false,
    )
    .unwrap();
    key(&mut view, KeyCode::Right);
    assert!(view.detail_focused());
    let first = draw(&mut view, 22, 8);
    assert!(!first.contains("FINAL EVIDENCE"));
    key(&mut view, KeyCode::End);
    let last = draw(&mut view, 22, 8);
    assert!(last.contains("FINAL EVIDENCE"));
    key(&mut view, KeyCode::Home);
    assert_eq!(draw(&mut view, 22, 8), first);
    key(&mut view, KeyCode::Left);
    assert_eq!(view.selected().unwrap().label(), "alpha");
    key(&mut view, KeyCode::Char('i'));
    assert!(draw(&mut view, 60, 12).contains("Won't fit: actual reason"));
    key(&mut view, KeyCode::Esc);
    assert_eq!(view.selected().unwrap().label(), "alpha");
    key(&mut view, KeyCode::Tab);
    assert!(view.detail_focused());
    key(&mut view, KeyCode::BackTab);
    assert!(!view.detail_focused());
}

#[test]
fn rejects_oversized_documents_rows_and_text() {
    assert!(ModelRow::new(&"a".repeat(1025), "", "").is_err());
    assert!(ModelRow::new("model", "", &"a".repeat(65537)).is_err());
    assert!(ModelView::new(&"a".repeat(257), vec![], vec![], false).is_err());
    let rows = (0..1001)
        .map(|_| ModelRow::new("model", "", "").unwrap())
        .collect();
    assert!(ModelView::new("Models", vec![], rows, false).is_err());
    let rows = (0..100)
        .map(|_| ModelRow::new("model", "", &"a".repeat(65536)).unwrap())
        .collect();
    assert!(ModelView::new("Models", vec![], rows, false).is_err());
}

#[test]
fn catalog_adapter_preserves_native_evidence_order_and_accessible_output() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("accessible-catalog-oracle.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let presentation = accessible_catalog::build_catalog(
            &serde_json::from_value(case["catalog"].clone()).unwrap(),
            &serde_json::from_value(case["hardware"].clone()).unwrap(),
            &serde_json::from_value(case["options"].clone()).unwrap(),
        )
        .unwrap();
        let mut view = ModelView::from_catalog(&presentation, false).unwrap();
        assert_eq!(view.visible_count(), presentation.visual_rows().len());
        for (label, _, _, _) in presentation.visual_rows() {
            assert_eq!(view.selected().unwrap().label(), label);
            key(&mut view, KeyCode::Down);
        }
        assert_eq!(key(&mut view, KeyCode::Char('p')), None);
        assert_eq!(
            accessible_catalog::catalog_screen(&presentation),
            case["expected"].as_str().unwrap()
        );
        if case["name"] == "complete" {
            key(&mut view, KeyCode::Home);
            key(&mut view, KeyCode::Enter);
            let output = draw(&mut view, 200, 100);
            assert!(output.contains("SHA-256"));
            assert!(output.contains("sources"));
            assert!(output.contains("license"));
        }
    }
}

#[test]
fn recommendation_adapter_only_returns_the_existing_safe_top_pick() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("accessible-recommend-oracle.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let presentation = accessible_recommend::build_recommendation(
            &serde_json::from_value(case["catalog"].clone()).unwrap(),
            &serde_json::from_value(case["hardware"].clone()).unwrap(),
            &rigspark_core::catalog::PerfDataset::parse(&case["perf"].to_string()).unwrap(),
            &serde_json::from_value(case["options"].clone()).unwrap(),
        )
        .unwrap();
        let mut view = ModelView::from_recommendation(&presentation, true).unwrap();
        assert_eq!(view.visible_count(), presentation.visual_rows().len());
        assert_eq!(presentation.format(), case["screen"].as_str().unwrap());
        key(&mut view, KeyCode::End);
        assert_eq!(
            key(&mut view, KeyCode::Char('p')),
            presentation
                .print_command()
                .map(|command| ModelOutcome::PrintCommand {
                    command: command.into()
                })
        );
        if view.visible_count() >= 2 {
            key(&mut view, KeyCode::Home);
            key(&mut view, KeyCode::Char(' '));
            key(&mut view, KeyCode::Down);
            key(&mut view, KeyCode::Char(' '));
            key(&mut view, KeyCode::Char('c'));
            let output = draw(&mut view, 240, 100);
            assert!(output.contains("Compare 2 models"));
            for (label, _, _, evidence) in presentation.visual_rows().take(2) {
                assert!(output.contains(label));
                let scores = evidence
                    .split("; ")
                    .find(|line| line.starts_with("scores quality "))
                    .unwrap();
                assert!(output.contains(scores));
            }
            key(&mut view, KeyCode::Char('?'));
            assert!(
                draw(&mut view, 100, 24)
                    .contains("p: finish and print existing top-pick command; never execute")
            );
            key(&mut view, KeyCode::Esc);
            assert_eq!(
                key(&mut view, KeyCode::Char('p')),
                presentation
                    .print_command()
                    .map(|command| ModelOutcome::PrintCommand {
                        command: command.into()
                    })
            );
            assert_eq!(presentation.format(), case["screen"].as_str().unwrap());
        }
        key(&mut view, KeyCode::Char('/'));
        assert_eq!(key(&mut view, KeyCode::Char('p')), None);
    }
    let _event_loop = tui_models::show_models;
}

#[test]
fn installed_adapter_searches_compares_and_preserves_unknown_evidence() {
    let report = serde_json::json!({"source":"local-runtime-metadata", "models":[
        {"id":"local:alpha", "fit":"yes", "quant":"Q4_K_M", "capabilities":["completion"]},
        {"id":"custom:beta", "fit":"unknown"}
    ]});
    let installed = accessible_installed::build_installed(
        &report,
        accessible_installed::InstalledCommand::Recommend,
    )
    .unwrap();
    let before = installed.format();
    let mut view = ModelView::from_installed(&installed, false).unwrap();
    assert_eq!(view.visible_count(), 2);
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Down);
    key(&mut view, KeyCode::Char(' '));
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("BETA".into()));
    key(&mut view, KeyCode::Enter);
    assert_eq!(view.visible_count(), 1);
    assert_eq!(view.selected().unwrap().label(), "custom:beta");
    key(&mut view, KeyCode::Char('c'));
    let output = draw(&mut view, 150, 60);
    for expected in [
        "Compare 2 models",
        "local:alpha",
        "custom:beta",
        "Fit: unknown",
        "Quantization: Q4_K_M",
        "Capabilities: completion",
        "Throughput: unknown",
        "Required memory: unknown",
        "Digest (reported, not verified): unknown",
    ] {
        assert!(output.contains(expected), "missing {expected}: {output}");
    }
    assert!(!output.contains("tok/s"));
    assert_eq!(key(&mut view, KeyCode::Char('p')), None);
    key(&mut view, KeyCode::Char('?'));
    assert!(draw(&mut view, 100, 24).contains("c: compare"));
    key(&mut view, KeyCode::Esc);
    assert!(draw(&mut view, 150, 60).contains("Compare 2 models"));
    assert_eq!(installed.format(), before);
}

#[test]
fn installed_single_and_empty_views_have_appropriate_initial_screens_and_controls() {
    use accessible_installed::InstalledCommand;
    for command in [InstalledCommand::CanRun, InstalledCommand::Recommend] {
        for models in [
            serde_json::json!([]),
            serde_json::json!([{"id":"custom:only"}]),
        ] {
            let installed = accessible_installed::build_installed(
                &serde_json::json!({"models":models}),
                command,
            )
            .unwrap();
            let mut view = ModelView::from_installed(&installed, false).unwrap();
            let output = draw(&mut view, 100, 30);
            if models.as_array().unwrap().is_empty() {
                assert!(output.contains("No results"));
                assert!(output.contains("No installed models match."));
                assert!(!output.contains("No model selected"));
            } else if command == InstalledCommand::CanRun {
                assert!(view.detail_focused());
                assert!(output.contains("Fit: unknown"));
            }
            assert!(!output.contains("c compare"));
            key(&mut view, KeyCode::Char(' '));
            key(&mut view, KeyCode::Char('c'));
            assert!(!draw(&mut view, 100, 30).contains("Mark at least"));
            key(&mut view, KeyCode::Char('?'));
            let help = draw(&mut view, 100, 30);
            assert!(help.contains("Keyboard help"));
            assert!(!help.contains("c: compare"));
            assert!(!help.contains("Space: mark"));
            assert_eq!(key(&mut view, KeyCode::Char('p')), None);
            assert_eq!(
                key(&mut view, KeyCode::Char('q')),
                Some(ModelOutcome::Exit { code: 0 })
            );
        }
    }
}

#[test]
fn can_run_adapter_preserves_all_frozen_verdicts_and_evidence_without_actions() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("can-run-accessible-oracle.json")).unwrap();
    for case in cases {
        let evidence = &case["report"];
        let before = evidence.clone();
        let screen = rigspark_cli::accessible_read_only::can_run_screen(evidence).unwrap();
        let mut view = ModelView::from_can_run(evidence, false).unwrap();
        assert_eq!(view.visible_count(), 1);
        assert!(view.detail_focused());
        let output = draw(&mut view, 240, 80);
        for line in screen.lines().skip(1) {
            for part in line.split("; ") {
                assert!(output.contains(part), "missing {part}: {output}");
            }
        }
        if !evidence["throughput"]["known"].as_bool().unwrap() {
            assert!(!output.contains("tok/s"));
        }
        assert_eq!(key(&mut view, KeyCode::Char('p')), None);
        key(&mut view, KeyCode::Char(' '));
        key(&mut view, KeyCode::Char('c'));
        assert!(!draw(&mut view, 100, 30).contains("Mark at least"));
        key(&mut view, KeyCode::Char('?'));
        let help = draw(&mut view, 100, 30);
        assert!(!help.contains("c: compare"));
        assert!(!help.contains("p: finish"));
        key(&mut view, KeyCode::Esc);
        assert!(view.detail_focused());
        key(&mut view, KeyCode::Char('/'));
        handle_event(
            &mut view,
            Event::Paste(evidence["modelId"].as_str().unwrap().to_uppercase()),
        );
        assert_eq!(view.visible_count(), 1);
        key(&mut view, KeyCode::Enter);
        assert_eq!(
            key(&mut view, KeyCode::Char('q')),
            Some(ModelOutcome::Exit { code: 0 })
        );
        assert_eq!(*evidence, before);
    }
}

fn can_run_evidence() -> serde_json::Value {
    serde_json::json!({
        "modelId":"custom:local", "runnable":"slow", "quant":"Q4_K_M",
        "reason":null, "requiredBytes":1024, "usableBytes":4096,
        "throughput":{"known":false,"lowTokPerSec":0,"highTokPerSec":0},
        "throughputEvidence":{"source":"offline-estimate","unknownReason":"no-sourced-performance-profile"},
        "backends":["ollama"], "throughputBackend":"ollama",
        "context":8192, "contextFitKnown":false
    })
}

#[test]
fn can_run_adapter_keeps_context_unknown_distinct_from_nofit() {
    let mut evidence = can_run_evidence();
    let mut view = ModelView::from_can_run(&evidence, false).unwrap();
    let output = draw(&mut view, 140, 40);
    assert!(output.contains("Requested context: 8192 tokens"));
    assert!(output.contains("Requested context fit unknown: attention geometry unavailable"));
    assert!(output.contains("no-sourced-performance-profile"));
    assert!(output.contains("slow"));
    assert!(!output.contains("does not fit"));
    for reason in ["context-bound", "ram-bound", "vram-bound", "disk-bound"] {
        evidence["runnable"] = serde_json::json!("no");
        evidence["reason"] = serde_json::json!(reason);
        evidence["quant"] = serde_json::Value::Null;
        evidence["requiredBytes"] = serde_json::Value::Null;
        evidence["contextFitKnown"] = serde_json::json!(true);
        evidence["throughputEvidence"]["unknownReason"] =
            serde_json::json!("not-evaluated-model-does-not-fit");
        let mut view = ModelView::from_can_run(&evidence, false).unwrap();
        let output = draw(&mut view, 140, 40);
        assert!(output.contains(&format!("does not fit: {reason}")));
        assert!(output.contains("not-evaluated-model-does-not-fit"));
        assert!(!output.contains("rigspark up"));
        assert!(!output.contains("tok/s"));
        assert_eq!(key(&mut view, KeyCode::Char('p')), None);
    }
}

#[test]
fn can_run_adapter_reuses_schema_validation_and_bounds_untrusted_input() {
    for (field, value) in [
        ("runnable", serde_json::json!("maybe")),
        ("requiredBytes", serde_json::Value::Null),
        ("usableBytes", serde_json::json!(-1)),
        ("contextFitKnown", serde_json::Value::Null),
        (
            "throughput",
            serde_json::json!({"known":true,"lowTokPerSec":50,"highTokPerSec":1}),
        ),
        (
            "throughputEvidence",
            serde_json::json!({"source":"invented","unknownReason":null}),
        ),
        ("backends", serde_json::json!(vec!["ollama"; 1001])),
        ("extra", serde_json::json!(true)),
    ] {
        let mut evidence = can_run_evidence();
        evidence[field] = value;
        assert!(rigspark_cli::accessible_read_only::can_run_screen(&evidence).is_err());
        assert!(
            ModelView::from_can_run(&evidence, false).is_err(),
            "{field}"
        );
    }
    assert!(ModelView::from_can_run(&serde_json::json!({}), false).is_err());
    let mut evidence = can_run_evidence();
    evidence["modelId"] = serde_json::json!("x".repeat(1025));
    assert!(ModelView::from_can_run(&evidence, false).is_err());
    evidence["modelId"] = serde_json::json!("unsafe\n\u{1b}[2J\u{202e}");
    evidence["quant"] = serde_json::json!("q\r\u{7}");
    evidence["backends"] = serde_json::json!(["ollama\t\u{1b}[31m"]);
    let mut view = ModelView::from_can_run(&evidence, false).unwrap();
    let output = draw(&mut view, 120, 40);
    assert!(!output.contains(['\u{1b}', '\u{7}', '\u{202e}', '\r', '\t']));
    assert!(!output.contains("rigspark up"));
    evidence["quant"] = serde_json::json!("x".repeat(1024 * 1024 + 1));
    assert!(ModelView::from_can_run(&evidence, false).is_err());
}

#[test]
fn installed_visual_search_includes_late_rows_and_sanitizes_details() {
    let mut models: Vec<_> = (0..25)
        .map(|index| serde_json::json!({"id":format!("model:{index}"), "fit":"unknown"}))
        .collect();
    models[24]["quant"] = serde_json::json!("Q8_HOSTILE\u{1b}[2J\u{202e}");
    models[24]["capabilities"] = serde_json::json!(["completion"]);
    models[24]["evidence"] = serde_json::json!("local\r\n\u{7}");
    let installed = accessible_installed::build_installed(
        &serde_json::json!({"source":"source\u{1b}", "models":models}),
        accessible_installed::InstalledCommand::Recommend,
    )
    .unwrap();
    let mut view = ModelView::from_installed(&installed, false).unwrap();
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("q8_hostile".into()));
    assert_eq!(view.visible_count(), 1);
    assert_eq!(view.selected().unwrap().label(), "model:24");
    key(&mut view, KeyCode::Enter);
    key(&mut view, KeyCode::Right);
    let output = draw(&mut view, 120, 40);
    assert!(output.contains("Capabilities: completion"));
    assert!(output.contains("Throughput: unknown"));
    assert!(output.contains("\\u{202E}"));
    assert!(!output.contains(['\u{1b}', '\u{7}', '\u{202e}', '\r', '\t']));
    key(&mut view, KeyCode::Char('/'));
    handle_event(&mut view, Event::Paste("missing".into()));
    key(&mut view, KeyCode::Esc);
    assert_eq!(view.visible_count(), 0);
    assert!(draw(&mut view, 40, 10).contains("No results"));
    handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL),
    );
    assert_eq!(view.visible_count(), 25);
}

#[test]
fn adapter_details_scroll_and_help_restore_across_small_monochrome_terminals() {
    let installed = accessible_installed::build_installed(
        &serde_json::json!({"models":[{"id":"custom:only"}]}),
        accessible_installed::InstalledCommand::CanRun,
    )
    .unwrap();
    for mut view in [
        ModelView::from_can_run(&can_run_evidence(), false).unwrap(),
        ModelView::from_installed(&installed, false).unwrap(),
    ] {
        let first = draw(&mut view, 32, 10);
        key(&mut view, KeyCode::End);
        let last = draw(&mut view, 32, 10);
        assert_ne!(first, last);
        key(&mut view, KeyCode::Char('?'));
        assert!(draw(&mut view, 32, 10).contains("Keyboard help"));
        key(&mut view, KeyCode::Esc);
        assert_eq!(draw(&mut view, 32, 10), last);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        for (width, height) in [(1, 1), (12, 4), (39, 10), (80, 24), (120, 30)] {
            terminal.backend_mut().resize(width, height);
            terminal.autoresize().unwrap();
            terminal.draw(|frame| render(frame, &mut view)).unwrap();
            for cell in &terminal.backend().buffer().content {
                assert_eq!(cell.fg, ratatui::style::Color::Reset);
                assert_eq!(cell.bg, ratatui::style::Color::Reset);
            }
        }
        assert_eq!(
            handle_key(
                &mut view,
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
            ),
            Some(ModelOutcome::Exit { code: 130 })
        );
    }
}
