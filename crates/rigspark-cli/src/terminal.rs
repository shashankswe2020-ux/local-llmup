use rigspark_runtime::harness::HarnessMessage;
use std::io::{self, BufRead, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use unicode_segmentation::UnicodeSegmentation;

const MAX_LINE_BYTES: usize = 32 * 1024;
const MAX_DRAFT_GRAPHEMES: usize = 8192;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

pub(crate) fn validate_draft(draft: &str) -> io::Result<()> {
    if draft.len() > MAX_LINE_BYTES {
        return Err(io::Error::other(format!(
            "Draft exceeds {MAX_LINE_BYTES} byte limit ({} bytes)",
            draft.len()
        )));
    }
    for (actual, limit, unit, plural) in [
        (
            draft.graphemes(true).count(),
            MAX_DRAFT_GRAPHEMES,
            "grapheme",
            "graphemes",
        ),
        (draft.split('\n').count(), 256, "line", "lines"),
    ] {
        if actual > limit {
            return Err(io::Error::other(format!(
                "Draft exceeds {limit} {unit} limit ({actual} {plural})"
            )));
        }
    }
    Ok(())
}

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
        if let Err(error) = validate_draft(&turn) {
            summary.failed_turns += 1;
            writeln!(diagnostic, "chat: {error}")?;
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
                    rigspark_core::reports::strip_control(&error)
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
        let visible = rigspark_runtime::sessions::gui_text(&reply.content);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_validation_matches_legacy_inclusive_limits_and_diagnostics() {
        assert_eq!(MAX_LINE_BYTES, 32768);
        assert_eq!(MAX_DRAFT_GRAPHEMES, 8192);
        assert_eq!(MAX_RESPONSE_BYTES, 1048576);
        let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}";
        assert_eq!(family.graphemes(true).count(), 1);
        for draft in [
            String::new(),
            "Hello, world!".into(),
            "a".repeat(8192),
            "\u{1f600}".repeat(8192),
            family.repeat(100),
            "x\n".repeat(255),
        ] {
            validate_draft(&draft).unwrap();
        }
        for (draft, error) in [
            (
                "a".repeat(40000),
                "Draft exceeds 32768 byte limit (40000 bytes)",
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
                "a".repeat(9000),
                "Draft exceeds 8192 grapheme limit (9000 graphemes)",
            ),
            (
                "\n".repeat(9000),
                "Draft exceeds 8192 grapheme limit (9000 graphemes)",
            ),
            (
                "x\n".repeat(299),
                "Draft exceeds 256 line limit (300 lines)",
            ),
        ] {
            assert_eq!(validate_draft(&draft).unwrap_err().to_string(), error);
        }
    }
}
