use llmup_cli::accessible_recommend::{
    MAX_DOCUMENT_BYTES, RecommendOutcome, Recommendation, build_recommendation, run_recommendation,
};
use llmup_core::{
    catalog::{Catalog, PerfDataset},
    ranking::{AdviceOptions, recommend},
    reports::recommendation_text,
    sizing::Hardware,
};
use serde_json::Value;
use std::io::{self, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn oracle() -> Value {
    serde_json::from_str(include_str!("accessible-recommend-oracle.json")).unwrap()
}

fn inputs() -> (Catalog, Hardware, PerfDataset) {
    let fixture = oracle();
    (
        serde_json::from_value(fixture["cases"][0]["catalog"].clone()).unwrap(),
        serde_json::from_value(fixture["cases"][0]["hardware"].clone()).unwrap(),
        PerfDataset::parse(&fixture["perf"].to_string()).unwrap(),
    )
}

async fn session(screen: &Recommendation, lines: &[&str]) -> (RecommendOutcome, String) {
    let (sender, mut receiver) = mpsc::channel(lines.len().max(1));
    for line in lines {
        sender.try_send(Ok((*line).into())).unwrap();
    }
    drop(sender);
    let mut output = Vec::new();
    let outcome = run_recommendation(
        screen,
        &mut receiver,
        &mut output,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    (outcome, String::from_utf8(output).unwrap())
}

#[test]
fn matches_independent_retained_typescript_screens() {
    let fixture = oracle();
    assert_eq!(fixture["cases"].as_array().unwrap().len(), 12);
    for case in fixture["cases"].as_array().unwrap() {
        let catalog: Catalog = serde_json::from_value(case["catalog"].clone()).unwrap();
        let hardware: Hardware = serde_json::from_value(case["hardware"].clone()).unwrap();
        let perf = PerfDataset::parse(&case["perf"].to_string()).unwrap();
        let options: AdviceOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let screen = build_recommendation(&catalog, &hardware, &perf, &options).unwrap();
        let ordinary_report = recommend(&catalog, &hardware, &perf, &options).unwrap();
        assert_eq!(
            screen.final_text(),
            recommendation_text(&ordinary_report, &options),
            "final text: {}",
            case["name"]
        );
        assert_eq!(
            screen.format(),
            case["screen"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[tokio::test]
async fn matches_independent_search_details_help_and_print_transcripts() {
    let fixture = oracle();
    for case in fixture["cases"].as_array().unwrap() {
        let catalog: Catalog = serde_json::from_value(case["catalog"].clone()).unwrap();
        let hardware = serde_json::from_value(case["hardware"].clone()).unwrap();
        let perf = PerfDataset::parse(&case["perf"].to_string()).unwrap();
        let options = serde_json::from_value(case["options"].clone()).unwrap();
        let screen = build_recommendation(&catalog, &hardware, &perf, &options).unwrap();
        let lines: Vec<_> = case["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap())
            .collect();
        let (outcome, transcript) = session(&screen, &lines).await;
        assert_eq!(
            transcript,
            case["transcript"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        let expected = match case["outcome"]["command"].as_str() {
            Some(command) => RecommendOutcome::PrintCommand {
                command: command.into(),
            },
            None => RecommendOutcome::Exited,
        };
        assert_eq!(outcome, expected, "{}", case["name"]);
    }
}

#[tokio::test]
async fn quit_and_eof_return_without_printing_a_suggestion() {
    let (catalog, hardware, perf) = inputs();
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    for lines in [vec![], vec!["q", "p"]] {
        let (outcome, output) = session(&screen, &lines).await;
        assert_eq!(outcome, RecommendOutcome::Exited);
        assert_eq!(output, screen.format());
        assert!(!output.contains("local-llmup up"));
    }
}

#[tokio::test]
async fn unsafe_or_truncated_suggestions_are_never_offered() {
    let (mut catalog, hardware, perf) = inputs();
    catalog.models.truncate(1);
    for id in [
        "-flag",
        "../escape",
        "org/../model",
        "bad name",
        "bad;command",
        "model;echo injected",
        "bad\ncommand",
        "bad\u{202e}command",
        &"a".repeat(256),
    ] {
        catalog.models[0].id = id.into();
        let screen =
            build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
        assert!(!screen.final_text().contains("Run the top pick:"), "{id:?}");
        assert!(!screen.final_text().contains("local-llmup up "), "{id:?}");
        let (outcome, output) = session(&screen, &["?", "p", "q"]).await;
        assert_eq!(outcome, RecommendOutcome::Exited, "{id:?}");
        assert!(!output.contains("p finish"), "{id:?}");
        assert!(output.contains("Unknown command."));
        assert!(!output.contains('\u{1b}'));
        assert!(!output.contains('\u{202e}'));
    }
}

#[tokio::test]
async fn final_text_and_print_action_agree_at_the_command_length_boundary() {
    let (mut catalog, hardware, perf) = inputs();
    catalog.models.truncate(1);
    for length in [256, 257] {
        let id = "a".repeat(length - "local-llmup up ".len());
        catalog.models[0].id = id.clone();
        let screen =
            build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
        let (outcome, _) = session(&screen, &["p", "q"]).await;
        if length == 256 {
            let command = format!("local-llmup up {id}");
            assert!(
                screen
                    .final_text()
                    .ends_with(&format!("Run the top pick:  {command}"))
            );
            assert_eq!(outcome, RecommendOutcome::PrintCommand { command });
        } else {
            assert!(!screen.final_text().contains("Run the top pick:"));
            assert_eq!(outcome, RecommendOutcome::Exited);
        }
    }
}

#[tokio::test]
async fn cancellation_wins_over_queued_print_and_interrupts_idle_input() {
    let (catalog, hardware, perf) = inputs();
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    let (sender, mut receiver) = mpsc::channel(1);
    sender.try_send(Ok("p".into())).unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let mut output = Vec::new();
    assert_eq!(
        run_recommendation(&screen, &mut receiver, &mut output, &cancellation)
            .await
            .unwrap(),
        RecommendOutcome::Cancelled
    );
    assert!(output.is_empty());
    assert_eq!(receiver.try_recv().unwrap().unwrap(), "p");

    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let signal = tokio::spawn(async move {
        tokio::task::yield_now().await;
        cancel.cancel();
    });
    assert_eq!(
        run_recommendation(&screen, &mut receiver, &mut output, &cancellation)
            .await
            .unwrap(),
        RecommendOutcome::Cancelled
    );
    signal.await.unwrap();
    assert_eq!(String::from_utf8(output).unwrap(), screen.format());
}

struct BrokenWriter;
impl Write for BrokenWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn propagates_input_output_and_flush_errors() {
    let (catalog, hardware, perf) = inputs();
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .try_send(Err(io::Error::new(io::ErrorKind::InvalidData, "bad input")))
        .unwrap();
    let token = CancellationToken::new();
    assert_eq!(
        run_recommendation(&screen, &mut receiver, &mut Vec::new(), &token)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        run_recommendation(&screen, &mut receiver, &mut BrokenWriter, &token)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::BrokenPipe
    );
    struct FlushError;
    impl Write for FlushError {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "flush closed"))
        }
    }
    assert_eq!(
        run_recommendation(&screen, &mut receiver, &mut FlushError, &token)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::BrokenPipe
    );
}

#[tokio::test]
async fn search_and_details_are_case_insensitive_and_preserve_original_rank() {
    let (catalog, hardware, perf) = inputs();
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    let (_, output) = session(
        &screen,
        &[
            "/UNKNOWN",
            "1",
            "/not-found",
            "1",
            "/",
            "0",
            "01",
            "1000",
            "999",
        ],
    )
    .await;
    assert!(output.contains("Filter: UNKNOWN\n1. unknown:geometry; rank "));
    assert!(output.contains("Details: unknown:geometry"));
    assert!(output.contains("Filter: not-found\nNo results\nNo such result.\n"));
    assert!(output.contains("Filter: off\n"));
    assert_eq!(output.matches("Unknown command.").count(), 3);
    for query in ["/ollama", "/chat", "/yes"] {
        let (_, output) = session(&screen, &[query]).await;
        assert!(!output.contains("No results"), "{query}");
    }
}

#[tokio::test]
async fn rows_and_documents_are_bounded_but_later_numbered_items_remain_reachable() {
    let (mut catalog, hardware, perf) = inputs();
    let model = catalog.models[0].clone();
    catalog.models = (0..25)
        .map(|index| {
            let mut entry = model.clone();
            entry.id = format!("model:{index:03}");
            entry
        })
        .collect();
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    let initial = screen.format();
    assert!(initial.contains("Showing first 20 of 25; use /text to refine."));
    assert!(!initial.contains("21. model:"));
    let (_, output) = session(&screen, &["/", "21"]).await;
    assert!(output.contains("refine search for more."));
    assert!(output.contains("Details: model:020\n21. model:020; rank 21;"));
    for model in &mut catalog.models {
        model.capabilities = vec!["a".repeat(256); 100];
    }
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    assert!(screen.format().len() <= MAX_DOCUMENT_BYTES);
    assert!(
        screen
            .format()
            .ends_with("[output bounded; refine the search or inspect a numbered item for more]\n")
    );
}

#[test]
fn limits_nonfitting_rows_and_rejects_oversized_or_invalid_inputs() {
    let (mut catalog, hardware, perf) = inputs();
    let model = catalog.models.last().unwrap().clone();
    catalog.models = (0..25)
        .map(|index| {
            let mut entry = model.clone();
            entry.id = format!("large:{index}");
            entry
        })
        .collect();
    let screen = build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default())
        .unwrap()
        .format();
    assert!(screen.contains("Showing first 20 of 25; use catalog --all to inspect the rest."));
    assert!(!screen.contains("p finish"));
    catalog.models = vec![model.clone(); 1001];
    assert!(build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).is_err());
    catalog.models = vec![model];
    catalog.models[0].capabilities = vec!["chat".into(); 1001];
    assert!(build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).is_err());
    let (mut catalog, mut hardware, perf) = inputs();
    catalog.models[0].license = "a".repeat(1024 * 1024 + 1);
    assert!(build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).is_err());
    catalog.models.clear();
    hardware.total_ram_bytes = f64::NAN;
    assert!(build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).is_err());
}

#[test]
fn unknown_throughput_and_geometry_are_explicit_and_remain_ranked() {
    let fixture = oracle();
    let cases = fixture["cases"].as_array().unwrap();
    let unknown = cases
        .iter()
        .find(|case| case["name"] == "unknown-throughput")
        .unwrap();
    assert!(
        unknown["screen"]
            .as_str()
            .unwrap()
            .contains("throughput unknown; unknown reason no-sourced-performance-profile")
    );
    assert!(
        unknown["screen"]
            .as_str()
            .unwrap()
            .contains("source offline-estimate; no-sourced-performance-profile")
    );
    for (name, evidence) in [
        ("context", "KV cache unknown"),
        ("maximum", "maximum context unknown"),
    ] {
        let case = cases.iter().find(|case| case["name"] == name).unwrap();
        let screen = case["screen"].as_str().unwrap();
        assert!(screen.contains("unknown:geometry; rank"));
        assert!(screen.contains(evidence));
    }
}

#[tokio::test]
async fn bounds_and_escapes_cooked_input() {
    let (catalog, hardware, perf) = inputs();
    let screen =
        build_recommendation(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    let (_, output) = session(
        &screen,
        &[
            "/\u{1b}[2J\u{202e}",
            &format!("/{}", "x".repeat(5000)),
            "?",
            "q",
        ],
    )
    .await;
    assert!(!output.contains('\u{1b}'));
    assert!(!output.contains('\u{202e}'));
    assert!(!output.contains(&"x".repeat(257)));
    let (sender, mut receiver) = mpsc::channel(1);
    sender.try_send(Ok("x".repeat(1024 * 1024 + 1))).unwrap();
    assert!(
        run_recommendation(
            &screen,
            &mut receiver,
            &mut Vec::new(),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
}
