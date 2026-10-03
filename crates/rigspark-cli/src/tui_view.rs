use crate::tui_theme::{SyncWriter, Theme};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
        MouseEventKind,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures_util::StreamExt;
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout, Position, Rect},
    text::{Line, Span},
    widgets::{HighlightSpacing, List, ListItem, ListState},
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
    picker: bool,
    horizontal: usize,
    page: usize,
    list_area: Rect,
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
            picker: false,
            horizontal: 0,
            page: 10,
            list_area: Rect::default(),
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

/// Wheel scrolls; clicking a row selects it. Returns true when an already-selected row is clicked again.
pub fn handle_mouse(view: &mut ReportView, mouse: MouseEvent) -> bool {
    match mouse.kind {
        MouseEventKind::ScrollDown => view.select(view.selected().saturating_add(3)),
        MouseEventKind::ScrollUp => view.select(view.selected().saturating_sub(3)),
        MouseEventKind::Down(MouseButton::Left)
            if view
                .list_area
                .contains(Position::new(mouse.column, mouse.row)) =>
        {
            let row = view.state.offset() + usize::from(mouse.row - view.list_area.y);
            if row < view.lines.len() {
                let again = row == view.selected();
                view.select(row);
                return again;
            }
        }
        _ => (),
    }
    false
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
    let area = frame.area();
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(if area.height >= 4 { 1 } else { 0 }),
    ])
    .areas(area);
    let theme = Theme::new(view.color);
    theme.header(
        frame,
        header,
        &format!("rigspark / {}", view.title),
        if view.picker { "Select" } else { "Report" },
    );
    let inner = theme.panel(frame, body, if view.picker { "Choices" } else { "Output" });
    view.page = usize::from(inner.height.max(1));
    view.list_area = inner;
    let query = view.query.to_lowercase();
    let items: Vec<_> = view
        .lines
        .iter()
        .map(|line| {
            let visible: String = line.graphemes(true).skip(view.horizontal).collect();
            ListItem::new(Line::from(matched(&visible, &query, theme)))
        })
        .collect();
    frame.render_stateful_widget(
        List::new(items)
            .highlight_symbol("▸ ")
            .highlight_spacing(HighlightSpacing::Always)
            .highlight_style(theme.selection()),
        inner,
        &mut view.state,
    );
    crate::tui_theme::scrollbar(
        frame,
        body,
        view.lines.len(),
        view.state.offset(),
        usize::from(inner.height),
        theme,
    );
    let position = Line::styled(
        format!("{}/{} ", view.selected() + 1, view.lines.len()),
        theme.muted(),
    );
    let left = if view.searching {
        Line::from(vec![
            Span::styled(" /", theme.title()),
            Span::raw(view.query.clone()),
            Span::styled("▌", theme.accent()),
        ])
    } else if view.picker {
        theme.hints(
            &[
                ("Enter", "select"),
                ("↑↓", "move"),
                ("/", "find"),
                ("n", "next"),
                ("q", "cancel"),
            ],
            footer.width.saturating_sub(10),
        )
    } else {
        theme.hints(
            &[
                ("q", "close"),
                ("↑↓", "scroll"),
                ("/", "find"),
                ("n", "next"),
                ("←→", "pan"),
            ],
            footer.width.saturating_sub(10),
        )
    };
    theme.bar(frame, footer, left, position);
}

/// Highlights case-insensitive occurrences of `query`; non-ASCII case folds that change length are left plain.
fn matched(line: &str, query: &str, theme: Theme) -> Vec<Span<'static>> {
    let lower = line.to_lowercase();
    if query.is_empty() || lower.len() != line.len() {
        return vec![Span::raw(line.to_owned())];
    }
    let mut spans = Vec::new();
    let mut cursor = 0;
    for (start, _) in lower.match_indices(query) {
        if start < cursor || !line.is_char_boundary(start) {
            continue;
        }
        spans.push(Span::raw(line[cursor..start].to_owned()));
        spans.push(Span::styled(
            line[start..start + query.len()].to_owned(),
            theme.highlight(),
        ));
        cursor = start + query.len();
    }
    spans.push(Span::raw(line[cursor..].to_owned()));
    spans
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminalResource {
    Raw,
    Alternate,
    Cursor,
    Paste,
    Mouse,
}

const TERMINAL_RESOURCES: [TerminalResource; 5] = [
    TerminalResource::Raw,
    TerminalResource::Alternate,
    TerminalResource::Cursor,
    TerminalResource::Paste,
    TerminalResource::Mouse,
];

/// Mouse capture blocks native text selection, so users can opt out.
pub(crate) fn mouse_enabled() -> bool {
    std::env::var_os("RIGSPARK_NO_MOUSE").is_none_or(|value| value.is_empty())
}

fn set_mouse(enabled: bool) -> io::Result<()> {
    #[cfg(windows)]
    {
        if enabled {
            execute!(io::stderr(), crossterm::event::EnableMouseCapture)
        } else {
            execute!(io::stderr(), crossterm::event::DisableMouseCapture)
        }
    }
    #[cfg(not(windows))]
    {
        use std::io::Write;
        // Press and wheel reports only (SGR encoding); motion tracking would flood redraws.
        let sequence: &[u8] = if enabled {
            b"\x1b[?1000h\x1b[?1006h"
        } else {
            b"\x1b[?1006l\x1b[?1000l"
        };
        let mut stderr = io::stderr();
        stderr.write_all(sequence)?;
        stderr.flush()
    }
}

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
            (TerminalResource::Mouse, true) if mouse_enabled() => set_mouse(true),
            (TerminalResource::Mouse, true) => Ok(()),
            (TerminalResource::Mouse, false) => set_mouse(false),
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

pub(crate) type TerminalBackend = CrosstermBackend<SyncWriter<io::Stderr>>;

pub(crate) fn enter_terminal() -> io::Result<(Terminal<TerminalBackend>, RestoreTerminal)> {
    let restore = RestoreTerminal::acquire(SystemTerminal)?;
    let terminal = Terminal::new(CrosstermBackend::new(SyncWriter::new(io::stderr())))?;
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
        if let Event::Mouse(mouse) = event {
            handle_mouse(&mut view, mouse);
        }
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
    view.picker = true;
    let mut signals = crate::cancellation::TerminalSignals::new()?;
    let (mut terminal, _restore) = enter_terminal()?;
    let mut events = crate::terminal_events::terminal_events();
    loop {
        terminal.draw(|frame| render(frame, &mut view))?;
        let event = tokio::select! {
            code = signals.recv() => return Ok((None, code?)),
            event = next_navigation_event(&mut events) => event?,
        };
        if let Event::Mouse(mouse) = event
            && handle_mouse(&mut view, mouse)
            && !view.searching
        {
            return Ok((Some(view.selected()), 0));
        }
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
        for fail in [Raw, Alternate, Cursor, Paste, Mouse] {
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
            for resource in [Raw, Alternate, Cursor, Paste, Mouse] {
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
        for failed in [Mouse, Paste, Cursor, Alternate, Raw] {
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
            for resource in [Raw, Alternate, Cursor, Paste, Mouse] {
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
