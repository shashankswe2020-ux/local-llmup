use crate::{
    accessible_catalog::CatalogPresentation,
    accessible_installed::{InstalledCommand, InstalledView},
    accessible_read_only::can_run_screen,
    accessible_recommend::Recommendation,
    accessible_text::{identifier, single_line},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};
use rigspark_core::reports::strip_control;
use serde::Deserialize;
use serde_json::Value;
use std::io;
use unicode_segmentation::UnicodeSegmentation;

const MAX_ROWS: usize = 1000;
const MAX_TEXT: usize = 64 * 1024;
const MAX_DOCUMENT: usize = 4 * 1024 * 1024;
const MAX_QUERY: usize = 256;
const MAX_MARKED: usize = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanRunMetadata<'evidence> {
    model_id: &'evidence str,
    runnable: &'evidence str,
    quant: Option<&'evidence str>,
    reason: Option<&'evidence str>,
    throughput_backend: &'evidence str,
    context: Option<f64>,
}

fn bound_can_run(value: &Value, depth: usize, budget: &mut usize) -> io::Result<()> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "can-run view input limit exceeded",
        )
    };
    if depth > 16 {
        return Err(invalid());
    }
    *budget = budget.checked_sub(64).ok_or_else(invalid)?;
    match value {
        Value::String(text) => {
            if text.len() > MAX_TEXT {
                return Err(invalid());
            }
            *budget = budget.checked_sub(text.len()).ok_or_else(invalid)?;
        }
        Value::Array(values) => {
            if values.len() > MAX_ROWS {
                return Err(invalid());
            }
            for value in values {
                bound_can_run(value, depth + 1, budget)?;
            }
        }
        Value::Object(values) => {
            if values.len() > MAX_ROWS {
                return Err(invalid());
            }
            for (key, value) in values {
                if key.len() > MAX_TEXT {
                    return Err(invalid());
                }
                *budget = budget.checked_sub(key.len()).ok_or_else(invalid)?;
                bound_can_run(value, depth + 1, budget)?;
            }
        }
        _ => (),
    }
    Ok(())
}

#[derive(Debug)]
pub struct ModelRow {
    label: String,
    summary: String,
    search: String,
    evidence: String,
}

fn bounded_text(value: &str, limit: usize) -> io::Result<String> {
    if value.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "model view text limit exceeded",
        ));
    }
    Ok(strip_control(value)
        .chars()
        .filter(|character| !character.is_control())
        .collect())
}

impl ModelRow {
    pub fn new(label: &str, search: &str, evidence: &str) -> io::Result<Self> {
        Ok(Self {
            label: bounded_text(label, 1024)?,
            summary: String::new(),
            search: bounded_text(search, MAX_TEXT)?.to_lowercase(),
            evidence: bounded_evidence(evidence)?,
        })
    }

    pub fn label(&self) -> &str {
        &self.label
    }
}

