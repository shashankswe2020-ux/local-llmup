use crossterm::{
    cursor::{Hide, Show},
    event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures_util::StreamExt;
use llmup_core::reports::strip_control;
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    widgets::{List, ListItem, ListState, Paragraph},
};
use std::io;
use unicode_segmentation::UnicodeSegmentation;

pub struct ReportView {
    title: String,
    lines: Vec<String>,
    state: ListState,
    query: String,
    searching: bool,
    color: bool,
    horizontal: usize,
    page: usize,
}

impl ReportView {
    pub fn new(title: &str, text: &str, color: bool) -> io::Result<Self> {
        if text.len() > 1024 * 1024 || text.lines().count() > 20000 || title.len() > 256 {
            return Err(io::Error::other("report exceeds terminal display limits"));
        }
        let mut lines: Vec<_> = text.lines().map(strip_control).collect();
        if lines.is_empty() {
            lines.push("No results".into());
        }
        Ok(Self {
            title: strip_control(title),
            lines,
            state: ListState::default().with_selected(Some(0)),
            query: String::new(),
            searching: false,
            color,
            horizontal: 0,
            page: 10,
        })
    }
    pub fn selected(&self) -> usize {
        self.state.selected().unwrap_or(0)
    }
    fn select(&mut self, selected: usize) {
        self.state.select(Some(selected.min(self.lines.len() - 1)));
    }
    fn find(&mut self, next: bool) {
        if self.query.is_empty() {
            return;
        }
        let query = self.query.to_lowercase();
        let start = if next { self.selected() + 1 } else { 0 };
        for offset in 0..self.lines.len() {
            let index = (start + offset) % self.lines.len();
            if self.lines[index].to_lowercase().contains(&query) {
                self.select(index);
                break;
            }
        }
    }
}

pub fn handle_key(view: &mut ReportView, key: KeyEvent) -> bool {
    if key.kind == KeyEventKind::Release {
        return false;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return true;
    }
    if view.searching {
        match key.code {
            KeyCode::Esc => {
                view.searching = false;
                view.query.clear();
            }
            KeyCode::Enter => view.searching = false,
            KeyCode::Backspace => {
                view.query.pop();
                view.find(false);
            }
            KeyCode::Char(character)
                if !character.is_control() && view.query.len() + character.len_utf8() <= 256 =>
            {
                view.query.push(character);
                view.find(false);
            }
            _ => (),
        }
        return false;
    }
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc | KeyCode::Enter => return true,
        KeyCode::Down | KeyCode::Char('j') => view.select(view.selected().saturating_add(1)),
        KeyCode::Up | KeyCode::Char('k') => view.select(view.selected().saturating_sub(1)),
        KeyCode::PageDown => view.select(view.selected().saturating_add(view.page)),
        KeyCode::PageUp => view.select(view.selected().saturating_sub(view.page)),
        KeyCode::Home => view.select(0),
        KeyCode::End => view.select(view.lines.len() - 1),
        KeyCode::Right => view.horizontal = view.horizontal.saturating_add(8).min(32768),
        KeyCode::Left => view.horizontal = view.horizontal.saturating_sub(8),
        KeyCode::Char('/') => {
            view.searching = true;
            view.query.clear();
        }
        KeyCode::Char('n') => view.find(true),
        _ => (),
    }
    false
}

pub fn render(frame: &mut Frame<'_>, view: &mut ReportView) {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    view.page = usize::from(body.height.max(1));
    let accent = if view.color {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default()
    };
    frame.render_widget(
        Paragraph::new(view.title.as_str()).style(accent.add_modifier(Modifier::BOLD)),
        header,
    );
    let items: Vec<_> = view
        .lines
        .iter()
        .map(|line| {
            ListItem::new(
                line.graphemes(true)
                    .skip(view.horizontal)
                    .collect::<String>(),
            )
        })
        .collect();
    frame.render_stateful_widget(
        List::new(items)
            .highlight_symbol("> ")
            .highlight_style(accent.add_modifier(Modifier::REVERSED)),
        body,
        &mut view.state,
    );
    let status = if view.searching {
        format!("/{}", view.query)
    } else {
        format!("{} / {}", view.selected() + 1, view.lines.len())
    };
    frame.render_widget(Paragraph::new(status), footer);
}

pub(crate) struct RestoreTerminal;
impl Drop for RestoreTerminal {
    fn drop(&mut self) {
        let _ = execute!(
            io::stderr(),
            crossterm::event::DisableBracketedPaste,
            Show,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}

pub(crate) fn enter_terminal()
-> io::Result<(Terminal<CrosstermBackend<io::Stderr>>, RestoreTerminal)> {
    enable_raw_mode()?;
    let restore = RestoreTerminal;
    execute!(
        io::stderr(),
        EnterAlternateScreen,
        Hide,
        crossterm::event::EnableBracketedPaste
    )?;
    let terminal = Terminal::new(CrosstermBackend::new(io::stderr()))?;
    Ok((terminal, restore))
}

pub async fn show_report(title: &str, text: &str, color: bool) -> io::Result<u8> {
    let mut view = ReportView::new(title, text, color)?;
    let (mut terminal, _restore) = enter_terminal()?;
    let mut events = EventStream::new();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        terminal.draw(|frame| render(frame, &mut view))?;
        let event = tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(130),
            _ = async {
                #[cfg(unix)]
                terminate.recv().await;
                #[cfg(not(unix))]
                std::future::pending::<()>().await;
            } => return Ok(143),
            event = events.next() => event.ok_or_else(|| io::Error::other("terminal input ended"))??,
        };
        if let Event::Key(key) = event {
            let interrupted =
                key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c');
            if handle_key(&mut view, key) {
                return Ok(if interrupted { 130 } else { 0 });
            }
        }
    }
}
pub async fn pick(title: &str, choices: &[String], color: bool) -> io::Result<(Option<usize>, u8)> {
    if choices.is_empty() || choices.iter().any(|choice| choice.contains(['\n', '\r'])) {
        return Err(io::Error::other("invalid terminal choices"));
    }
    let mut view = ReportView::new(title, &choices.join("\n"), color)?;
    let (mut terminal, _restore) = enter_terminal()?;
    let mut events = EventStream::new();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        terminal.draw(|frame| render(frame, &mut view))?;
        let event = tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok((None,130)),
            _ = async {
                #[cfg(unix)]
                terminate.recv().await;
                #[cfg(not(unix))]
                std::future::pending::<()>().await;
            } => return Ok((None,143)),
            event = events.next() => event.ok_or_else(|| io::Error::other("terminal input ended"))??,
        };
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release {
                continue;
            }
            if key.code == KeyCode::Enter && !view.searching {
                return Ok((Some(view.selected()), 0));
            }
            let interrupted =
                key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c');
            if handle_key(&mut view, key) {
                return Ok((None, if interrupted { 130 } else { 0 }));
            }
        }
    }
}
