use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use llmup_cli::{
    terminal::ChatReply,
    tui_chat::{ChatView, InputAction, handle_key, render},
};
use ratatui::{Terminal, backend::TestBackend};

struct Echo;
impl llmup_cli::terminal::ChatEngine for Echo {
    async fn reply(
        &self,
        messages: &[llmup_runtime::harness::HarnessMessage],
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<ChatReply, String> {
        Ok(ChatReply {
            content: format!("echo {}", messages.last().unwrap().content),
            memory_warning: false,
        })
    }
}
struct Pending;
impl llmup_cli::terminal::ChatEngine for Pending {
    async fn reply(
        &self,
        _: &[llmup_runtime::harness::HarnessMessage],
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
    let code = llmup_cli::tui_chat::drive(
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
    let code = llmup_cli::tui_chat::drive(
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