fn bounded_evidence(value: &str) -> io::Result<String> {
    if value.len() > MAX_TEXT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "model view text limit exceeded",
        ));
    }
    value
        .lines()
        .map(|line| bounded_text(line, MAX_TEXT))
        .collect::<io::Result<Vec<_>>>()
        .map(|lines| lines.join("\n"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum ModelOutcome {
    Exit { code: u8 },
    PrintCommand { command: String },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    List,
    Detail,
    Overview,
    Help,
    Compare,
}

pub struct ModelView {
    title: String,
    overview: Vec<String>,
    rows: Vec<ModelRow>,
    visible: Vec<usize>,
    list: ListState,
    query: String,
    searching: bool,
    focus: Focus,
    help_return: Option<(Focus, usize, usize)>,
    marked: Vec<usize>,
    notice: Option<&'static str>,
    scroll: usize,
    scroll_max: usize,
    page: usize,
    detail_page: usize,
    color: bool,
    command: Option<String>,
    comparison: bool,
}

impl ModelView {
    pub fn new(
        title: &str,
        overview: Vec<String>,
        rows: Vec<ModelRow>,
        color: bool,
    ) -> io::Result<Self> {
        if rows.len() > MAX_ROWS || overview.len() > MAX_ROWS + 8 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "model view row limit exceeded",
            ));
        }
        let bytes = rows
            .iter()
            .map(|row| row.label.len() + row.summary.len() + row.search.len() + row.evidence.len())
            .sum::<usize>()
            + overview.iter().map(String::len).sum::<usize>();
        if bytes > MAX_DOCUMENT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "model view document limit exceeded",
            ));
        }
        let overview = overview
            .iter()
            .map(|line| bounded_text(line, MAX_TEXT))
            .collect::<io::Result<_>>()?;
        let selection = if rows.is_empty() { None } else { Some(0) };
        Ok(Self {
            title: bounded_text(title, 256)?,
            overview,
            visible: (0..rows.len()).collect(),
            rows,
            list: ListState::default().with_selected(selection),
            query: String::new(),
            searching: false,
            focus: Focus::List,
            help_return: None,
            marked: Vec::new(),
            notice: None,
            scroll: 0,
            scroll_max: 0,
            page: 1,
            detail_page: 1,
            color,
            command: None,
            comparison: true,
        })
    }

    pub fn from_catalog(presentation: &CatalogPresentation, color: bool) -> io::Result<Self> {
        Self::new(
            "Catalog",
            presentation.visual_overview(),
            adapt_rows(presentation.visual_rows())?,
            color,
        )
    }

    pub fn from_recommendation(presentation: &Recommendation, color: bool) -> io::Result<Self> {
        let mut view = Self::new(
            "Recommend",
            presentation.visual_overview(),
            adapt_rows(presentation.visual_rows())?,
            color,
        )?;
        view.command = presentation.print_command().map(str::to_owned);
        Ok(view)
    }

    pub fn from_installed(presentation: &InstalledView, color: bool) -> io::Result<Self> {
        let title = match presentation.command() {
            InstalledCommand::Recommend => "Recommend / Installed",
            InstalledCommand::CanRun => "Can Run / Installed",
        };
        let rows = presentation
            .visual_rows()
            .map(|(label, fit, search, evidence)| {
                let mut row = ModelRow::new(label, search, evidence)?;
                row.summary = format!("Fit: {fit}");
                Ok(row)
            })
            .collect::<io::Result<Vec<_>>>()?;
        let mut view = Self::new(title, presentation.visual_overview(), rows, color)?;
        view.comparison =
            presentation.command() == InstalledCommand::Recommend && view.rows.len() >= 2;
        if view.rows.is_empty() {
            view.focus(Focus::Overview);
        } else if presentation.command() == InstalledCommand::CanRun {
            view.focus(Focus::Detail);
        }
        Ok(view)
    }

    pub fn from_can_run(evidence: &Value, color: bool) -> io::Result<Self> {
        let mut budget = MAX_DOCUMENT;
        bound_can_run(evidence, 0, &mut budget)?;
        let screen = can_run_screen(evidence)?;
        let metadata = CanRunMetadata::deserialize(evidence).map_err(io::Error::other)?;
        if metadata.model_id.len() > 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "model view text limit exceeded",
            ));
        }
        let label = identifier(metadata.model_id)?;
        let summary = single_line(&format!(
            "Verdict: {}; quant {}; reason {}",
            metadata.runnable,
            metadata.quant.unwrap_or("unknown"),
            metadata.reason.unwrap_or("none"),
        ))?;
        let search = single_line(&format!(
            "{} {} {}",
            metadata.model_id, summary, metadata.throughput_backend,
        ))?;
        let mut row = ModelRow::new(&label, &search, &screen)?;
        row.summary = bounded_text(&summary, 2048)?;
        let context = metadata.context.map_or_else(
            || "Requested context: not specified".into(),
            |context| format!("Requested context: {context} tokens"),
        );
        let mut view = Self::new(
            "Can Run",
            vec![
                format!("Verdict: {} / offline evidence", metadata.runnable),
                context,
            ],
            vec![row],
            color,
        )?;
        view.comparison = false;
        view.focus(Focus::Detail);
        Ok(view)
    }

    pub fn selected(&self) -> Option<&ModelRow> {
        self.list
            .selected()
            .and_then(|index| self.visible.get(index))
            .map(|index| &self.rows[*index])
    }

    pub fn visible_count(&self) -> usize {
        self.visible.len()
    }

    pub fn detail_focused(&self) -> bool {
        self.focus == Focus::Detail
    }

    fn filter(&mut self) {
        let selected = self
            .list
            .selected()
            .and_then(|index| self.visible.get(index))
            .copied();
        let needle = self.query.to_lowercase();
        self.visible = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.search.contains(&needle))
            .map(|(index, _)| index)
            .collect();
        let position = selected
            .and_then(|selected| self.visible.iter().position(|index| *index == selected))
            .or_else(|| (!self.visible.is_empty()).then_some(0));
        self.list.select(position);
        *self.list.offset_mut() = 0;
        self.scroll = 0;
    }

    fn move_to(&mut self, position: usize) {
        if self.focus != Focus::List {
            self.scroll = position.min(self.scroll_max);
        } else if !self.visible.is_empty() {
            self.list.select(Some(position.min(self.visible.len() - 1)));
            self.scroll = 0;
        }
    }

    fn focus(&mut self, focus: Focus) {
        self.focus = focus;
        self.scroll = 0;
        self.scroll_max = 0;
    }

    fn append_query(&mut self, text: &str) {
        let available = MAX_QUERY.saturating_sub(self.query.len());
        let mut bytes = 0;
        let prefix: String = text
            .chars()
            .take_while(|character| {
                bytes += character.len_utf8();
                bytes <= available
            })
            .collect();
        let clean = strip_control(&prefix);
        self.query
            .extend(clean.chars().filter(|character| !character.is_control()));
        self.filter();
    }

    fn toggle_help(&mut self) {
        if let Some((focus, scroll, scroll_max)) = self.help_return.take() {
            self.focus = focus;
            self.scroll = scroll;
            self.scroll_max = scroll_max;
        } else {
            self.help_return = Some((self.focus, self.scroll, self.scroll_max));
            self.focus(Focus::Help);
        }
    }

    fn toggle_mark(&mut self) {
        let Some(index) = self
            .list
            .selected()
            .and_then(|index| self.visible.get(index))
            .copied()
        else {
            self.notice = Some("No model selected to mark");
            return;
        };
        if let Some(position) = self.marked.iter().position(|marked| *marked == index) {
            self.marked.remove(position);
            self.notice = None;
        } else if self.marked.len() == MAX_MARKED {
            self.notice = Some("Mark limit 4: unmark a model with Space");
        } else {
            self.marked.push(index);
            self.notice = None;
        }
    }
}

