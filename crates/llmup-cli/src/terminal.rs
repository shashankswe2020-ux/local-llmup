use llmup_runtime::harness::HarnessMessage;
use std::io::{self, BufRead, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use unicode_segmentation::UnicodeSegmentation;

const MAX_LINE_BYTES: usize = 32 * 1024;
const MAX_DRAFT_GRAPHEMES: usize = 8192;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Plain,
    Accessible,
}
pub struct ChatReply {
    pub content: String,
    pub memory_warning: bool,
}
pub trait ChatEngine {
    fn reply(
        &self,
        messages: &[HarnessMessage],
        cancel: &CancellationToken,
    ) -> impl std::future::Future<Output = Result<ChatReply, String>>;
}
#[derive(Default)]
pub struct ChatSummary {
    pub turns: usize,
    pub memory_warnings: usize,
    pub failed_turns: usize,
    pub cancelled: bool,
}

pub fn read_turn(input: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if bytes.len() + count > MAX_LINE_BYTES + 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "chat line exceeds 32 KiB",
            ));
        }
        bytes.extend_from_slice(&available[..count]);
        input.consume(count);
        if newline.is_some() {
            break;
        }
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.len() > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "chat line exceeds 32 KiB",
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "chat input must be UTF-8"))
}

pub fn stdin_turns() -> mpsc::Receiver<io::Result<String>> {
    let (sender, receiver) = mpsc::channel(1);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match read_turn(&mut input) {
                Ok(Some(line)) => {
                    if sender.blocking_send(Ok(line)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.blocking_send(Err(error));
                    break;
                }
            }
        }
    });
    receiver
}

pub async fn run_chat(
    mut input: mpsc::Receiver<io::Result<String>>,
    engine: &impl ChatEngine,
    mode: Mode,
    cancel: &CancellationToken,
    output: &mut impl Write,
    diagnostic: &mut impl Write,
) -> io::Result<ChatSummary> {
    let mut summary = ChatSummary::default();
    let mut history = Vec::new();
    loop {
        let turn = tokio::select! {
            biased;
            _ = cancel.cancelled() => { summary.cancelled = true; break; },
            turn = input.recv() => match turn { Some(turn) => turn?, None => break },
        };
        if turn.trim().is_empty() {
            continue;
        }
        if turn.len() > MAX_LINE_BYTES
            || turn.graphemes(true).count() > MAX_DRAFT_GRAPHEMES
            || turn.lines().count() > 256
        {
            summary.failed_turns += 1;
            writeln!(
                diagnostic,
                "chat: draft exceeds 32768 bytes, 8192 graphemes, or 256 lines"
            )?;
            continue;
        }
        let mut context = history.clone();
        context.push(HarnessMessage {
            role: "user".into(),
            content: turn.clone(),
        });
        if context.len() > 20 {
            context.drain(..context.len() - 20);
        }
        if mode == Mode::Accessible {
            writeln!(diagnostic, "Waiting for response...")?;
            diagnostic.flush()?;
        }
        let reply = tokio::select! {
            biased;
            _ = cancel.cancelled() => { summary.cancelled = true; break; },
            reply = engine.reply(&context, cancel) => reply,
        };
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                summary.failed_turns += 1;
                writeln!(
                    diagnostic,
                    "chat: {}",
                    llmup_core::reports::strip_control(&error)
                )?;
                continue;
            }
        };
        if cancel.is_cancelled() {
            summary.cancelled = true;
            break;
        }
        if reply.content.len() > MAX_RESPONSE_BYTES {
            summary.failed_turns += 1;
            writeln!(diagnostic, "chat: response exceeds 1 MiB limit")?;
            continue;
        }
        let visible = llmup_runtime::sessions::gui_text(&reply.content);
        if mode == Mode::Plain {
            writeln!(output, "{visible}")?;
            output.flush()?;
        } else {
            writeln!(diagnostic, "{visible}")?;
            diagnostic.flush()?;
        }
        history.push(HarnessMessage {
            role: "user".into(),
            content: turn,
        });
        history.push(HarnessMessage {
            role: "assistant".into(),
            content: reply.content,
        });
        if history.len() > 20 {
            history.drain(..history.len() - 20);
        }
        summary.turns += 1;
        if reply.memory_warning {
            summary.memory_warnings += 1;
            writeln!(diagnostic, "chat: failed to record memory")?;
        }
    }
    if mode == Mode::Accessible {
        writeln!(
            output,
            "Chat session ended: {} turn{}, {} memory warning{}.",
            summary.turns,
            if summary.turns == 1 { "" } else { "s" },
            summary.memory_warnings,
            if summary.memory_warnings == 1 {
                ""
            } else {
                "s"
            }
        )?;
    }
    Ok(summary)
}
