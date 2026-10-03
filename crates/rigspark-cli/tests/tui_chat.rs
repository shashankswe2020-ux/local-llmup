use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use rigspark_cli::{
    terminal::ChatReply,
    tui_chat::{ChatView, InputAction, handle_key, render},
};

struct Echo;
impl rigspark_cli::terminal::ChatEngine for Echo {
    async fn reply(
        &self,
        messages: &[rigspark_runtime::harness::HarnessMessage],
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<ChatReply, String> {
        Ok(ChatReply {
            content: format!("echo {}", messages.last().unwrap().content),
            memory_warning: false,
        })
    }
}
struct Pending;
impl rigspark_cli::terminal::ChatEngine for Pending {
    async fn reply(
        &self,
        _: &[rigspark_runtime::harness::HarnessMessage],
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<ChatReply, String> {
        std::future::pending().await
    }
}

fn events() -> impl futures_util::Stream<Item = std::io::Result<crossterm::event::Event>> + Unpin {
    futures_util::stream::iter(
        [
            KeyCode::Char('h'),
            KeyCode::Char('i'),
            KeyCode::Enter,
            KeyCode::Esc,
        ]
        .map(|key| {
            Ok(crossterm::event::Event::Key(KeyEvent::new(
                key,
                KeyModifiers::NONE,
            )))
        }),
    )
}

#[tokio::test]
async fn controller_completes_successful_turns_and_cancels_pending_turns() {
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    let mut view = ChatView::new("test");
    let cancel = tokio_util::sync::CancellationToken::new();
    let code = rigspark_cli::tui_chat::drive(
        &mut terminal,
        &mut events(),
        &Echo,
        &mut view,
        false,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(view.summary().turns, 1);
    assert_eq!(view.history().last().unwrap().content, "echo hi");
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut view = ChatView::new("test");
    let code = rigspark_cli::tui_chat::drive(
        &mut terminal,
        &mut events(),
        &Pending,
        &mut view,
        false,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(code, 0);
    assert!(cancel.is_cancelled());
    assert!(view.history().is_empty());
    assert_eq!(view.summary().turns, 0);
}

#[test]
fn drafts_are_bounded_and_backspace_removes_whole_graphemes() {
    let mut view = ChatView::new("local");
    view.insert("hello e\u{301}").unwrap();
    handle_key(
        &mut view,
        KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
    );
    assert_eq!(view.draft(), "hello ");
    assert!(view.insert(&"x".repeat(32769)).is_err());
    assert_eq!(view.draft(), "hello ");
    assert_eq!(
        handle_key(
            &mut view,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ),
        InputAction::Continue
    );
    assert_eq!(view.draft(), "");
    assert_eq!(
        handle_key(
            &mut view,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ),
        InputAction::Interrupt
    );
}

#[test]
fn rendered_reply_escapes_controls_without_mutating_conversation_content() {
    let mut view = ChatView::new("local");
    view.insert("question").unwrap();
    view.submit().unwrap();
    let raw = "first\r\nsecond\u{1b}[31m\u{202e}end";
    view.finish(Ok(ChatReply {
        content: raw.into(),
        memory_warning: false,
    }));
    let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
    terminal.draw(|frame| render(frame, &view, false)).unwrap();
    let text: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert!(text.contains("second\\u{1B}[31m\\u{202E}end"), "{text}");
    assert!(!text.contains(['\u{1b}', '\u{202e}', '\r']));
    assert_eq!(view.history().last().unwrap().content, raw);
}

#[test]
fn draft_limits_preserve_inclusive_boundaries_and_error_precedence() {
    for accepted in [
        "a".repeat(8192),
        "\u{1f600}".repeat(8192),
        "line\n".repeat(255),
    ] {
        let mut view = ChatView::new("local");
        view.insert(&accepted).unwrap();
        assert_eq!(view.draft(), accepted);
    }
    for (draft, expected) in [
        (
            "a".repeat(32769),
            "Draft exceeds 32768 byte limit (32769 bytes)",
        ),
        (
            "\u{1f600}".repeat(8193),
            "Draft exceeds 32768 byte limit (32772 bytes)",
        ),
        (
            "a".repeat(32768),
            "Draft exceeds 8192 grapheme limit (32768 graphemes)",
        ),
        (
            "a".repeat(8193),
            "Draft exceeds 8192 grapheme limit (8193 graphemes)",
        ),
        (
            "line\n".repeat(256),
            "Draft exceeds 256 line limit (257 lines)",
        ),
    ] {
        let mut view = ChatView::new("local");
        assert_eq!(view.insert(&draft).unwrap_err().to_string(), expected);
        assert_eq!(view.draft(), "");
        assert!(view.submit().is_err());
    }
}

#[test]
fn appending_a_trailing_newline_cannot_exceed_the_line_limit() {
    let mut view = ChatView::new("local");
    view.insert(&"line\n".repeat(255)).unwrap();
    let before = view.draft().to_owned();
    assert_eq!(
        view.insert("\n").unwrap_err().to_string(),
        "Draft exceeds 256 line limit (257 lines)"
    );
    assert_eq!(view.draft(), before);
}

#[test]
fn only_successful_bounded_turns_enter_context() {
    let mut view = ChatView::new("local");
    view.insert("question").unwrap();
    let messages = view.submit().unwrap();
    assert_eq!(messages.len(), 1);
    assert!(view.submit().is_err());
    view.finish(Err("provider failed".into()));
    assert!(view.history().is_empty());
    for _ in 0..12 {
        view.insert("question").unwrap();
        assert!(view.submit().unwrap().len() <= 20);
        view.finish(Ok(ChatReply {
            content: "answer".into(),
            memory_warning: false,
        }));
    }
    assert_eq!(view.history().len(), 20);
    assert_eq!(view.summary().turns, 12);
    assert_eq!(view.summary().failed_turns, 1);
    view.insert("large").unwrap();
    view.submit().unwrap();
    view.finish(Ok(ChatReply {
        content: "x".repeat(1024 * 1024 + 1),
        memory_warning: false,
    }));
    assert_eq!(view.summary().failed_turns, 2);
    assert_eq!(view.history().last().unwrap().content, "answer");
}

#[test]
fn chat_renders_pending_response_and_input_with_bounded_layout() {
    for (width, height) in [(20, 5), (60, 16), (120, 40)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut view = ChatView::new("local");
        view.insert("question").unwrap();
        view.submit().unwrap();
        terminal.draw(|frame| render(frame, &view, false)).unwrap();
        let text = terminal.backend().to_string();
        assert!(text.contains("chat"));
        assert!(text.contains("Waiting"));
        view.finish(Ok(ChatReply {
            content: "answer".into(),
            memory_warning: true,
        }));
        terminal.draw(|frame| render(frame, &view, false)).unwrap();
        assert_eq!(view.summary().memory_warnings, 1);
        assert!(terminal.backend().to_string().contains("answer"));
    }
}

#[test]
fn long_replies_word_wrap_under_role_labels_instead_of_truncating() {
    let mut view = ChatView::new("local");
    view.insert("question").unwrap();
    view.submit().unwrap();
    view.finish(Ok(ChatReply {
        content: "word ".repeat(40),
        memory_warning: false,
    }));
    let mut terminal = Terminal::new(TestBackend::new(40, 24)).unwrap();
    terminal.draw(|frame| render(frame, &view, false)).unwrap();
    let text = terminal.backend().to_string();
    assert_eq!(text.matches("word").count(), 40, "{text}");
    assert!(text.contains(" you"), "{text}");
    assert!(text.contains(" assistant"), "{text}");
    assert!(text.contains("rigspark / chat / local"), "{text}");
}

struct Streamer;
impl rigspark_cli::terminal::ChatEngine for Streamer {
    async fn reply(
        &self,
        _: &[rigspark_runtime::harness::HarnessMessage],
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<ChatReply, String> {
        unreachable!("the TUI must request streaming replies")
    }
    async fn reply_streaming(
        &self,
        _: &[rigspark_runtime::harness::HarnessMessage],
        _: &tokio_util::sync::CancellationToken,
        deltas: tokio::sync::mpsc::UnboundedSender<String>,
    ) -> Result<ChatReply, String> {
        for delta in ["hel", "lo"] {
            deltas.send(delta.into()).unwrap();
            tokio::task::yield_now().await;
        }
        Ok(ChatReply {
            content: "hello".into(),
            memory_warning: false,
        })
    }
}

#[tokio::test]
async fn streamed_deltas_render_before_the_authoritative_reply_replaces_them() {
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    let mut view = ChatView::new("local");
    let code = rigspark_cli::tui_chat::drive(
        &mut terminal,
        &mut events(),
        &Streamer,
        &mut view,
        false,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(view.history().last().unwrap().content, "hello");
    assert_eq!(view.streaming(), "");
    let mut view = ChatView::new("local");
    view.insert("question").unwrap();
    view.submit().unwrap();
    view.stream("partial answer");
    terminal.draw(|frame| render(frame, &view, false)).unwrap();
    let text = terminal.backend().to_string();
    assert!(text.contains("partial answer"), "{text}");
    assert!(text.contains("first output"), "{text}");
}

#[test]
fn markdown_scrollback_and_copy_are_rendered_without_altering_history() {
    let reply = "# Title\n- item `code` **bold**\n```\nlet x = 1;\n```\n".to_owned()
        + &(0..60)
            .map(|index| format!("line {index}\n"))
            .collect::<String>();
    let mut view = ChatView::new("local");
    view.insert("question").unwrap();
    view.submit().unwrap();
    view.finish(Ok(ChatReply {
        content: reply.clone(),
        memory_warning: false,
    }));
    let mut terminal = Terminal::new(TestBackend::new(60, 20)).unwrap();
    terminal.draw(|frame| render(frame, &view, false)).unwrap();
    let bottom = terminal.backend().to_string();
    assert!(bottom.contains("line 59"), "{bottom}");
    assert!(bottom.contains("total"), "{bottom}");
    for _ in 0..10 {
        handle_key(
            &mut view,
            KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
        );
    }
    terminal.draw(|frame| render(frame, &view, false)).unwrap();
    let top = terminal.backend().to_string();
    assert!(top.contains("Title"), "{top}");
    assert!(top.contains("• item code bold"), "{top}");
    assert!(top.contains("let x = 1;"), "{top}");
    assert!(!top.contains("**"), "{top}");
    assert!(top.contains("End follows"), "{top}");
    handle_key(&mut view, KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    terminal.draw(|frame| render(frame, &view, false)).unwrap();
    assert!(terminal.backend().to_string().contains("line 59"));
    assert_eq!(
        handle_key(
            &mut view,
            KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL)
        ),
        InputAction::Continue
    );
    assert_eq!(view.take_clipboard().as_deref(), Some(reply.as_str()));
    assert_eq!(view.history().last().unwrap().content, reply);
}
