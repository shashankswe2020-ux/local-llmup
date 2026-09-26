use llmup_core::reports::strip_control;
use std::io::{self, BufRead, Read, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub fn read_answer(input: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    input.take(259).read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    if bytes.len() > 256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "answer exceeds 256 bytes",
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "answer must be UTF-8"))
}

pub fn stdin_answers() -> mpsc::Receiver<io::Result<String>> {
    let (sender, receiver) = mpsc::channel(1);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        forward_answers(&mut input, sender);
    });
    receiver
}

fn forward_answers(input: &mut impl BufRead, sender: mpsc::Sender<io::Result<String>>) {
    loop {
        match read_answer(input) {
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
}

pub(crate) async fn answer(
    input: &mut mpsc::Receiver<io::Result<String>>,
    cancel: &CancellationToken,
) -> io::Result<Option<String>> {
    let line = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(io::Error::new(io::ErrorKind::Interrupted,"interactive input cancelled")),
        line = input.recv() => line.transpose()?,
    };
    if line.as_ref().is_some_and(|line| line.len() > 256) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "answer exceeds 256 bytes",
        ));
    }
    Ok(line)
}

fn safe_label(label: &str) -> io::Result<String> {
    if label.len() > 8192 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "interactive label exceeds bound",
        ));
    }
    Ok(strip_control(label))
}

pub(crate) fn validate_picker_choices(choices: &[String], label_bytes: usize) -> io::Result<()> {
    let mut unique = std::collections::BTreeSet::new();
    if choices.is_empty()
        || choices.len() > 1000
        || choices.iter().any(|choice| {
            choice.trim().is_empty()
                || choice.len() > label_bytes
                || choice.chars().any(char::is_control)
                || !unique.insert(choice)
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid model choices",
        ));
    }
    Ok(())
}

pub async fn pick_model(
    title: &str,
    choices: &[String],
    input: &mut mpsc::Receiver<io::Result<String>>,
    output: &mut impl Write,
    cancel: &CancellationToken,
) -> io::Result<Option<usize>> {
    validate_picker_choices(choices, 256)?;
    writeln!(output, "{}", safe_label(title)?)?;
    for (index, choice) in choices.iter().take(20).enumerate() {
        writeln!(output, "{}. {}", index + 1, safe_label(choice)?)?;
    }
    if choices.len() > 20 {
        writeln!(
            output,
            "Showing first 20 of {} models. Enter any catalog number directly.",
            choices.len()
        )?;
    }
    writeln!(output, "Enter a model number, or q to cancel.")?;
    loop {
        output.flush()?;
        let Some(raw) = answer(input, cancel).await? else {
            return Ok(None);
        };
        let raw = raw.trim();
        if raw == "q" {
            return Ok(None);
        }
        if let Ok(number) = raw.parse::<usize>()
            && number > 0
            && number <= choices.len()
        {
            return Ok(Some(number - 1));
        }
        writeln!(
            output,
            "No such model. Enter a listed number, or q to cancel."
        )?;
    }
}

pub async fn confirm(
    screen: &str,
    title: &str,
    lines: &[String],
    confirm_label: &str,
    input: &mut mpsc::Receiver<io::Result<String>>,
    output: &mut impl Write,
    cancel: &CancellationToken,
) -> io::Result<bool> {
    if lines.len() > 100 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "review exceeds bound",
        ));
    }
    let mut document = format!(
        "local-llmup / {} / Accessible\n{}\n",
        safe_label(screen)?,
        safe_label(title)?
    );
    for line in lines {
        document.push_str(&safe_label(line)?);
        document.push('\n');
    }
    document.push_str(&format!(
        "1. Cancel (default)\n2. {}\nChoose 1 or 2, then press Enter:\n",
        safe_label(confirm_label)?
    ));
    if document.len() > 32768 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "review exceeds 32 KiB",
        ));
    }
    output.write_all(document.as_bytes())?;
    output.flush()?;
    Ok(answer(input, cancel)
        .await?
        .is_some_and(|line| line.trim() == "2"))
}

#[cfg(test)]
mod reader_tests {
    use super::*;
    use std::{io::Cursor, time::Duration};

    #[test]
    fn forwarding_stops_after_oversize_without_delivering_a_truncated_command() {
        let (sender, mut receiver) = mpsc::channel(1);
        let worker = std::thread::spawn(move || {
            let mut input = Cursor::new(format!("{}\n2\n", "x".repeat(1_000_000)));
            forward_answers(&mut input, sender);
            input.position()
        });
        assert_eq!(
            receiver.blocking_recv().unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(receiver.blocking_recv().is_none());
        assert_eq!(worker.join().unwrap(), 259);
    }

    #[test]
    fn forwarding_preserves_lines_applies_backpressure_and_stops_on_receiver_close() {
        let (sender, mut receiver) = mpsc::channel(1);
        let (finished, completion) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut input = Cursor::new("line\r\n".repeat(1000));
            forward_answers(&mut input, sender);
            finished.send(input.position()).unwrap();
        });
        for _ in 0..200 {
            assert_eq!(receiver.blocking_recv().unwrap().unwrap(), "line");
        }
        assert!(matches!(
            completion.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        drop(receiver);
        let consumed = completion.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            consumed <= 202 * 6,
            "read beyond queued and in-flight lines: {consumed}"
        );
        worker.join().unwrap();

        let (sender, mut receiver) = mpsc::channel(2);
        forward_answers(&mut Cursor::new("one\r\ntwo\n"), sender);
        assert_eq!(receiver.blocking_recv().unwrap().unwrap(), "one");
        assert_eq!(receiver.blocking_recv().unwrap().unwrap(), "two");
        assert!(receiver.blocking_recv().is_none());
    }
}
