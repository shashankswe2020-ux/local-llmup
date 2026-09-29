use crossterm::{
    cursor::{Hide, Show},
    event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures_util::StreamExt;
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    widgets::{List, ListItem, ListState, Paragraph},
};
use rigspark_core::reports::strip_control;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminalResource {
    Raw,
    Alternate,
    Cursor,
    Paste,
}

const TERMINAL_RESOURCES: [TerminalResource; 4] = [
    TerminalResource::Raw,
    TerminalResource::Alternate,
    TerminalResource::Cursor,
    TerminalResource::Paste,
];

pub(crate) trait TerminalControl {
    fn raw(&self) -> io::Result<bool>;
    fn set(&mut self, resource: TerminalResource, enabled: bool) -> io::Result<()>;
}

pub(crate) struct SystemTerminal;

impl TerminalControl for SystemTerminal {
    fn raw(&self) -> io::Result<bool> {
        crossterm::terminal::is_raw_mode_enabled()
    }
    fn set(&mut self, resource: TerminalResource, enabled: bool) -> io::Result<()> {
        match (resource, enabled) {
            (TerminalResource::Raw, true) => enable_raw_mode(),
            (TerminalResource::Raw, false) => disable_raw_mode(),
            (TerminalResource::Alternate, true) => execute!(io::stderr(), EnterAlternateScreen),
            (TerminalResource::Alternate, false) => execute!(io::stderr(), LeaveAlternateScreen),
            (TerminalResource::Cursor, true) => execute!(io::stderr(), Hide),
            (TerminalResource::Cursor, false) => execute!(io::stderr(), Show),
            (TerminalResource::Paste, true) => {
                execute!(io::stderr(), crossterm::event::EnableBracketedPaste)
            }
            (TerminalResource::Paste, false) => {
                execute!(io::stderr(), crossterm::event::DisableBracketedPaste)
            }
        }
    }
}

pub(crate) struct RestoreTerminal<Control: TerminalControl = SystemTerminal> {
    control: Control,
    initially_raw: bool,
    acquired: usize,
}

impl<Control: TerminalControl> RestoreTerminal<Control> {
    fn acquire(control: Control) -> io::Result<Self> {
        let initially_raw = control.raw()?;
        let mut restore = Self {
            control,
            initially_raw,
            acquired: 0,
        };
        for resource in TERMINAL_RESOURCES {
            restore.acquired += 1;
            restore.control.set(resource, true)?;
        }
        Ok(restore)
    }
}

impl<Control: TerminalControl> Drop for RestoreTerminal<Control> {
    fn drop(&mut self) {
        for resource in TERMINAL_RESOURCES[..self.acquired].iter().rev() {
            let enabled = *resource == TerminalResource::Raw && self.initially_raw;
            let _ = self.control.set(*resource, enabled);
        }
    }
}

pub(crate) fn enter_terminal()
-> io::Result<(Terminal<CrosstermBackend<io::Stderr>>, RestoreTerminal)> {
    let restore = RestoreTerminal::acquire(SystemTerminal)?;
    let terminal = Terminal::new(CrosstermBackend::new(io::stderr()))?;
    Ok((terminal, restore))
}

