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
