use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use futures_util::{Stream, StreamExt, stream};
use llmup_core::reports::strip_control;
use llmup_runtime::{
    adapters::BackendError,
    application::events::{
        DiagnosticObserver, DiagnosticSnapshot, EVENT_CAPACITY, LifecycleEvent, LifecycleScope,
        LifecycleStage, LifecycleStatus,
    },
};
use ratatui::{
    Frame, Terminal,
    backend::Backend,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    widgets::{Paragraph, Wrap},
};
use serde_json::Value;
use std::{
    collections::VecDeque,
    future::Future,
    io::{self, Write},
    time::Duration,
};
use tokio::sync::mpsc::Receiver;
use tokio_util::sync::CancellationToken;

type RuntimeResult = Result<(Value, String), BackendError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Running,
    Event(LifecycleEvent),
    Redraw(i16),
    Cancelling,
    Restore,
    Completed,
    Failed,
}

enum Control {
    Cancel(u8),
    Redraw(i16),
    Resize { eligible: bool },
}

pub struct Outcome {
    pub result: RuntimeResult,
    pub exit_code: u8,
    pub presentation_error: Option<String>,
    pub presentation_restored: bool,
    pub diagnostics: Option<DiagnosticSnapshot>,
}

async fn drive(
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    controls: impl Stream<Item = io::Result<Control>>,
    events: Option<Receiver<LifecycleEvent>>,
    present: impl FnMut(Phase) -> io::Result<()>,
) -> io::Result<Outcome> {
    drive_with_redraw(
        operation,
        cancel,
        controls,
        events,
        present,
        stream::pending(),
    )
    .await
}

async fn drive_with_redraw(
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    controls: impl Stream<Item = io::Result<Control>>,
    events: Option<Receiver<LifecycleEvent>>,
    present: impl FnMut(Phase) -> io::Result<()>,
    redraw: impl Stream<Item = ()>,
) -> io::Result<Outcome> {
    drive_with_deadline(
        operation,
        cancel,
        controls,
        events,
        present,
        redraw,
        Duration::from_millis(crate::cancellation::CLEANUP_TIMEOUT_MS),
    )
    .await
}

async fn drive_with_deadline(
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    controls: impl Stream<Item = io::Result<Control>>,
    mut events: Option<Receiver<LifecycleEvent>>,
    mut present: impl FnMut(Phase) -> io::Result<()>,
    redraw: impl Stream<Item = ()>,
    cleanup_timeout: Duration,
) -> io::Result<Outcome> {
    present(Phase::Running)?;
    let deadline = async {
        cancel.cancelled().await;
        tokio::time::sleep(cleanup_timeout).await;
    };
    tokio::pin!(deadline);
    tokio::pin!(operation, controls, redraw);
    let mut exit_code = 0;
    let mut presentation_error = None;
    let mut controls_done = false;
    let mut output_failed = false;
    let mut restored = false;
    let mut resize_deadline = None;
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut deadline, if !restored => {
                restored = true;
                if let Err(error) = present(Phase::Restore) {
                    presentation_error.get_or_insert_with(|| error.to_string());
                }
                output_failed = true;
            }
            _ = async {
                if let Some(deadline) = resize_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else { std::future::pending::<()>().await; }
            }, if !restored && !cancel.is_cancelled() => {
                restored = true;
                resize_deadline = None;
                if let Err(error) = present(Phase::Restore) {
                    presentation_error.get_or_insert_with(|| error.to_string());
                }
                output_failed = true;
            }
            control = controls.next(), if !controls_done => {
                if let Some(Ok(Control::Resize { eligible })) = control {
                    if !restored {
                        resize_deadline = (!eligible).then(||
                            tokio::time::Instant::now() + Duration::from_millis(50));
                    }
                    continue;
                }
                if let Some(Ok(Control::Redraw(scroll))) = control {
                    if !output_failed && let Err(error) = present(Phase::Redraw(scroll)) {
                        output_failed = true;
                        presentation_error.get_or_insert_with(|| error.to_string());
                        exit_code = 1;
                        cancel.cancel();
                    }
                    continue;
                }
                controls_done = true;
                match control {
                    Some(Ok(Control::Cancel(code))) => exit_code = code,
                    failure => {
                        exit_code = 1;
                        presentation_error.get_or_insert_with(|| match failure {
                            Some(Err(error)) => error.to_string(),
                            _ => "lifecycle control input ended".into(),
                        });
                    }
                }
                cancel.cancel();
                if !output_failed && let Err(error) = present(Phase::Cancelling) {
                    output_failed = true;
                    presentation_error.get_or_insert_with(|| error.to_string());
                }
            }
            result = &mut operation => break result,
            event = async {
                match &mut events {
                    Some(receiver) => receiver.recv().await,
                    None => std::future::pending().await,
                }
            }, if events.is_some() => {
                match event {
                    Some(event) if !output_failed => {
                        if let Err(error) = present(Phase::Event(event)) {
                            output_failed = true;
                            presentation_error.get_or_insert_with(|| error.to_string());
                            if exit_code == 0 {
                                exit_code = 1;
                            }
                            cancel.cancel();
                        }
                    }
                    Some(_) => (),
                    None => events = None,
                }
            }
            Some(()) = redraw.next(), if !output_failed => {
                if let Err(error) = present(Phase::Redraw(0)) {
                    output_failed = true;
                    presentation_error.get_or_insert_with(|| error.to_string());
                    if exit_code == 0 { exit_code = 1; }
                    cancel.cancel();
                }
            }
        }
    };
    if let Some(receiver) = &mut events {
        receiver.close();
        while let Ok(event) = receiver.try_recv() {
            if !output_failed && let Err(error) = present(Phase::Event(event)) {
                output_failed = true;
                presentation_error.get_or_insert_with(|| error.to_string());
                cancel.cancel();
            }
        }
    }
    if presentation_error.is_some() && exit_code == 0 {
        exit_code = 1;
    }
    if result.is_err() && exit_code == 0 {
        exit_code = 1;
    }
    if !output_failed
        && let Err(error) = present(if result.is_ok() {
            Phase::Completed
        } else {
            Phase::Failed
        })
    {
        presentation_error.get_or_insert_with(|| error.to_string());
        if exit_code == 0 {
            exit_code = 1;
        }
    }
    Ok(Outcome {
        result,
        exit_code,
        presentation_error,
        presentation_restored: restored,
        diagnostics: None,
    })
}

