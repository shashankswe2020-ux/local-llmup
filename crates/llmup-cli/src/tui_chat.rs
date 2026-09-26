use crate::terminal::{ChatReply, ChatSummary};
use crossterm::event::Event;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::{Stream, StreamExt};
use llmup_runtime::{harness::HarnessMessage, sessions::gui_text};
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    style::{Color, Style},
    widgets::{List, ListItem, ListState, Paragraph},
};
use std::io;
use tokio_util::sync::CancellationToken;
use unicode_segmentation::UnicodeSegmentation;

pub async fn drive<B: ratatui::backend::Backend>(
    terminal: &mut ratatui::Terminal<B>,
    events: &mut (impl Stream<Item = io::Result<Event>> + Unpin),
    engine: &impl crate::terminal::ChatEngine,
    view: &mut ChatView,
    color: bool,
    cancel: &CancellationToken,
) -> io::Result<u8> {
    loop {
        terminal
            .draw(|frame| render(frame, view, color))
            .map_err(|error| io::Error::other(error.to_string()))?;
        let event = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(130),
            event = events.next() => event.ok_or_else(|| io::Error::other("terminal input ended"))??,
        };
        let action = match event {
            Event::Key(key) => handle_key(view, key),
            Event::Paste(text) => {
                if let Err(error) = view.insert(&text) {
                    view.error = Some(error.to_string());
                }
                InputAction::Continue
            }
            _ => InputAction::Continue,
        };
        match action {
            InputAction::Exit => return Ok(u8::from(view.summary.failed_turns > 0)),
            InputAction::Interrupt => {
                cancel.cancel();
                return Ok(130);
            }
            InputAction::Continue => continue,
            InputAction::Submit => (),
        }
        let context = view.submit()?;
        let reply = engine.reply(&context, cancel);
        tokio::pin!(reply);
        loop {
            terminal
                .draw(|frame| render(frame, view, color))
                .map_err(|error| io::Error::other(error.to_string()))?;
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Ok(130),
                reply = &mut reply => {view.finish(reply); break;},
                event = events.next() => {
                    let event = event.ok_or_else(|| io::Error::other("terminal input ended"))??;
                    if let Event::Key(key) = event {
                        match handle_key(view,key) {
                            InputAction::Exit => {cancel.cancel(); return Ok(0);}
                            InputAction::Interrupt => {cancel.cancel(); return Ok(130);}
                            _ => (),
                        }
                    }
                },
            }
        }
    }
}

pub async fn run_chat(
    title: &str,
    engine: &impl crate::terminal::ChatEngine,
    color: bool,
    cancel: &CancellationToken,
) -> io::Result<(ChatSummary, u8)> {
    let mut view = ChatView::new(title);
    let mut signals = crate::cancellation::TerminalSignals::new()?;
    let (mut terminal, _restore) = crate::tui_view::enter_terminal()?;
    let mut events = crate::terminal_events::terminal_events();
    let result = tokio::select! {
        result = drive(&mut terminal, &mut events, engine, &mut view, color, cancel) => result,
        result = signals.recv() => result,
    };
    cancel.cancel();
    let code = result?;
    view.summary.cancelled = matches!(code, 129 | 130 | 143);
    Ok((view.summary, code))
}

#[derive(Debug, PartialEq, Eq)]
pub enum InputAction {
    Continue,
    Submit,
    Exit,
    Interrupt,
}

pub struct ChatView {
    title: String,
    draft: String,
    history: Vec<HarnessMessage>,
    pending: Option<String>,
    error: Option<String>,
    summary: ChatSummary,
}

impl ChatView {
    pub fn new(title: &str) -> Self {
        Self {
            title: gui_text(title).chars().take(256).collect(),
            draft: String::new(),
            history: Vec::new(),
            pending: None,
            error: None,
            summary: ChatSummary::default(),
        }
    }
    pub fn draft(&self) -> &str {
        &self.draft
    }
    pub fn history(&self) -> &[HarnessMessage] {
        &self.history
    }
    pub fn summary(&self) -> &ChatSummary {
        &self.summary
    }
    pub fn insert(&mut self, text: &str) -> io::Result<()> {
        let bytes = self.draft.len().saturating_add(text.len());
        if bytes > 32768 {
            return Err(io::Error::other(format!(
                "Draft exceeds 32768 byte limit ({bytes} bytes)"
            )));
        }
        let text = gui_text(text);
        let next = format!("{}{text}", self.draft);
        crate::terminal::validate_draft(&next)?;
        self.draft = next;
        self.error = None;
        Ok(())
    }
    pub fn submit(&mut self) -> io::Result<Vec<HarnessMessage>> {
        if self.pending.is_some() || self.draft.trim().is_empty() {
            return Err(io::Error::other("no submittable draft"));
        }
        let turn = std::mem::take(&mut self.draft);
        self.pending = Some(turn.clone());
        self.error = None;
        let mut context = self.history.clone();
        context.push(HarnessMessage {
            role: "user".into(),
            content: turn,
        });
        if context.len() > 20 {
            context.drain(..context.len() - 20);
        }
        Ok(context)
    }
    pub fn finish(&mut self, reply: Result<ChatReply, String>) {
        let Some(turn) = self.pending.take() else {
            return;
        };
        let reply = reply.and_then(|reply| {
            if reply.content.len() > 1024 * 1024 {
                Err("response exceeds 1 MiB".into())
            } else {
                Ok(reply)
            }
        });
        match reply {
            Ok(reply) => {
                self.history.push(HarnessMessage {
                    role: "user".into(),
                    content: turn,
                });
                self.history.push(HarnessMessage {
                    role: "assistant".into(),
                    content: reply.content,
                });
                if self.history.len() > 20 {
                    self.history.drain(..self.history.len() - 20);
                }
                self.summary.turns += 1;
                if reply.memory_warning {
                    self.summary.memory_warnings += 1;
                    self.error = Some("Failed to record memory".into());
                }
            }
            Err(error) => {
                self.summary.failed_turns += 1;
                self.error = Some(gui_text(&error).chars().take(1024).collect());
            }
        }
    }
}