pub async fn show_report(title: &str, text: &str, color: bool) -> io::Result<u8> {
    let mut view = ReportView::new(title, text, color)?;
    let mut signals = crate::cancellation::TerminalSignals::new()?;
    let (mut terminal, _restore) = enter_terminal()?;
    let mut events = crate::terminal_events::terminal_events();
    loop {
        terminal.draw(|frame| render(frame, &mut view))?;
        let event = tokio::select! {
            code = signals.recv() => return code,
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
pub(crate) async fn next_navigation_event(
    events: &mut (impl futures_util::Stream<Item = io::Result<Event>> + Unpin),
) -> io::Result<Event> {
    let event = events
        .next()
        .await
        .ok_or_else(|| io::Error::other("terminal input ended"))??;
    let Event::Key(escape) = event else {
        return Ok(event);
    };
    if escape.code != KeyCode::Esc || escape.kind == KeyEventKind::Release {
        return Ok(event);
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(50);
    let mut bracket = false;
    loop {
        let Ok(next) = tokio::time::timeout_at(deadline, events.next()).await else {
            return Ok(event);
        };
        let next = next.ok_or_else(|| io::Error::other("terminal input ended"))??;
        let Event::Key(mut key) = next else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Ok(next);
        }
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
        {
            return Ok(event);
        }
        match (bracket, key.code) {
            (false, KeyCode::Char('[')) => bracket = true,
            (true, KeyCode::Char('H' | 'F')) => {
                key.code = if key.code == KeyCode::Char('H') {
                    KeyCode::Home
                } else {
                    KeyCode::End
                };
                return Ok(Event::Key(key));
            }
            _ => return Ok(event),
        }
    }
}

pub async fn pick(title: &str, choices: &[String], color: bool) -> io::Result<(Option<usize>, u8)> {
    crate::accessible::validate_picker_choices(choices, 8192)?;
    let mut view = ReportView::new(title, &choices.join("\n"), color)?;
    let mut signals = crate::cancellation::TerminalSignals::new()?;
    let (mut terminal, _restore) = enter_terminal()?;
    let mut events = crate::terminal_events::terminal_events();
    loop {
        terminal.draw(|frame| render(frame, &mut view))?;
        let event = tokio::select! {
            code = signals.recv() => return Ok((None, code?)),
            event = next_navigation_event(&mut events) => event?,
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

#[cfg(test)]
mod resource_tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[derive(Default)]
    struct State {
        raw: bool,
        calls: Vec<(TerminalResource, bool)>,
    }

    struct Control {
        state: Rc<RefCell<State>>,
        fail: Option<(TerminalResource, bool)>,
    }

    impl TerminalControl for Control {
        fn raw(&self) -> io::Result<bool> {
            Ok(self.state.borrow().raw)
        }
        fn set(&mut self, resource: TerminalResource, enabled: bool) -> io::Result<()> {
            let mut state = self.state.borrow_mut();
            state.calls.push((resource, enabled));
            if resource == TerminalResource::Raw {
                state.raw = enabled;
            }
            if self.fail == Some((resource, enabled)) {
                return Err(io::Error::other("injected failure after mutation"));
            }
            Ok(())
        }
    }

    #[test]
    fn partial_acquisition_restores_each_owned_resource_and_original_raw_mode() {
        use TerminalResource::*;
        for fail in [Raw, Alternate, Cursor, Paste] {
            let state = Rc::new(RefCell::new(State::default()));
            assert!(
                RestoreTerminal::acquire(Control {
                    state: state.clone(),
                    fail: Some((fail, true))
                })
                .is_err()
            );
            let state = state.borrow();
            assert!(!state.raw);
            for resource in [Raw, Alternate, Cursor, Paste] {
                let acquired = state.calls.contains(&(resource, true));
                assert_eq!(
                    state
                        .calls
                        .iter()
                        .filter(|call| **call == (resource, false))
                        .count(),
                    usize::from(acquired)
                );
            }
        }
        let state = Rc::new(RefCell::new(State {
            raw: true,
            ..Default::default()
        }));
        drop(
            RestoreTerminal::acquire(Control {
                state: state.clone(),
                fail: None,
            })
            .unwrap(),
        );
        assert!(state.borrow().raw);
        assert!(!state.borrow().calls.contains(&(Raw, false)));
    }

    #[test]
    fn restoration_continues_after_independent_output_failure_and_repeated_sessions() {
        use TerminalResource::*;
        for failed in [Paste, Cursor, Alternate, Raw] {
            let state = Rc::new(RefCell::new(State::default()));
            for _ in 0..20 {
                let restore = RestoreTerminal::acquire(Control {
                    state: state.clone(),
                    fail: Some((failed, false)),
                })
                .unwrap();
                assert!(state.borrow().raw);
                drop(restore);
                assert!(!state.borrow().raw);
            }
            for resource in [Raw, Alternate, Cursor, Paste] {
                assert_eq!(
                    state
                        .borrow()
                        .calls
                        .iter()
                        .filter(|call| **call == (resource, false))
                        .count(),
                    20
                );
            }
        }
    }
}