pub async fn interruption() -> io::Result<u8> {
    crate::cancellation::TerminalSignals::new()?.recv().await
}

pub async fn run(
    command: &str,
    target: &str,
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    interactive: bool,
) -> io::Result<Outcome> {
    run_observed(command, target, operation, cancel, interactive, None).await
}

pub async fn run_observed(
    command: &str,
    target: &str,
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    interactive: bool,
    events: Option<Receiver<LifecycleEvent>>,
) -> io::Result<Outcome> {
    let mut signals = crate::cancellation::TerminalSignals::new()?;
    let controls = stream::once(async { signals.recv().await.map(Control::Cancel) });
    let sizes = resize_controls(interactive);
    let mut output = io::stderr();
    drive(
        operation,
        cancel,
        stream::select(controls, sizes),
        events,
        |phase| {
            if !interactive {
                return Ok(());
            }
            write_phase(&mut output, command, target, phase)
        },
    )
    .await
}

pub async fn run_visual(
    command: &str,
    target: &str,
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    color: bool,
    events: Receiver<LifecycleEvent>,
    diagnostics: DiagnosticObserver,
) -> io::Result<Outcome> {
    let mut terminal_signals = crate::cancellation::TerminalSignals::new()?;
    let (mut terminal, restore) = crate::tui_view::enter_terminal()?;
    let mut restore = Some(restore);
    let mut view = LifecycleView::new(command, target, color);
    let input_owner = std::sync::Arc::new(std::sync::Mutex::new(Some(
        crate::terminal_events::terminal_events(),
    )));
    let input = visual_input(input_owner.clone());
    let signals = stream::once(async { terminal_signals.recv().await.map(Control::Cancel) });
    drive_visual(
        (&mut terminal, || {
            input_owner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            drop(restore.take());
        }),
        &mut view,
        operation,
        cancel,
        stream::select(signals, input),
        events,
        &diagnostics,
    )
    .await
}

fn visual_input<Events>(
    owner: std::sync::Arc<std::sync::Mutex<Option<Events>>>,
) -> impl Stream<Item = io::Result<Control>>
where
    Events: Stream<Item = io::Result<Event>> + Unpin,
{
    stream::poll_fn(move |context| {
        let mut owner = owner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(events) = owner.as_mut() else {
            return std::task::Poll::Ready(None);
        };
        match std::pin::Pin::new(events).poll_next(context) {
            std::task::Poll::Ready(Some(event)) => {
                std::task::Poll::Ready(Some(event.map(visual_control)))
            }
            std::task::Poll::Ready(None) => {
                owner.take();
                std::task::Poll::Ready(Some(Err(io::Error::other("terminal input ended"))))
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    })
}

fn resize_control(columns: u16, rows: u16, accessible: bool) -> Control {
    let (minimum_columns, minimum_rows) = if accessible { (40, 10) } else { (60, 16) };
    Control::Resize {
        eligible: columns >= minimum_columns && rows >= minimum_rows,
    }
}

fn resize_controls(enabled: bool) -> impl Stream<Item = io::Result<Control>> {
    let timer = tokio::time::interval(Duration::from_millis(50));
    stream::unfold((timer, None), move |(mut timer, mut previous)| async move {
        if !enabled {
            return std::future::pending().await;
        }
        loop {
            timer.tick().await;
            let size = crossterm::terminal::size().unwrap_or((0, 0));
            if previous != Some(size) {
                previous = Some(size);
                return Some((Ok(resize_control(size.0, size.1, true)), (timer, previous)));
            }
        }
    })
}

fn visual_control(event: Event) -> Control {
    if let Event::Resize(columns, rows) = event {
        return resize_control(columns, rows, false);
    }
    if let Event::Key(key) = event
        && key.kind != KeyEventKind::Release
    {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Control::Cancel(130);
        }
        return match key.code {
            KeyCode::Esc | KeyCode::Char('q') => Control::Cancel(130),
            KeyCode::Up => Control::Redraw(-1),
            KeyCode::Down => Control::Redraw(1),
            KeyCode::PageUp => Control::Redraw(-10),
            KeyCode::PageDown => Control::Redraw(10),
            _ => Control::Redraw(0),
        };
    }
    Control::Redraw(0)
}

async fn drive_visual<B: Backend>(
    terminal: (&mut Terminal<B>, impl FnMut()),
    view: &mut LifecycleView,
    operation: impl Future<Output = RuntimeResult>,
    cancel: &CancellationToken,
    controls: impl Stream<Item = io::Result<Control>>,
    events: Receiver<LifecycleEvent>,
    diagnostics: &DiagnosticObserver,
) -> io::Result<Outcome> {
    let (terminal, mut restore) = terminal;
    let period = Duration::from_millis(100);
    let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let redraw = stream::unfold(timer, |mut timer| async {
        timer.tick().await;
        Some(((), timer))
    });
    let mut outcome = drive_with_redraw(
        operation,
        cancel,
        controls,
        Some(events),
        |phase| {
            if phase == Phase::Restore {
                restore();
                return Ok(());
            }
            view.update(phase);
            terminal
                .draw(|frame| view.render(frame, &diagnostics.snapshot()))
                .map(|_| ())
                .map_err(|error| io::Error::other(error.to_string()))
        },
        redraw,
    )
    .await?;
    outcome.diagnostics = Some(diagnostics.snapshot());
    Ok(outcome)
}

struct LifecycleView {
    title: String,
    phase: Phase,
    history: VecDeque<LifecycleEvent>,
    omitted_events: usize,
    scroll: u16,
    color: bool,
}

impl LifecycleView {
    fn new(command: &str, target: &str, color: bool) -> Self {
        let label = |text: &str| {
            strip_control(&text.chars().take(1024).collect::<String>())
                .chars()
                .take(256)
                .collect::<String>()
        };
        Self {
            title: format!("{} / {}", label(command), label(target)),
            phase: Phase::Running,
            history: VecDeque::new(),
            omitted_events: 0,
            scroll: 0,
            color,
        }
    }

    fn update(&mut self, phase: Phase) {
        match phase {
            Phase::Event(event) => {
                if self.history.len() == EVENT_CAPACITY {
                    self.history.pop_front();
                    self.omitted_events = self.omitted_events.saturating_add(1);
                }
                self.history.push_back(event);
            }
            Phase::Redraw(scroll) => self.scroll = self.scroll.saturating_add_signed(scroll),
            phase => self.phase = phase,
        }
    }

    fn render(&mut self, frame: &mut Frame<'_>, diagnostics: &DiagnosticSnapshot) {
        let [header, status, current, body, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Length(2),
            Constraint::Min(0),
            Constraint::Length(2),
        ])
        .areas(frame.area());
        let accent = if self.color {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default()
        };
        frame.render_widget(
            Paragraph::new(self.title.as_str()).style(accent.add_modifier(Modifier::BOLD)),
            header,
        );
        let status_text = match self.phase {
            Phase::Cancelling => {
                "Cancellation requested. Waiting for runtime cleanup; effects not yet known."
            }
            Phase::Completed => "Runtime returned success. Final evidence follows.",
            Phase::Failed => "Runtime returned an error. Cleanup success is not confirmed.",
            _ => "Running. Observed stages are best-effort and may be incomplete.",
        };
        frame.render_widget(
            Paragraph::new(status_text).wrap(Wrap { trim: false }),
            status,
        );
        let latest = self
            .history
            .back()
            .copied()
            .map(event_text)
            .unwrap_or_else(|| "No stage observed yet.".into());
        frame.render_widget(Paragraph::new(latest).wrap(Wrap { trim: false }), current);
        let mut text = diagnostics.text();
        if self.omitted_events > 0 {
            text.push_str(&format!(
                "{} earlier stage observations omitted\n",
                self.omitted_events
            ));
        }
        text.push_str("Observed stages (newest first):\n");
        for event in self.history.iter().rev() {
            text.push_str(&event_text(*event));
            text.push('\n');
        }
        let lines: Vec<_> = text
            .lines()
            .flat_map(|line| {
                line.as_bytes()
                    .chunks(usize::from(body.width.max(1)))
                    .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            })
            .collect();
        let maximum = lines.len().saturating_sub(usize::from(body.height));
        self.scroll = self.scroll.min(u16::try_from(maximum).unwrap_or(u16::MAX));
        frame.render_widget(
            Paragraph::new(lines.join("\n")).scroll((self.scroll, 0)),
            body,
        );
        frame.render_widget(Paragraph::new("Final result is authoritative, not stage completion.\nCtrl-C / Esc / q cancel; Up/Down scroll").style(accent), footer);
    }
}

