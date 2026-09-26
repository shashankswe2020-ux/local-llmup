use llmup_cli::terminal::{ChatEngine, ChatReply, Mode, read_turn, run_chat};
use llmup_runtime::harness::HarnessMessage;
use std::{io::Cursor, sync::Mutex};
use tokio_util::sync::CancellationToken;

struct Fake(Mutex<Vec<Vec<HarnessMessage>>>);
impl ChatEngine for Fake {
    async fn reply(
        &self,
        messages: &[HarnessMessage],
        _: &CancellationToken,
    ) -> Result<ChatReply, String> {
        self.0.lock().unwrap().push(messages.to_vec());
        Ok(ChatReply {
            content: "reply\nsecond line".into(),
            memory_warning: false,
        })
    }
}

#[test]
fn bounded_lines_preserve_crlf_unicode_and_final_line() {
    let mut input = Cursor::new("first\r\n\nlast".as_bytes());
    assert_eq!(read_turn(&mut input).unwrap().as_deref(), Some("first"));
    assert_eq!(read_turn(&mut input).unwrap().as_deref(), Some(""));
    assert_eq!(read_turn(&mut input).unwrap().as_deref(), Some("last"));
    assert_eq!(read_turn(&mut input).unwrap(), None);
    assert!(read_turn(&mut Cursor::new(vec![b'x'; 32769])).is_err());
}

#[tokio::test]
async fn plain_and_accessible_output_keep_separate_transcript_contracts() {
    for mode in [Mode::Plain, Mode::Accessible] {
        let engine = Fake(Mutex::new(Vec::new()));
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        for text in ["first", "", "second"] {
            sender.send(Ok(text.into())).await.unwrap();
        }
        drop(sender);
        let mut output = Vec::new();
        let mut diagnostic = Vec::new();
        let result = run_chat(
            receiver,
            &engine,
            mode,
            &CancellationToken::new(),
            &mut output,
            &mut diagnostic,
        )
        .await
        .unwrap();
        assert_eq!(result.turns, 2);
        let calls = engine.0.lock().unwrap();
        assert_eq!(calls[1].len(), 3);
        assert_eq!(calls[1][1].content, "reply\nsecond line");
        if mode == Mode::Plain {
            assert_eq!(
                String::from_utf8(output).unwrap(),
                "reply\nsecond line\nreply\nsecond line\n"
            );
        } else {
            assert_eq!(
                String::from_utf8(output).unwrap(),
                "Chat session ended: 2 turns, 0 memory warnings.\n"
            );
            assert!(
                String::from_utf8(diagnostic)
                    .unwrap()
                    .contains("reply\nsecond line")
            );
        }
    }
}

#[tokio::test]
async fn cancellation_while_waiting_for_input_exits_without_a_provider_call() {
    let engine = Fake(Mutex::new(Vec::new()));
    let (_sender, receiver) = tokio::sync::mpsc::channel(1);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = run_chat(
        receiver,
        &engine,
        Mode::Plain,
        &cancel,
        &mut Vec::new(),
        &mut Vec::new(),
    )
    .await
    .unwrap();
    assert!(result.cancelled);
    assert!(engine.0.lock().unwrap().is_empty());
}

struct CancelDuringReply;
impl ChatEngine for CancelDuringReply {
    async fn reply(
        &self,
        _: &[HarnessMessage],
        cancel: &CancellationToken,
    ) -> Result<ChatReply, String> {
        cancel.cancel();
        std::future::pending().await
    }
}
#[tokio::test]
async fn cancellation_during_reply_publishes_no_partial_transcript() {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    sender.send(Ok("hello".into())).await.unwrap();
    let mut output = Vec::new();
    let result = run_chat(
        receiver,
        &CancelDuringReply,
        Mode::Plain,
        &CancellationToken::new(),
        &mut output,
        &mut Vec::new(),
    )
    .await
    .unwrap();
    assert!(result.cancelled);
    assert_eq!(result.turns, 0);
    assert!(output.is_empty());
}

#[tokio::test]
async fn long_sessions_keep_only_twenty_inference_messages() {
    let engine = Fake(Mutex::new(Vec::new()));
    let (sender, receiver) = tokio::sync::mpsc::channel(32);
    for number in 0..25 {
        sender.send(Ok(format!("turn {number}"))).await.unwrap();
    }
    drop(sender);
    run_chat(
        receiver,
        &engine,
        Mode::Plain,
        &CancellationToken::new(),
        &mut Vec::new(),
        &mut Vec::new(),
    )
    .await
    .unwrap();
    let calls = engine.0.lock().unwrap();
    assert!(calls.iter().all(|call| call.len() <= 20));
    assert_eq!(calls.last().unwrap().last().unwrap().content, "turn 24");
}