pub fn handle_key(view: &mut ChatView, key: KeyEvent) -> InputAction {
    if key.kind == KeyEventKind::Release {
        return InputAction::Continue;
    }
    if key.code == KeyCode::Esc {
        return InputAction::Exit;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        if view.draft.is_empty() || view.pending.is_some() {
            return InputAction::Interrupt;
        }
        view.draft.clear();
        return InputAction::Continue;
    }
    if view.pending.is_some() {
        return InputAction::Continue;
    }
    let inserted = match key.code {
        KeyCode::Enter if !view.draft.trim().is_empty() => return InputAction::Submit,
        KeyCode::Char('j') if key.modifiers.contains(KeyModifiers::CONTROL) => Some("\n".into()),
        KeyCode::Char(character)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && !character.is_control() =>
        {
            Some(character.to_string())
        }
        KeyCode::Backspace => {
            if let Some((position, _)) = view.draft.grapheme_indices(true).next_back() {
                view.draft.truncate(position);
            }
            None
        }
        _ => None,
    };
    if let Some(text) = inserted
        && let Err(error) = view.insert(&text)
    {
        view.error = Some(error.to_string());
    }
    InputAction::Continue
}

fn transcript_lines(view: &ChatView) -> Vec<String> {
    let pending = view.pending.as_ref().map(|turn| {
        (
            ">",
            crate::accessible_text::multiline(turn)
                .unwrap_or_else(|_| "[draft exceeds display limits]".into()),
        )
    });
    let history = view.history.iter().rev().take(10).map(|message| {
        (
            if message.role == "user" { ">" } else { " " },
            crate::accessible_text::chat_message(&message.content)
                .unwrap_or_else(|_| "[message exceeds display limits]".into()),
        )
    });
    let mut retained_bytes = 0usize;
    let mut lines = Vec::new();
    'messages: for (prefix, visible) in pending.into_iter().chain(history) {
        for line in visible.lines().rev() {
            let bytes = prefix.len() + 1 + line.len() + 1;
            if retained_bytes + bytes > 192 * 1024 {
                break 'messages;
            }
            retained_bytes += bytes;
            lines.push(format!("{prefix} {line}"));
        }
    }
    lines.reverse();
    lines
}

pub fn render(frame: &mut Frame<'_>, view: &ChatView, color: bool) {
    let [header, transcript, status, input] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(if frame.area().height > 8 { 3 } else { 1 }),
    ])
    .areas(frame.area());
    let accent = if color {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default()
    };
    frame.render_widget(
        Paragraph::new(format!("local-llmup / chat / {}", view.title)).style(accent),
        header,
    );
    let lines = transcript_lines(view);
    let mut state = ListState::default().with_selected(lines.len().checked_sub(1));
    frame.render_stateful_widget(
        List::new(lines.into_iter().map(ListItem::new).collect::<Vec<_>>()),
        transcript,
        &mut state,
    );
    frame.render_widget(
        Paragraph::new(if view.pending.is_some() {
            "Waiting for response..."
        } else {
            view.error.as_deref().unwrap_or("Ready")
        }),
        status,
    );
    let draft = view
        .draft
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    frame.render_widget(Paragraph::new(format!("> {draft}")).style(accent), input);
}

#[cfg(test)]
mod display_tests {
    use super::*;

    #[test]
    fn newline_heavy_transcript_and_pending_draft_share_the_display_budget() {
        let mut view = ChatView::new("local");
        for _ in 0..5 {
            view.insert("question").unwrap();
            view.submit().unwrap();
            view.finish(Ok(crate::terminal::ChatReply {
                content: "\n".repeat(65536),
                memory_warning: false,
            }));
        }
        view.insert("pending\r\nlast line").unwrap();
        view.submit().unwrap();
        let lines = transcript_lines(&view);
        assert!(lines.iter().map(|line| line.len() + 1).sum::<usize>() <= 192 * 1024);
        assert_eq!(lines.last().unwrap(), "> last line");
        assert!(lines.iter().all(|line| !line.contains(['\r', '\n'])));
        assert_eq!(view.history.len(), 10);
    }

    #[test]
    fn transcript_budget_keeps_latest_rows_without_mutating_history() {
        let mut view = ChatView::new("local");
        for index in 0..6 {
            view.insert("question").unwrap();
            view.submit().unwrap();
            view.finish(Ok(crate::terminal::ChatReply {
                content: format!("{}\nLATEST-{index}", "x".repeat(60 * 1024)),
                memory_warning: false,
            }));
        }
        let before: Vec<_> = view
            .history
            .iter()
            .map(|message| message.content.clone())
            .collect();
        let lines = transcript_lines(&view);
        assert!(lines.iter().map(|line| line.len() + 1).sum::<usize>() <= 192 * 1024);
        assert!(lines.last().unwrap().contains("LATEST-5"));
        assert!(lines.iter().filter(|line| line.len() > 1024).count() < 6);
        assert_eq!(
            before,
            view.history
                .iter()
                .map(|message| message.content.clone())
                .collect::<Vec<_>>()
        );
    }
}