fn event_text(event: LifecycleEvent) -> String {
    let scope = match event.scope {
        LifecycleScope::Runtime => "Runtime",
        LifecycleScope::AcquisitionDaemon => "Acquisition daemon",
    };
    let stage = match event.stage {
        LifecycleStage::Acquisition => "Acquisition",
        LifecycleStage::Verification => "Verification",
        LifecycleStage::AcquisitionVerification => "Acquisition and verification",
        LifecycleStage::Start => "Start/serve (may reuse a server)",
        LifecycleStage::Attach => "Attach",
        LifecycleStage::Activation => "Activation",
        LifecycleStage::Readiness => "Readiness",
        LifecycleStage::Stop => "Stop",
    };
    let status = match event.status {
        LifecycleStatus::Started => "started",
        LifecycleStatus::Completed => "completed",
        LifecycleStatus::Failed => "failed",
    };
    format!("{scope} / {stage}: {status}")
}

fn write_phase(
    output: &mut impl Write,
    command: &str,
    target: &str,
    phase: Phase,
) -> io::Result<()> {
    match phase {
        Phase::Running => writeln!(
            output,
            "{} / {}\nRunning. Observed stages are best-effort and may be incomplete.\nStage completion does not confirm command success or saved state; the final result is authoritative.\nCtrl-C cancels and waits for runtime cleanup.",
            strip_control(command),
            strip_control(target)
        ),
        Phase::Event(event) => writeln!(output, "{}", event_text(event)),
        Phase::Redraw(_) => return Ok(()),
        Phase::Cancelling => writeln!(
            output,
            "Cancellation requested. Waiting for the runtime to return; effects are not yet known."
        ),
        Phase::Restore => writeln!(
            output,
            "Terminal presentation ended; waiting for the runtime result."
        ),
        Phase::Completed => writeln!(output, "Runtime returned success. Final evidence follows."),
        Phase::Failed => writeln!(output, "Runtime returned an error. Final evidence follows."),
    }?;
    output.flush()
}