fn adapt_rows<'row>(
    rows: impl Iterator<Item = (&'row str, &'row str, &'row str, &'row str)>,
) -> io::Result<Vec<ModelRow>> {
    rows.map(|(label, summary, search, evidence)| {
        let mut row = ModelRow::new(label, search, evidence)?;
        row.summary = bounded_text(summary, 2048)?;
        Ok(row)
    })
    .collect()
}

pub fn handle_key(view: &mut ModelView, key: KeyEvent) -> Option<ModelOutcome> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char('c') => return Some(ModelOutcome::Exit { code: 130 }),
            KeyCode::Char('u') if view.focus != Focus::Help => {
                view.query.clear();
                view.filter();
            }
            _ => (),
        }
        return None;
    }
    if key
        .modifiers
        .intersects(KeyModifiers::ALT | KeyModifiers::SUPER)
    {
        return None;
    }
    if view.searching {
        match key.code {
            KeyCode::Esc | KeyCode::Enter => view.searching = false,
            KeyCode::Backspace | KeyCode::Delete => {
                if let Some((index, _)) = view.query.grapheme_indices(true).next_back() {
                    view.query.truncate(index);
                }
                view.filter();
            }
            KeyCode::Char(character) if !character.is_control() => {
                view.append_query(&character.to_string())
            }
            _ => (),
        }
        return None;
    }
    if view.focus == Focus::Help {
        match key.code {
            KeyCode::Esc | KeyCode::Left | KeyCode::Backspace => {
                view.toggle_help();
                return None;
            }
            KeyCode::Char('?' | 'q' | 'j' | 'k' | 'p')
            | KeyCode::Up
            | KeyCode::Down
            | KeyCode::PageUp
            | KeyCode::PageDown
            | KeyCode::Home
            | KeyCode::End => (),
            _ => return None,
        }
    }
    let position = if view.focus == Focus::List {
        view.list.selected().unwrap_or(0)
    } else {
        view.scroll
    };
    let page = if view.focus == Focus::List {
        view.page
    } else {
        view.detail_page
    };
    match key.code {
        KeyCode::Char('q') => return Some(ModelOutcome::Exit { code: 0 }),
        KeyCode::Char('?') if key.kind == KeyEventKind::Press => view.toggle_help(),
        KeyCode::Char(' ')
            if key.kind == KeyEventKind::Press
                && view.comparison
                && matches!(view.focus, Focus::List | Focus::Detail) =>
        {
            view.toggle_mark()
        }
        KeyCode::Char('c') if key.kind == KeyEventKind::Press && view.comparison => {
            if view.focus == Focus::Compare {
                view.focus(Focus::List);
            } else if view.marked.len() < 2 {
                view.notice = Some("Mark at least 2 models with Space to compare (max 4)");
            } else {
                view.notice = None;
                view.focus(Focus::Compare);
            }
        }
        KeyCode::Esc if view.focus == Focus::List => return Some(ModelOutcome::Exit { code: 0 }),
        KeyCode::Esc | KeyCode::Left | KeyCode::Backspace => view.focus(Focus::List),
        KeyCode::Enter | KeyCode::Tab | KeyCode::BackTab => {
            if view.focus == Focus::List && view.selected().is_some() {
                view.focus(Focus::Detail);
            } else {
                view.focus(Focus::List);
            }
        }
        KeyCode::Right if view.selected().is_some() => view.focus(Focus::Detail),
        KeyCode::Char('i') => view.focus(if view.focus == Focus::Overview {
            Focus::List
        } else {
            Focus::Overview
        }),
        KeyCode::Char('/') => {
            view.searching = true;
            view.focus(Focus::List);
        }
        KeyCode::Down | KeyCode::Char('j') => view.move_to(position.saturating_add(1)),
        KeyCode::Up | KeyCode::Char('k') => view.move_to(position.saturating_sub(1)),
        KeyCode::PageDown => view.move_to(position.saturating_add(page)),
        KeyCode::PageUp => view.move_to(position.saturating_sub(page)),
        KeyCode::Home => view.move_to(0),
        KeyCode::End => view.move_to(usize::MAX),
        KeyCode::Char('p') if key.kind == KeyEventKind::Press => {
            return view
                .command
                .as_ref()
                .map(|command| ModelOutcome::PrintCommand {
                    command: command.clone(),
                });
        }
        _ => (),
    }
    None
}

