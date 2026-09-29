use rigspark_cli::accessible::{confirm, pick_model, read_answer};
use std::io::{self, Cursor};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn input(lines: &[&str]) -> mpsc::Receiver<io::Result<String>> {
    let (sender, receiver) = mpsc::channel(16);
    for line in lines {
        sender.try_send(Ok((*line).into())).unwrap();
    }
    receiver
}

#[test]
fn cooked_answers_are_bounded_utf8_and_accept_crlf_and_eof() {
    assert_eq!(
        read_answer(&mut Cursor::new(b"2\r\nnext\n")).unwrap(),
        Some("2".into())
    );
    assert_eq!(
        read_answer(&mut Cursor::new(b"q")).unwrap(),
        Some("q".into())
    );
    assert_eq!(read_answer(&mut Cursor::new(b"")).unwrap(), None);
    assert!(read_answer(&mut Cursor::new(vec![b'x'; 257])).is_err());
    assert!(read_answer(&mut Cursor::new([0xff, b'\n'])).is_err());
    assert_eq!(
        read_answer(&mut Cursor::new(format!("{}\r\n", "x".repeat(256))))
            .unwrap()
            .unwrap()
            .len(),
        256
    );
    let mut input = Cursor::new(b"1\n2\n");
    assert_eq!(read_answer(&mut input).unwrap(), Some("1".into()));
    assert_eq!(read_answer(&mut input).unwrap(), Some("2".into()));
}

#[tokio::test]
async fn unsafe_labels_and_oversized_answers_cannot_inject_terminal_controls_or_confirm() {
    let mut output = Vec::new();
    assert!(
        confirm(
            "up",
            "Confirm\x1b[2J",
            &["model\nline".into()],
            "Proceed",
            &mut input(&["2"]),
            &mut output,
            &CancellationToken::new()
        )
        .await
        .unwrap()
    );
    let text = String::from_utf8(output).unwrap();
    assert!(!text.contains('\x1b'));
    assert!(!text.contains("model\nline"));
    assert!(
        confirm(
            "up",
            "Confirm",
            &[],
            "Proceed",
            &mut input(&[&"2".repeat(257)]),
            &mut Vec::new(),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(
        pick_model(
            "Pick",
            &["bad\nchoice".into()],
            &mut input(&["1"]),
            &mut Vec::new(),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .try_send(Err(io::Error::other("read failure")))
        .unwrap();
    assert!(
        confirm(
            "up",
            "Confirm",
            &[],
            "Proceed",
            &mut receiver,
            &mut Vec::new(),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
}

#[test]
fn oversized_cooked_input_is_rejected_before_reading_the_entire_paste() {
    let mut input = Cursor::new(format!("{}\n2\n", "x".repeat(1_000_000)));
    let error = read_answer(&mut input).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(error.to_string(), "answer exceeds 256 bytes");
    assert_eq!(input.position(), 259);
    for ending in ["", "\n", "\r\n"] {
        let valid = "\u{e9}".repeat(128);
        assert_eq!(
            read_answer(&mut Cursor::new(format!("{valid}{ending}"))).unwrap(),
            Some(valid.clone())
        );
        let error = read_answer(&mut Cursor::new(format!("{valid}x{ending}"))).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}

#[tokio::test]
async fn picker_has_exact_cooked_output_and_retries_invalid_numbers() {
    let mut output = Vec::new();
    let result = pick_model(
        "Choose model",
        &["alpha".into(), "beta".into()],
        &mut input(&["0", "3", "2"]),
        &mut output,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result, Some(1));
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "Choose model\n1. alpha\n2. beta\nEnter a model number, or q to cancel.\nNo such model. Enter a listed number, or q to cancel.\nNo such model. Enter a listed number, or q to cancel.\n"
    );
    for lines in [vec![], vec!["q"]] {
        assert_eq!(
            pick_model(
                "Choose model",
                &["alpha".into()],
                &mut input(&lines),
                &mut Vec::new(),
                &CancellationToken::new()
            )
            .await
            .unwrap(),
            None
        );
    }
}

#[tokio::test]
async fn picker_bounds_display_but_accepts_choices_beyond_visible_page() {
    let choices: Vec<_> = (1..=30).map(|index| format!("model-{index}")).collect();
    let mut output = Vec::new();
    assert_eq!(
        pick_model(
            "Models",
            &choices,
            &mut input(&["30"]),
            &mut output,
            &CancellationToken::new()
        )
        .await
        .unwrap(),
        Some(29)
    );
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("Showing first 20 of 30 models. Enter any catalog number directly."));
    assert!(!text.contains("21. model-21"));
    assert!(
        pick_model(
            "Models",
            &[],
            &mut input(&[]),
            &mut Vec::new(),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn confirmation_only_accepts_explicit_two_and_cancellation_wins() {
    for (lines, accepted) in [
        (vec![], false),
        (vec![""], false),
        (vec!["1"], false),
        (vec!["yes"], false),
        (vec!["2"], true),
        (vec![" 2 "], true),
    ] {
        let mut output = Vec::new();
        assert_eq!(
            confirm(
                "up",
                "Confirm activation",
                &["Model: alpha".into()],
                "Activate",
                &mut input(&lines),
                &mut output,
                &CancellationToken::new()
            )
            .await
            .unwrap(),
            accepted
        );
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "rigspark / up / Accessible\nConfirm activation\nModel: alpha\n1. Cancel (default)\n2. Activate\nChoose 1 or 2, then press Enter:\n"
        );
    }
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = confirm(
        "up",
        "Confirm",
        &[],
        "Activate",
        &mut input(&["2"]),
        &mut Vec::new(),
        &cancel,
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
}