pub fn evidence(outcome: &Outcome) -> String {
    let mut text = match &outcome.result {
        Ok((report, text)) => {
            let mut lines: Vec<_> = text.lines().map(strip_control).collect();
            for (field, label) in [
                ("type", "Result"),
                ("backend", "Backend"),
                ("endpoint", "Endpoint"),
                ("ownership", "Ownership"),
                ("integrity", "Integrity"),
            ] {
                if let Some(value) = report.get(field).and_then(Value::as_str) {
                    lines.push(format!("{label}: {}", strip_control(value)));
                }
            }
            format!("{}\n", lines.join("\n"))
        }
        Err(error) => format!(
            "Runtime error: {}\nEffects are unknown; rollback or cleanup success is not confirmed.\nInspect `llmup-native ls` and `llmup-native doctor` before deciding whether to retry.\nNo automatic retry or bypass was performed.\n",
            strip_control(&error.to_string()),
        ),
    };
    if [129, 130, 143].contains(&outcome.exit_code) {
        text.push_str("\nCancellation was requested; the runtime result above is authoritative.\n");
    }
    if let Some(error) = &outcome.presentation_error {
        text.push_str(&format!("\nPresentation error: {}\n", strip_control(error)));
    }
    if let Some(diagnostics) = &outcome.diagnostics {
        let diagnostics = diagnostics.text();
        if !diagnostics.is_empty() {
            text.push_str("\nRuntime diagnostics:\n");
            text.push_str(&diagnostics);
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use serde_json::json;
    use std::cell::Cell;

    #[tokio::test]
    async fn visual_input_owner_drops_without_another_poll_and_eof_is_not_silenced() {
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        };
        struct Input(Arc<AtomicBool>);
        impl Stream for Input {
            type Item = io::Result<Event>;
            fn poll_next(
                self: std::pin::Pin<&mut Self>,
                _context: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Pending
            }
        }
        impl Drop for Input {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let owner = Arc::new(Mutex::new(Some(Input(dropped.clone()))));
        let mut input = visual_input(owner.clone());
        assert!(futures_util::poll!(input.next()).is_pending());
        owner.lock().unwrap().take();
        assert!(dropped.load(Ordering::SeqCst));
        assert!(input.next().await.is_none());

        let owner = Arc::new(Mutex::new(Some(stream::empty::<io::Result<Event>>())));
        let mut input = visual_input(owner.clone());
        assert!(matches!(input.next().await, Some(Err(_))));
        assert!(owner.lock().unwrap().is_none());
        assert!(input.next().await.is_none());
    }

    #[test]
    fn resize_thresholds_preserve_visual_and_accessible_boundaries() {
        for (accessible, width, height) in [(false, 60, 16), (true, 40, 10)] {
            assert!(matches!(
                resize_control(width, height, accessible),
                Control::Resize { eligible: true }
            ));
            assert!(matches!(
                resize_control(width - 1, height, accessible),
                Control::Resize { eligible: false }
            ));
            assert!(matches!(
                resize_control(width, height - 1, accessible),
                Control::Resize { eligible: false }
            ));
        }
    }

    #[tokio::test]
    async fn cleanup_deadline_restores_presentation_without_dropping_runtime() {
        let cancel = CancellationToken::new();
        let restored = Cell::new(false);
        let finished = Cell::new(false);
        let (release, released) = tokio::sync::oneshot::channel();
        let mut release = Some(release);
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            drive_with_deadline(
                async {
                    cancel.cancelled().await;
                    released.await.unwrap();
                    assert!(restored.get());
                    finished.set(true);
                    Err(BackendError(
                        "cleanup failed after terminal restoration".into(),
                    ))
                },
                &cancel,
                stream::iter([Ok(Control::Cancel(129))]),
                None,
                |phase| {
                    if phase == Phase::Restore {
                        assert!(!restored.replace(true));
                        assert!(!finished.get());
                        release.take().unwrap().send(()).unwrap();
                    } else {
                        assert!(!restored.get(), "redraw after restoration");
                    }
                    Ok(())
                },
                stream::pending(),
                Duration::from_millis(5),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(finished.get());
        assert_eq!(outcome.exit_code, 129);
        assert!(evidence(&outcome).contains("cleanup failed after terminal restoration"));
    }

    #[tokio::test]
    async fn resize_fallback_is_debounced_and_does_not_cancel_runtime() {
        let cancel = CancellationToken::new();
        let (release, released) = tokio::sync::oneshot::channel();
        let mut release = Some(release);
        let controls = stream::iter([
            Ok(resize_control(70, 20, false)),
            Ok(resize_control(59, 20, false)),
        ])
        .chain(stream::pending());
        let started = tokio::time::Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            drive(
                async {
                    released.await.unwrap();
                    Ok((json!({}), "completed".into()))
                },
                &cancel,
                controls,
                None,
                |phase| {
                    if phase == Phase::Restore {
                        assert!(!cancel.is_cancelled());
                        assert!(started.elapsed() >= Duration::from_millis(50));
                        release.take().unwrap().send(()).unwrap();
                    }
                    Ok(())
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(outcome.exit_code, 0);
        assert!(!cancel.is_cancelled());
        assert!(outcome.presentation_restored);
    }

    #[tokio::test]
    async fn recovered_size_cancels_pending_fallback_for_both_modes() {
        for accessible in [false, true] {
            let cancel = CancellationToken::new();
            let controls = stream::iter([
                Ok(resize_control(1, 1, accessible)),
                Ok(resize_control(80, 24, accessible)),
            ])
            .chain(stream::pending());
            let outcome = drive(
                async {
                    tokio::time::sleep(Duration::from_millis(65)).await;
                    Ok((json!({}), String::new()))
                },
                &cancel,
                controls,
                None,
                |phase| {
                    assert_ne!(phase, Phase::Restore);
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert!(!outcome.presentation_restored);
            assert!(!cancel.is_cancelled());
            assert_eq!(outcome.exit_code, 0);
        }
    }

    #[tokio::test]
    async fn signal_after_resize_restoration_still_cancels_without_second_restore() {
        let cancel = CancellationToken::new();
        let (notify, restored) = tokio::sync::oneshot::channel();
        let mut notify = Some(notify);
        let mut restoration_count = 0;
        let controls =
            stream::once(async { Ok(resize_control(1, 1, false)) }).chain(stream::once(async {
                restored.await.unwrap();
                Ok(Control::Cancel(143))
            }));
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            drive(
                async {
                    cancel.cancelled().await;
                    Err(BackendError("runtime cancelled after fallback".into()))
                },
                &cancel,
                controls,
                None,
                |phase| {
                    if phase == Phase::Restore {
                        restoration_count += 1;
                        notify.take().unwrap().send(()).unwrap();
                    } else {
                        assert_eq!(restoration_count, 0, "presentation after fallback");
                    }
                    Ok(())
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(restoration_count, 1);
        assert_eq!(outcome.exit_code, 143);
        assert!(outcome.presentation_restored);
        assert!(evidence(&outcome).contains("runtime cancelled after fallback"));
    }

    #[tokio::test]
    async fn resize_during_cancellation_cannot_skip_cleanup_deadline() {
        let cancel = CancellationToken::new();
        let (release, released) = tokio::sync::oneshot::channel();
        let mut release = Some(release);
        let started = tokio::time::Instant::now();
        let outcome = drive_with_deadline(
            async {
                released.await.unwrap();
                Err(BackendError("cleanup result".into()))
            },
            &cancel,
            stream::iter([Ok(Control::Cancel(143)), Ok(resize_control(1, 1, false))]),
            None,
            |phase| {
                if phase == Phase::Restore {
                    assert!(started.elapsed() >= Duration::from_millis(80));
                    release.take().unwrap().send(()).unwrap();
                }
                Ok(())
            },
            stream::pending(),
            Duration::from_millis(80),
        )
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, 143);
        assert!(outcome.presentation_restored);
    }

    #[tokio::test]
    async fn visual_resize_releases_owner_and_retains_runtime_evidence() {
        let cancel = CancellationToken::new();
        let restored = Cell::new(false);
        let (release, released) = tokio::sync::oneshot::channel();
        let mut release = Some(release);
        let (_sender, events) = tokio::sync::mpsc::channel(1);
        let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        let mut view = LifecycleView::new("up", "fixture", false);
        let outcome = drive_visual(
            (&mut terminal, || {
                assert!(!restored.replace(true));
                release.take().unwrap().send(()).unwrap();
            }),
            &mut view,
            async {
                released.await.unwrap();
                assert!(!cancel.is_cancelled());
                Ok((json!({"model":"fixture"}), "runtime complete".into()))
            },
            &cancel,
            stream::once(async { Ok(resize_control(1, 1, false)) }).chain(stream::pending()),
            events,
            &DiagnosticObserver::default(),
        )
        .await
        .unwrap();
        assert!(restored.get());
        assert!(outcome.presentation_restored);
        assert_eq!(outcome.exit_code, 0);
        assert!(evidence(&outcome).contains("runtime complete"));
    }

    #[tokio::test]
    async fn fallback_notification_failure_keeps_runtime_alive_and_is_not_retried() {
        let cancel = CancellationToken::new();
        let (release, released) = tokio::sync::oneshot::channel();
        let mut release = Some(release);
        let outcome = drive(
            async {
                released.await.unwrap();
                Ok((json!({}), "complete".into()))
            },
            &cancel,
            stream::once(async { Ok(resize_control(1, 1, false)) }).chain(stream::pending()),
            None,
            |phase| {
                if phase == Phase::Restore {
                    release.take().unwrap().send(()).unwrap();
                    return Err(io::Error::other("fallback output failed"));
                }
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(!cancel.is_cancelled());
        assert!(outcome.result.is_ok());
        assert!(outcome.presentation_restored);
        assert_eq!(
            outcome.presentation_error.as_deref(),
            Some("fallback output failed")
        );
    }

    #[test]
    fn visual_render_uses_only_observed_stages_and_bounds_history() {
        let mut view = LifecycleView::new("up\u{1b}[31m", "model\nname", false);
        let diagnostics = llmup_runtime::application::events::DiagnosticObserver::default();
        for _ in 0..100 {
            view.update(Phase::Event(LifecycleEvent {
                scope: LifecycleScope::AcquisitionDaemon,
                stage: LifecycleStage::Stop,
                status: LifecycleStatus::Failed,
            }));
        }
        view.update(Phase::Cancelling);
        assert_eq!(view.history.len(), 64);
        assert_eq!(view.omitted_events, 36);
        for (width, height) in [(100, 28), (24, 8), (1, 1)] {
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|frame| view.render(frame, &diagnostics.snapshot()))
                .unwrap();
            let text: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(!text.contains("Readiness"));
            assert!(!text.contains("100%"));
            assert!(!text.contains("cleanup complete"));
            assert!(!text.contains('\u{1b}'));
            if width == 100 {
                assert!(text.contains("Cancellation requested"));
                assert!(text.contains("Acquisition daemon / Stop: failed"));
                assert!(text.contains("36 earlier stage observations omitted"));
            }
        }
    }

    #[tokio::test]
    async fn visual_redraw_and_scroll_do_not_cancel_and_cleanup_is_awaited() {
        let cancel = CancellationToken::new();
        let cleaned = Cell::new(false);
        let mut phases = Vec::new();
        let outcome = drive(
            async {
                cancel.cancelled().await;
                tokio::task::yield_now().await;
                cleaned.set(true);
                Err(BackendError("cleanup failed".into()))
            },
            &cancel,
            stream::iter([Ok(Control::Redraw(1)), Ok(Control::Cancel(130))]),
            None,
            |phase| {
                if matches!(phase, Phase::Redraw(_)) {
                    assert!(!cancel.is_cancelled());
                }
                phases.push(phase);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(cleaned.get());
        assert_eq!(outcome.exit_code, 130);
        assert_eq!(
            phases,
            [
                Phase::Running,
                Phase::Redraw(1),
                Phase::Cancelling,
                Phase::Failed
            ]
        );
        assert!(evidence(&outcome).contains("cleanup failed"));
    }

    #[tokio::test]
    async fn hangup_cancels_once_waits_for_cleanup_and_normal_completion_does_not_abort() {
        let cancel = CancellationToken::new();
        let cleaned = Cell::new(false);
        let mut cancellations = 0;
        let outcome = drive(
            async {
                cancel.cancelled().await;
                tokio::task::yield_now().await;
                cleaned.set(true);
                Err(BackendError("cancelled after cleanup".into()))
            },
            &cancel,
            stream::iter([Ok(Control::Cancel(129)), Ok(Control::Cancel(143))]),
            None,
            |phase| {
                if phase == Phase::Cancelling {
                    cancellations += 1;
                }
                if phase == Phase::Failed {
                    assert!(cleaned.get());
                }
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(cleaned.get());
        assert_eq!(cancellations, 1);
        assert_eq!(outcome.exit_code, 129);
        assert!(evidence(&outcome).contains("Cancellation was requested"));

        let cancel = CancellationToken::new();
        let outcome = drive(
            async { Ok((serde_json::json!({}), String::new())) },
            &cancel,
            stream::pending(),
            None,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, 0);
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test]
    async fn visual_cleanup_redraw_failure_preserves_signal_and_awaits_result() {
        let cancel = CancellationToken::new();
        let cleaned = Cell::new(false);
        let (acknowledge, acknowledged) = tokio::sync::oneshot::channel();
        let mut acknowledge = Some(acknowledge);
        let outcome = drive_with_redraw(
            async {
                acknowledged.await.unwrap();
                assert!(cancel.is_cancelled());
                cleaned.set(true);
                Err(BackendError("cleanup failed".into()))
            },
            &cancel,
            stream::iter([Ok(Control::Cancel(143))]),
            None,
            |phase| {
                if phase == Phase::Redraw(0) {
                    acknowledge.take().unwrap().send(()).unwrap();
                    Err(io::Error::other("redraw failed"))
                } else {
                    Ok(())
                }
            },
            stream::once(async { cancel.cancelled().await }),
        )
        .await
        .unwrap();
        assert!(cleaned.get());
        assert_eq!(outcome.exit_code, 143);
        assert!(evidence(&outcome).contains("cleanup failed"));
        assert!(evidence(&outcome).contains("redraw failed"));
    }

    #[test]
    fn visual_keys_cancel_without_treating_release_resize_or_paste_as_interrupts() {
        use crossterm::event::{KeyEvent, KeyEventKind};
        for key in [
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE),
        ] {
            assert!(matches!(
                visual_control(Event::Key(key)),
                Control::Cancel(130)
            ));
            assert!(matches!(
                visual_control(Event::Key(KeyEvent {
                    kind: KeyEventKind::Release,
                    ..key
                })),
                Control::Redraw(0)
            ));
        }
        assert!(matches!(
            visual_control(Event::Resize(10, 4)),
            Control::Resize { eligible: false }
        ));
        assert!(matches!(
            visual_control(Event::Paste("q\u{3}".into())),
            Control::Redraw(0)
        ));
    }

    #[tokio::test]
    async fn visual_driver_drains_real_events_and_retains_diagnostic_snapshot() {
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(100, 28)).unwrap();
        let mut view = LifecycleView::new("down", "model", false);
        let diagnostics = DiagnosticObserver::default();
        let outcome = drive_visual(
            (&mut terminal, || {}),
            &mut view,
            async {
                sender
                    .try_send(LifecycleEvent {
                        scope: LifecycleScope::Runtime,
                        stage: LifecycleStage::Stop,
                        status: LifecycleStatus::Failed,
                    })
                    .unwrap();
                Err(BackendError("stop failed".into()))
            },
            &CancellationToken::new(),
            stream::pending(),
            receiver,
            &diagnostics,
        )
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, 1);
        assert!(outcome.diagnostics.is_some());
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(text.contains("Runtime / Stop: failed"));
        assert!(text.contains("Cleanup success is not confirmed"));
        assert!(evidence(&outcome).contains("stop failed"));
    }

    #[tokio::test]
    async fn completion_drains_events_in_order_without_waiting_for_held_sender() {
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        let started = LifecycleEvent {
            scope: LifecycleScope::Runtime,
            stage: LifecycleStage::Readiness,
            status: LifecycleStatus::Started,
        };
        let completed = LifecycleEvent {
            status: LifecycleStatus::Completed,
            ..started
        };
        sender.try_send(started).unwrap();
        let mut phases = Vec::new();
        let cancel = CancellationToken::new();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            drive(
                async {
                    sender.try_send(completed).unwrap();
                    Ok((json!({"type":"ready"}), "Ready.\n".into()))
                },
                &cancel,
                stream::pending(),
                Some(receiver),
                |phase| {
                    phases.push(phase);
                    Ok(())
                },
            ),
        )
        .await
        .expect("must not wait for the sender to drop")
        .unwrap();
        assert_eq!(outcome.exit_code, 0);
        assert_eq!(
            phases,
            [
                Phase::Running,
                Phase::Event(started),
                Phase::Event(completed),
                Phase::Completed,
            ]
        );
    }

    #[test]
    fn labels_preserve_scope_stage_and_status_without_claiming_command_success() {
        for (scope, scope_label) in [
            (LifecycleScope::Runtime, "Runtime"),
            (LifecycleScope::AcquisitionDaemon, "Acquisition daemon"),
        ] {
            for (stage, stage_label) in [
                (LifecycleStage::Acquisition, "Acquisition"),
                (LifecycleStage::Verification, "Verification"),
                (
                    LifecycleStage::AcquisitionVerification,
                    "Acquisition and verification",
                ),
                (LifecycleStage::Start, "Start/serve (may reuse a server)"),
                (LifecycleStage::Attach, "Attach"),
                (LifecycleStage::Activation, "Activation"),
                (LifecycleStage::Readiness, "Readiness"),
                (LifecycleStage::Stop, "Stop"),
            ] {
                for (status, status_label) in [
                    (LifecycleStatus::Started, "started"),
                    (LifecycleStatus::Completed, "completed"),
                    (LifecycleStatus::Failed, "failed"),
                ] {
                    let mut output = Vec::new();
                    write_phase(
                        &mut output,
                        "up",
                        "model",
                        Phase::Event(LifecycleEvent {
                            scope,
                            stage,
                            status,
                        }),
                    )
                    .unwrap();
                    assert_eq!(
                        String::from_utf8(output).unwrap(),
                        format!("{scope_label} / {stage_label}: {status_label}\n")
                    );
                }
            }
        }
        let mut output = Vec::new();
        write_phase(&mut output, "up\u{1b}[31m", "model\nname", Phase::Running).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(!text.contains('\u{1b}'));
        assert!(text.contains("best-effort and may be incomplete"));
        assert!(text.contains("does not confirm command success or saved state"));
    }

    #[tokio::test]
    async fn events_are_presented_live_and_failure_is_drained_before_recovery() {
        let cancel = CancellationToken::new();
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        let (acknowledge, acknowledged) = tokio::sync::oneshot::channel();
        let mut acknowledge = Some(acknowledge);
        let started = LifecycleEvent {
            scope: LifecycleScope::Runtime,
            stage: LifecycleStage::Verification,
            status: LifecycleStatus::Started,
        };
        let mut output = Vec::new();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            drive(
                async {
                    sender.try_send(started).unwrap();
                    acknowledged.await.unwrap();
                    sender
                        .try_send(LifecycleEvent {
                            status: LifecycleStatus::Failed,
                            ..started
                        })
                        .unwrap();
                    Err(BackendError("verification failed".into()))
                },
                &cancel,
                stream::pending(),
                Some(receiver),
                |phase| {
                    write_phase(&mut output, "up", "model", phase)?;
                    if phase == Phase::Event(started) {
                        acknowledge.take().unwrap().send(()).unwrap();
                    }
                    Ok(())
                },
            ),
        )
        .await
        .expect("started must be presented before the operation completes")
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.ends_with("Runtime / Verification: started\nRuntime / Verification: failed\nRuntime returned an error. Final evidence follows.\n"));
        assert_eq!(outcome.exit_code, 1);
        assert!(evidence(&outcome).contains("Effects are unknown"));
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test]
    async fn signal_has_priority_and_cleanup_events_remain_live_until_completion() {
        for code in [130, 143] {
            let cancel = CancellationToken::new();
            let (sender, receiver) = tokio::sync::mpsc::channel(64);
            let (acknowledge, acknowledged) = tokio::sync::oneshot::channel();
            let mut acknowledge = Some(acknowledge);
            let event = LifecycleEvent {
                scope: LifecycleScope::AcquisitionDaemon,
                stage: LifecycleStage::Stop,
                status: LifecycleStatus::Started,
            };
            let completed = LifecycleEvent {
                status: LifecycleStatus::Completed,
                ..event
            };
            sender.try_send(event).unwrap();
            let mut phases = Vec::new();
            let outcome = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                drive(
                    async {
                        assert!(cancel.is_cancelled());
                        acknowledged.await.unwrap();
                        sender.try_send(completed).unwrap();
                        Ok((json!({"type":"stopped"}), "Stopped.\n".into()))
                    },
                    &cancel,
                    stream::iter([Ok(Control::Cancel(code))]),
                    Some(receiver),
                    |phase| {
                        phases.push(phase);
                        if phase == Phase::Event(event) {
                            acknowledge.take().unwrap().send(()).unwrap();
                        }
                        Ok(())
                    },
                ),
            )
            .await
            .expect("cleanup events must remain live after cancellation")
            .unwrap();
            assert_eq!(outcome.exit_code, code);
            assert!(outcome.result.is_ok());
            assert_eq!(
                phases,
                [
                    Phase::Running,
                    Phase::Cancelling,
                    Phase::Event(event),
                    Phase::Event(completed),
                    Phase::Completed
                ]
            );
        }
    }

    #[tokio::test]
    async fn event_sink_failure_cancels_and_awaits_cleanup_without_masking_later_signal() {
        for signal in [false, true] {
            let cancel = CancellationToken::new();
            let cleaned = Cell::new(false);
            let writes = Cell::new(0);
            let (sender, receiver) = tokio::sync::mpsc::channel(64);
            let event = LifecycleEvent {
                scope: LifecycleScope::Runtime,
                stage: LifecycleStage::Readiness,
                status: LifecycleStatus::Started,
            };
            let outcome = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                drive(
                    async {
                        sender.try_send(event).unwrap();
                        cancel.cancelled().await;
                        sender
                            .try_send(LifecycleEvent {
                                stage: LifecycleStage::Stop,
                                ..event
                            })
                            .unwrap();
                        tokio::task::yield_now().await;
                        cleaned.set(true);
                        Ok((json!({"type":"stopped"}), "Stopped.\n".into()))
                    },
                    &cancel,
                    stream::once(async {
                        if !signal {
                            std::future::pending::<()>().await;
                        }
                        cancel.cancelled().await;
                        Ok(Control::Cancel(143))
                    }),
                    Some(receiver),
                    |phase| {
                        writes.set(writes.get() + 1);
                        if matches!(phase, Phase::Event(_)) {
                            Err(io::Error::other("event sink failed"))
                        } else {
                            Ok(())
                        }
                    },
                ),
            )
            .await
            .expect("sink failure must cancel and await the operation")
            .unwrap();
            assert!(cleaned.get());
            assert!(cancel.is_cancelled());
            assert_eq!(writes.get(), 2);
            assert_eq!(outcome.exit_code, if signal { 143 } else { 1 });
            assert_eq!(outcome.result.as_ref().unwrap().0["type"], "stopped");
            assert!(evidence(&outcome).contains("Presentation error: event sink failed"));
        }
    }

    #[test]
    fn closed_event_channel_does_not_spin_or_end_the_operation() {
        use std::task::{Context, Poll};
        let (observer, receiver) = llmup_runtime::application::events::LifecycleObserver::channel();
        drop(observer);
        let cancel = CancellationToken::new();
        let polls = Cell::new(0);
        let complete = Cell::new(false);
        let operation = std::future::poll_fn(|_| {
            polls.set(polls.get() + 1);
            assert!(
                polls.get() <= 3,
                "closed event input must not repeatedly poll the operation"
            );
            if complete.get() {
                Poll::Ready(Ok((json!({}), String::new())))
            } else {
                Poll::Pending
            }
        });
        let mut controller = std::pin::pin!(drive(
            operation,
            &cancel,
            stream::pending(),
            Some(receiver),
            |_| Ok(())
        ));
        let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(controller.as_mut().poll(&mut context).is_pending());
        complete.set(true);
        let Poll::Ready(Ok(outcome)) = controller.as_mut().poll(&mut context) else {
            panic!("operation completion must end the controller");
        };
        assert_eq!(outcome.exit_code, 0);
    }

    #[tokio::test]
    async fn cancellation_waits_for_runtime_and_preserves_signal_exit() {
        for code in [130, 143] {
            let cancel = CancellationToken::new();
            let cleaned = Cell::new(false);
            let mut phases = Vec::new();
            let result = drive(
                async {
                    cancel.cancelled().await;
                    cleaned.set(true);
                    Err(BackendError("runtime stopped after cleanup".into()))
                },
                &cancel,
                stream::iter([Ok(Control::Cancel(code))]),
                None,
                |phase| {
                    phases.push(phase);
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert!(cleaned.get());
            assert_eq!(result.exit_code, code);
            assert!(result.result.is_err());
            assert_eq!(phases, [Phase::Running, Phase::Cancelling, Phase::Failed]);
        }
    }

    #[tokio::test]
    async fn success_after_cancellation_is_not_reported_as_rollback() {
        let cancel = CancellationToken::new();
        let result = drive(
            async {
                cancel.cancelled().await;
                Ok((json!({"type":"switched"}), "Switched.\n".into()))
            },
            &cancel,
            stream::iter([Ok(Control::Cancel(130))]),
            None,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, 130);
        assert_eq!(result.result.unwrap().0["type"], "switched");
    }

    #[tokio::test]
    async fn display_failure_before_execution_does_not_poll_runtime() {
        let polled = Cell::new(false);
        let result = drive(
            async {
                polled.set(true);
                Ok((json!({}), String::new()))
            },
            &CancellationToken::new(),
            stream::pending(),
            None,
            |_| Err(io::Error::other("display unavailable")),
        )
        .await;
        assert!(result.is_err());
        assert!(!polled.get());
    }

    #[tokio::test]
    async fn input_failure_cancels_once_and_drains_runtime() {
        let cancel = CancellationToken::new();
        let calls = Cell::new(0);
        let result = drive(
            async {
                calls.set(calls.get() + 1);
                cancel.cancelled().await;
                Err(BackendError("cleanup result".into()))
            },
            &cancel,
            stream::iter([Err(io::Error::other("input failed"))]),
            None,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(result.exit_code, 1);
        assert!(result.presentation_error.is_some());
    }

    #[tokio::test]
    async fn final_display_failure_preserves_success_without_retry() {
        let calls = Cell::new(0);
        let cancel = CancellationToken::new();
        let result = drive(
            async {
                calls.set(calls.get() + 1);
                Ok((json!({"type":"stopped"}), "Stopped.\n".into()))
            },
            &cancel,
            stream::pending(),
            None,
            |phase| {
                if phase == Phase::Completed {
                    Err(io::Error::other("display failed"))
                } else {
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.result.as_ref().unwrap().0["type"], "stopped");
        assert!(evidence(&result).contains("Presentation error: display failed"));
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test]
    async fn unexpected_control_exit_cancels_and_waits_for_runtime_cleanup() {
        let cancel = CancellationToken::new();
        let cleaned = Cell::new(false);
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            drive(
                async {
                    cancel.cancelled().await;
                    cleaned.set(true);
                    Err(BackendError("cleanup finished".into()))
                },
                &cancel,
                stream::empty(),
                None,
                |_| Ok(()),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(cleaned.get());
        assert_eq!(result.exit_code, 1);
        assert_eq!(
            result.presentation_error.as_deref(),
            Some("lifecycle control input ended")
        );
        assert!(
            result
                .result
                .unwrap_err()
                .to_string()
                .contains("cleanup finished")
        );
    }

    #[tokio::test]
    async fn cancellation_display_failure_does_not_mask_termination_or_cleanup() {
        let cancel = CancellationToken::new();
        let result = drive(
            async {
                cancel.cancelled().await;
                Err(BackendError("runtime cleanup failed".into()))
            },
            &cancel,
            stream::iter([Ok(Control::Cancel(143))]),
            None,
            |phase| {
                if phase == Phase::Cancelling {
                    Err(io::Error::other("display failed"))
                } else {
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, 143);
        assert!(evidence(&result).contains("runtime cleanup failed"));
        assert!(evidence(&result).contains("Effects are unknown"));
    }

    #[tokio::test]
    async fn runtime_failure_is_not_retried_or_reclassified_as_clean_cancellation() {
        let mut phases = Vec::new();
        let result = drive(
            async { Err(BackendError("integrity mismatch\u{1b}[31m".into())) },
            &CancellationToken::new(),
            stream::pending(),
            None,
            |phase| {
                phases.push(phase);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, 1);
        assert_eq!(phases, [Phase::Running, Phase::Failed]);
        let text = evidence(&result);
        assert!(text.contains("integrity mismatch\n"));
        assert!(text.contains("Effects are unknown"));
        assert!(text.contains("llmup-native doctor"));
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains("Cancellation was requested"));
    }

    #[test]
    fn evidence_preserves_lines_and_only_displays_returned_fields() {
        let result = Outcome {
            result: Ok((
                json!({
                    "backend": "ollama", "ownership": "attached", "integrity": "size-only"
                }),
                "Model ready\nRuntime model: test\u{1b}[31m\n".into(),
            )),
            exit_code: 0,
            presentation_error: None,
            diagnostics: None,
            presentation_restored: false,
        };
        let text = evidence(&result);
        assert!(text.contains("Model ready\nRuntime model: test\n"));
        assert!(text.contains("Ownership: attached\nIntegrity: size-only\n"));
        assert!(!text.contains("verified"));
        assert!(!text.contains("Endpoint:"));
        assert!(!text.contains("%"));
        assert!(!text.contains('\u{1b}'));
    }
}