pub fn handle_event(view: &mut ModelView, event: Event) -> Option<ModelOutcome> {
    match event {
        Event::Key(key) => handle_key(view, key),
        Event::Paste(text) if view.searching => {
            view.append_query(&text);
            None
        }
        _ => None,
    }
}

fn wrap_lines<'line>(lines: impl Iterator<Item = &'line str>, width: u16) -> Vec<String> {
    let width = usize::from(width.max(1));
    let mut result = Vec::new();
    for line in lines {
        let mut chunk = String::new();
        let mut used = 0;
        for grapheme in line.graphemes(true) {
            let cells = Span::raw(grapheme).width();
            if used + cells > width && !chunk.is_empty() {
                result.push(std::mem::take(&mut chunk));
                used = 0;
            }
            if cells > width {
                chunk.push('?');
                used += 1;
            } else {
                chunk.push_str(grapheme);
                used += cells;
            }
        }
        result.push(chunk);
    }
    result
}

fn render_detail(frame: &mut Frame<'_>, view: &mut ModelView, area: Rect, accent: Style) {
    let title = match view.focus {
        Focus::Overview => "Machine / scope".to_owned(),
        Focus::Help => "Keyboard help".to_owned(),
        Focus::Compare => format!("Compare {} models", view.marked.len()),
        _ => "Evidence".to_owned(),
    };
    let block = Block::default()
        .borders(Borders::TOP)
        .title(title)
        .border_style(accent);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = if view.focus == Focus::Help {
        let mut help = vec![
            "Up/Down or j/k: navigate list or scroll screen",
            "PageUp/PageDown: page; Home/End: first/last",
            "/: search; Enter/Esc: close search; Ctrl+U: reset filter",
            "Enter/Right/Tab: details; Left/Backspace/Esc: back",
            "i: machine/scope; ?: toggle help",
            "Esc: back from screen; Esc on list or q: quit",
            "Ctrl+C: interrupt (exit 130)",
            "Read-only: stored evidence only; no actions execute",
        ];
        if view.comparison {
            help.extend([
                "Space: mark/unmark selected model (max 4)",
                "c: compare 2-4 marked models / return to list",
                "Marks survive filtering; * identifies a marked model",
            ]);
        }
        if view.command.is_some() {
            help.push("p: finish and print existing top-pick command; never execute");
        }
        wrap_lines(help.into_iter(), inner.width)
    } else if view.focus == Focus::Compare {
        wrap_lines(
            view.marked.iter().flat_map(|index| {
                let row = &view.rows[*index];
                std::iter::once(row.label.as_str())
                    .chain(
                        std::iter::once(row.summary.as_str()).filter(|summary| !summary.is_empty()),
                    )
                    .chain(row.evidence.lines().flat_map(|line| line.split("; ")))
                    .chain(std::iter::once(""))
            }),
            inner.width,
        )
    } else if view.focus == Focus::Overview {
        wrap_lines(view.overview.iter().map(String::as_str), inner.width)
    } else if let Some(row) = view.selected() {
        wrap_lines(
            row.evidence.lines().flat_map(|line| line.split("; ")),
            inner.width,
        )
    } else {
        vec!["No model selected".into()]
    };
    view.detail_page = usize::from(inner.height.max(1));
    view.scroll_max = lines.len().saturating_sub(view.detail_page);
    view.scroll = view.scroll.min(view.scroll_max);
    let visible: Vec<_> = lines
        .into_iter()
        .skip(view.scroll)
        .take(view.detail_page)
        .map(Line::from)
        .collect();
    frame.render_widget(Paragraph::new(visible), inner);
}