struct FailureThenReply(Mutex<usize>);
#[tokio::test]
async fn invalid_drafts_never_reach_provider_and_next_valid_turn_succeeds() {
    for mode in [Mode::Plain, Mode::Accessible] {
        for (draft, error) in [
            (
                "a".repeat(32769),
                "Draft exceeds 32768 byte limit (32769 bytes)",
            ),
            (
                "a".repeat(8193),
                "Draft exceeds 8192 grapheme limit (8193 graphemes)",
            ),
            (
                "line\n".repeat(256),
                "Draft exceeds 256 line limit (257 lines)",
            ),
        ] {
            let engine = Fake(Mutex::new(Vec::new()));
            let (sender, receiver) = tokio::sync::mpsc::channel(2);
            sender.send(Ok(draft)).await.unwrap();
            sender.send(Ok("valid".into())).await.unwrap();
            drop(sender);
            let mut diagnostic = Vec::new();
            let summary = run_chat(
                receiver,
                &engine,
                mode,
                &CancellationToken::new(),
                &mut Vec::new(),
                &mut diagnostic,
            )
            .await
            .unwrap();
            assert_eq!(summary.turns, 1);
            assert_eq!(summary.failed_turns, 1);
            let calls = engine.0.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].len(), 1);
            assert_eq!(calls[0][0].content, "valid");
            assert!(String::from_utf8(diagnostic).unwrap().contains(error));
        }
    }
}

impl ChatEngine for FailureThenReply {
    async fn reply(
        &self,
        messages: &[HarnessMessage],
        _: &CancellationToken,
    ) -> Result<ChatReply, String> {
        let mut count = self.0.lock().unwrap();
        *count += 1;
        if *count == 1 {
            return Err("fixture failure".into());
        }
        assert_eq!(messages.len(), 1);
        Ok(ChatReply {
            content: "ok".into(),
            memory_warning: true,
        })
    }
}
#[tokio::test]
async fn failed_turns_do_not_enter_history_and_report_failure_status() {
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    sender.send(Ok("failed".into())).await.unwrap();
    sender.send(Ok("retry".into())).await.unwrap();
    drop(sender);
    let mut output = Vec::new();
    let result = run_chat(
        receiver,
        &FailureThenReply(Mutex::new(0)),
        Mode::Accessible,
        &CancellationToken::new(),
        &mut output,
        &mut Vec::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.failed_turns, 1);
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "Chat session ended: 1 turn, 1 memory warning.\n"
    );
}

struct Replies(Mutex<std::collections::VecDeque<ChatReply>>);
impl ChatEngine for Replies {
    async fn reply(
        &self,
        _: &[HarnessMessage],
        _: &CancellationToken,
    ) -> Result<ChatReply, String> {
        Ok(self.0.lock().unwrap().pop_front().unwrap())
    }
}

#[tokio::test]
async fn response_utf8_limit_is_inclusive_and_oversized_turns_do_not_block_recovery() {
    for content in [
        "a".repeat(1048576),
        "a".repeat(1048577),
        "\u{1f600}".repeat(262145),
    ] {
        let rejected = content.len() > 1048576;
        let engine = Replies(Mutex::new(std::collections::VecDeque::from([
            ChatReply {
                content,
                memory_warning: false,
            },
            ChatReply {
                content: "recovered".into(),
                memory_warning: false,
            },
        ])));
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        sender.send(Ok("first".into())).await.unwrap();
        sender.send(Ok("second".into())).await.unwrap();
        drop(sender);
        let mut output = Vec::new();
        let mut diagnostic = Vec::new();
        let summary = run_chat(
            receiver,
            &engine,
            Mode::Plain,
            &CancellationToken::new(),
            &mut output,
            &mut diagnostic,
        )
        .await
        .unwrap();
        assert_eq!(summary.turns, if rejected { 1 } else { 2 });
        assert_eq!(summary.failed_turns, usize::from(rejected));
        if rejected {
            assert_eq!(output, b"recovered\n");
            assert!(
                String::from_utf8(diagnostic)
                    .unwrap()
                    .contains("response exceeds 1 MiB")
            );
        } else {
            assert_eq!(output.len(), 1048576 + 1 + "recovered\n".len());
        }
    }
}

#[tokio::test]
async fn session_summaries_preserve_zero_singular_plural_and_memory_warnings() {
    for (turns, warnings, expected) in [
        (0, 0, "Chat session ended: 0 turns, 0 memory warnings.\n"),
        (1, 0, "Chat session ended: 1 turn, 0 memory warnings.\n"),
        (5, 0, "Chat session ended: 5 turns, 0 memory warnings.\n"),
        (3, 1, "Chat session ended: 3 turns, 1 memory warning.\n"),
        (7, 4, "Chat session ended: 7 turns, 4 memory warnings.\n"),
    ] {
        let engine = Replies(Mutex::new(
            (0..turns)
                .map(|index| ChatReply {
                    content: "reply".into(),
                    memory_warning: index < warnings,
                })
                .collect(),
        ));
        let (sender, receiver) = tokio::sync::mpsc::channel(10);
        for _ in 0..turns {
            sender.send(Ok("question".into())).await.unwrap();
        }
        drop(sender);
        let mut output = Vec::new();
        let mut diagnostic = Vec::new();
        let summary = run_chat(
            receiver,
            &engine,
            Mode::Accessible,
            &CancellationToken::new(),
            &mut output,
            &mut diagnostic,
        )
        .await
        .unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), expected);
        assert_eq!(summary.turns, turns);
        assert_eq!(summary.memory_warnings, warnings);
        let diagnostic = String::from_utf8(diagnostic).unwrap();
        assert_eq!(diagnostic.matches("Waiting for response...").count(), turns);
        assert_eq!(
            diagnostic.matches("failed to record memory").count(),
            warnings
        );
    }
}
