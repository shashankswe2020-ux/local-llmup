use crate::terminal::{ChatReply, ChatSummary};
use crate::tui_theme::{self, Theme};
use crossterm::event::Event;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind};
use futures_util::{Stream, StreamExt};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};
use rigspark_runtime::{harness::HarnessMessage, sessions::gui_text};
use std::io;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use unicode_segmentation::UnicodeSegmentation;

const MAX_STREAM_BYTES: usize = 1024 * 1024;

fn scroll_event(view: &mut ChatView, event: &Event) {
    if let Event::Mouse(mouse) = event {
        match mouse.kind {
            MouseEventKind::ScrollUp => view.scroll = view.scroll.saturating_add(3),
            MouseEventKind::ScrollDown => view.scroll = view.scroll.saturating_sub(3),
            _ => (),
        }
    }
}

fn flush_clipboard(view: &mut ChatView) -> io::Result<()> {
    match view.clipboard.take() {
        Some(text) => tui_theme::copy_to_clipboard(&text),
        None => Ok(()),
    }
}

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
        scroll_event(view, &event);
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
        flush_clipboard(view)?;
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
        let (sender, mut deltas) = tokio::sync::mpsc::unbounded_channel();
        let reply = engine.reply_streaming(&context, cancel, sender);
        tokio::pin!(reply);
        loop {
            terminal
                .draw(|frame| render(frame, view, color))
                .map_err(|error| io::Error::other(error.to_string()))?;
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Ok(130),
                reply = &mut reply => {view.finish(reply); break;},
                Some(delta) = deltas.recv() => view.stream(&delta),
                () = tokio::time::sleep(Duration::from_millis(250)) => (),
                event = events.next() => {
                    let event = event.ok_or_else(|| io::Error::other("terminal input ended"))??;
                    scroll_event(view, &event);
                    if let Event::Key(key) = event {
                        match handle_key(view,key) {
                            InputAction::Exit => {cancel.cancel(); return Ok(0);}
                            InputAction::Interrupt => {cancel.cancel(); return Ok(130);}
                            _ => (),
                        }
                    }
                    flush_clipboard(view)?;
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
    streaming: String,
    error: Option<String>,
    summary: ChatSummary,
    scroll: usize,
    started: Option<Instant>,
    first_output: Option<Duration>,
    timing: Option<(Option<Duration>, Duration)>,
    clipboard: Option<String>,
    notice: Option<&'static str>,
}

impl ChatView {
    pub fn new(title: &str) -> Self {
        Self {
            title: gui_text(title).chars().take(256).collect(),
            draft: String::new(),
            history: Vec::new(),
            pending: None,
            streaming: String::new(),
            error: None,
            summary: ChatSummary::default(),
            scroll: 0,
            started: None,
            first_output: None,
            timing: None,
            clipboard: None,
            notice: None,
        }
    }
    /// Appends partial assistant output; anything past the 1 MiB reply limit is dropped.
    pub fn stream(&mut self, delta: &str) {
        if self.pending.is_none() {
            return;
        }
        if self.first_output.is_none() {
            self.first_output = self.started.map(|started| started.elapsed());
        }
        let room = MAX_STREAM_BYTES.saturating_sub(self.streaming.len());
        let mut end = delta.len().min(room);
        while !delta.is_char_boundary(end) {
            end -= 1;
        }
        self.streaming.push_str(&delta[..end]);
    }
    pub fn streaming(&self) -> &str {
        &self.streaming
    }
    pub fn take_clipboard(&mut self) -> Option<String> {
        self.clipboard.take()
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
        self.streaming.clear();
        self.scroll = 0;
        self.started = Some(Instant::now());
        self.first_output = None;
        self.timing = None;
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
        self.streaming.clear();
        if let Some(started) = self.started.take() {
            self.timing = Some((self.first_output.take(), started.elapsed()));
        }
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
    view.notice = None;
    match key.code {
        KeyCode::PageUp => {
            view.scroll = view.scroll.saturating_add(10).min(1 << 20);
            return InputAction::Continue;
        }
        KeyCode::PageDown => {
            view.scroll = view.scroll.saturating_sub(10);
            return InputAction::Continue;
        }
        KeyCode::End => {
            view.scroll = 0;
            return InputAction::Continue;
        }
        KeyCode::Char('y') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            let last = view
                .history
                .iter()
                .rev()
                .find(|message| message.role == "assistant")
                .map(|message| message.content.clone());
            match last {
                Some(text) => {
                    view.clipboard = Some(text);
                    view.notice = Some("Copied last reply to clipboard");
                }
                None => view.notice = Some("No reply to copy yet"),
            }
            return InputAction::Continue;
        }
        _ => (),
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
    let streaming = (view.pending.is_some() && !view.streaming.is_empty()).then(|| {
        (
            " ",
            crate::accessible_text::chat_message(&view.streaming)
                .unwrap_or_else(|_| "[message exceeds display limits]".into()),
        )
    });
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
    'messages: for (prefix, visible) in streaming.into_iter().chain(pending).chain(history) {
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
    let area = frame.area();
    let theme = Theme::new(color);
    let roomy = area.height > 12;
    let [header, transcript, status, input, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(if roomy {
            5
        } else if area.height > 8 {
            3
        } else {
            1
        }),
        Constraint::Length(if area.height > 8 { 1 } else { 0 }),
    ])
    .areas(area);
    theme.header(
        frame,
        header,
        &format!("rigspark / chat / {}", view.title),
        &format!(
            "{} turn{}",
            view.summary.turns,
            if view.summary.turns == 1 { "" } else { "s" }
        ),
    );
    let (rows, scrolled) = transcript_rows(view, transcript, theme);
    frame.render_widget(Paragraph::new(rows), transcript);
    let seconds = |duration: Duration| format!("{:.1}s", duration.as_secs_f64());
    let status_line = if view.pending.is_some() {
        let mut text = " Waiting for response...".to_owned();
        if let Some(started) = view.started {
            text.push_str(&format!(" {}", seconds(started.elapsed())));
        }
        if let Some(first) = view.first_output {
            text.push_str(&format!(" · first output {}", seconds(first)));
        }
        Line::styled(text, theme.warning())
    } else if let Some(error) = &view.error {
        Line::styled(format!(" {error}"), theme.error())
    } else if let Some(notice) = view.notice {
        Line::styled(format!(" {notice}"), theme.success())
    } else {
        let mut text = " Ready".to_owned();
        if let Some((first, total)) = view.timing {
            if let Some(first) = first {
                text.push_str(&format!(" · first output {}", seconds(first)));
            }
            text.push_str(&format!(" · {} total", seconds(total)));
        }
        Line::styled(text, theme.muted())
    };
    let right = if scrolled > 0 {
        Line::styled(format!("↑ {scrolled} lines · End follows "), theme.accent())
    } else {
        Line::default()
    };
    theme.bar(frame, status, status_line, right);
    let inner = if roomy {
        theme.panel(frame, input, "Message")
    } else {
        input
    };
    let mut draft: Vec<&str> = view.draft.split('\n').collect();
    let keep = usize::from(inner.height.max(1));
    draft.drain(..draft.len().saturating_sub(keep));
    let last = draft.len() - 1;
    let lines: Vec<_> = draft
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let mut spans = vec![if index == 0 {
                Span::styled("> ", theme.title())
            } else {
                Span::raw("  ")
            }];
            spans.push(Span::raw(tail(
                text,
                usize::from(inner.width).saturating_sub(3),
            )));
            if index == last && view.pending.is_none() {
                spans.push(Span::styled("▌", theme.accent()));
                if view.draft.is_empty() {
                    spans.push(Span::styled(" Type a message", theme.muted()));
                }
            }
            Line::from(spans)
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
    frame.render_widget(
        Paragraph::new(theme.hints(
            &[
                ("Enter", "send"),
                ("Ctrl+J", "newline"),
                ("PgUp/PgDn", "scroll"),
                ("Ctrl+Y", "copy reply"),
                ("Ctrl+C", "clear/stop"),
                ("Esc", "exit"),
            ],
            footer.width,
        )),
        footer,
    );
}

/// The trailing graphemes of `text` that fit in `width` cells, so the cursor stays visible.
fn tail(text: &str, width: usize) -> String {
    let mut used = 0;
    let mut kept: Vec<&str> = text
        .graphemes(true)
        .rev()
        .take_while(|grapheme| {
            used += crate::tui_theme::width(grapheme);
            used <= width
        })
        .collect();
    kept.reverse();
    kept.concat()
}

/// Transcript rows with role labels and lightweight markdown, windowed by the scroll offset.
/// Returns the visible rows and how many rows sit below the window.
fn transcript_rows(view: &ChatView, area: Rect, theme: Theme) -> (Vec<Line<'static>>, usize) {
    let height = usize::from(area.height);
    let width = usize::from(area.width.saturating_sub(3)).max(1);
    let code = theme.accent();
    let mut rows = Vec::new();
    let mut previous = None;
    let mut fenced = false;
    for line in &transcript_lines(view) {
        let user = line.starts_with('>');
        if previous != Some(user) {
            if previous.is_some() {
                rows.push(Line::default());
            }
            rows.push(if user {
                Line::styled(" you", theme.title())
            } else {
                Line::styled(" assistant", theme.success())
            });
            fenced = false;
        }
        previous = Some(user);
        let text = line.get(2..).unwrap_or("");
        let trimmed = text.trim_start();
        if !user && trimmed.starts_with("```") {
            fenced = !fenced;
            rows.push(Line::styled(format!("   {}", trimmed), theme.muted()));
            continue;
        }
        let (lead, body, style, markup) = if user {
            ("", text, theme.strong(), false)
        } else if fenced {
            ("", text, code, false)
        } else if let Some(heading) = trimmed
            .strip_prefix("### ")
            .or_else(|| trimmed.strip_prefix("## "))
            .or_else(|| trimmed.strip_prefix("# "))
        {
            ("", heading, theme.title(), true)
        } else if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            ("• ", item, Style::default(), true)
        } else {
            ("", text, Style::default(), true)
        };
        let indent = tui_theme::width(lead);
        for (index, piece) in tui_theme::wrap(body, width.saturating_sub(indent).max(1))
            .into_iter()
            .enumerate()
        {
            let mut spans = vec![
                Span::raw("   "),
                Span::styled(
                    if index == 0 {
                        lead.to_owned()
                    } else {
                        " ".repeat(indent)
                    },
                    theme.muted(),
                ),
            ];
            if markup {
                spans.extend(inline_markdown(&piece, style, code));
            } else {
                spans.push(Span::styled(piece, style));
            }
            rows.push(Line::from(spans));
        }
    }
    let below = view.scroll.min(rows.len().saturating_sub(height));
    let end = rows.len() - below;
    rows.truncate(end);
    let start = end.saturating_sub(height);
    (rows.split_off(start), below)
}

/// Renders `code` spans and `**bold**` runs; unmatched markers are shown literally.
fn inline_markdown(text: &str, base: Style, code: Style) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let segments: Vec<&str> = text.split('`').collect();
    let balanced = segments.len() % 2 == 1;
    for (index, segment) in segments.iter().enumerate() {
        if balanced && index % 2 == 1 {
            spans.push(Span::styled((*segment).to_owned(), code));
            continue;
        }
        let prefix = if !balanced && index > 0 { "`" } else { "" };
        let parts: Vec<&str> = segment.split("**").collect();
        let bold_balanced = parts.len() % 2 == 1;
        for (part_index, part) in parts.iter().enumerate() {
            let mut content = String::new();
            if part_index == 0 {
                content.push_str(prefix);
            }
            if !bold_balanced && part_index > 0 {
                content.push_str("**");
            }
            content.push_str(part);
            if content.is_empty() {
                continue;
            }
            let style = if bold_balanced && part_index % 2 == 1 {
                base.add_modifier(Modifier::BOLD)
            } else {
                base
            };
            spans.push(Span::styled(content, style));
        }
    }
    spans
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