pub fn render(frame: &mut Frame<'_>, view: &mut ModelView) {
    let area = frame.area();
    if area.is_empty() {
        return;
    }
    let accent = if view.color {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default()
    };
    let [header, context, body, search, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(if area.height >= 12 { 2 } else { 0 }),
        Constraint::Min(0),
        Constraint::Length(if area.height >= 3 { 1 } else { 0 }),
        Constraint::Length(if area.height >= 2 { 1 } else { 0 }),
    ])
    .areas(area);
    frame.render_widget(
        Paragraph::new(format!("rigspark / {} / Read-only", view.title))
            .style(accent.add_modifier(Modifier::BOLD)),
        header,
    );
    let overview: Vec<_> = view
        .overview
        .iter()
        .take(2)
        .map(|line| Line::from(line.as_str()))
        .collect();
    frame.render_widget(Paragraph::new(overview), context);
    if view.focus != Focus::List {
        render_detail(frame, view, body, accent.add_modifier(Modifier::BOLD));
    } else {
        let (list_area, detail_area) = if body.width >= 80 {
            let [list, detail] =
                Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)])
                    .areas(body);
            (list, Some(detail))
        } else if body.height >= 10 {
            let [list, detail] =
                Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)])
                    .areas(body);
            (list, Some(detail))
        } else {
            (body, None)
        };
        let block = Block::default()
            .borders(Borders::TOP)
            .title(format!(
                "Models ({}/{})",
                view.visible_count(),
                view.rows.len()
            ))
            .border_style(accent);
        let inner = block.inner(list_area);
        frame.render_widget(block, list_area);
        let summaries = inner.height >= 4;
        view.page = (usize::from(inner.height) / if summaries { 2 } else { 1 }).max(1);
        let items: Vec<_> = view
            .visible
            .iter()
            .map(|index| {
                let row = &view.rows[*index];
                let marker = if view.marked.contains(index) {
                    "* "
                } else {
                    "  "
                };
                let mut lines = vec![Line::from(format!("{marker}{}", row.label()))];
                if summaries {
                    lines.push(Line::from(row.summary.as_str()));
                }
                ListItem::new(lines)
            })
            .collect();
        if items.is_empty() {
            frame.render_widget(Paragraph::new("No results"), inner);
        } else {
            frame.render_stateful_widget(
                List::new(items)
                    .highlight_symbol("> ")
                    .highlight_style(accent.add_modifier(Modifier::REVERSED)),
                inner,
                &mut view.list,
            );
        }
        if let Some(detail) = detail_area {
            render_detail(frame, view, detail, accent);
        }
    }
    let query = if view.query.is_empty() {
        "off"
    } else {
        &view.query
    };
    let mut status = if view.searching {
        format!("/{}|", view.query)
    } else if let Some(notice) = view.notice {
        notice.to_owned()
    } else if view.focus == Focus::List {
        format!(
            "{}/{}  Search: {query}",
            view.list.selected().map_or(0, |index| index + 1),
            view.visible_count()
        )
    } else {
        format!(
            "Line {}/{}  Search: {query}",
            view.scroll + 1,
            view.scroll_max + 1
        )
    };
    if !view.searching && view.comparison {
        status.push_str(&format!("  Marked {}/{MAX_MARKED}", view.marked.len()));
    }
    frame.render_widget(Paragraph::new(status), search);
    let controls = if view.searching {
        "Enter/Esc close | Ctrl+U reset"
    } else if view.focus != Focus::List {
        "Esc back | Up/Down scroll | Home/End | ? help | q quit"
    } else if view.command.is_some() {
        "q quit | / search | Enter detail | Space mark | c compare | ? help | p finish/print"
    } else if !view.comparison {
        "q quit | / search | Enter detail | i overview | ? help"
    } else {
        "q quit | / search | Enter detail | Space mark | c compare | ? help"
    };
    frame.render_widget(Paragraph::new(controls), footer);
}

pub async fn show_models(mut view: ModelView) -> io::Result<ModelOutcome> {
    let mut signals = crate::cancellation::TerminalSignals::new()?;
    let (mut terminal, _restore) = crate::tui_view::enter_terminal()?;
    let mut events = crate::terminal_events::terminal_events();
    loop {
        terminal.draw(|frame| render(frame, &mut view))?;
        let event = tokio::select! {
            code = signals.recv() => return Ok(ModelOutcome::Exit { code: code? }),
            event = crate::tui_view::next_navigation_event(&mut events) => event?,
        };
        if let Some(outcome) = handle_event(&mut view, event) {
            return Ok(outcome);
        }
    }
}
