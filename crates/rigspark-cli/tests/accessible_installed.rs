use rigspark_cli::accessible_installed as implementation;
use rigspark_cli::accessible_installed::{
    InstalledCommand, InstalledOutcome, build_installed, run_installed,
};
use rigspark_core::sizing::Hardware;
use rigspark_runtime::ollama_installed::{InstalledModel, size_installed};
use serde_json::{Value, json};
use std::io::{self, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn report() -> Value {
    json!({"source":"local-runtime-metadata", "models":[{
        "id":"local:small", "digest":"a".repeat(64), "sizeBytes":1073741824,
        "quant":"Q4_K_M", "contextLength":8192, "kvBytesPerToken":1024,
        "capabilities":["completion"], "context":4096, "fit":"yes",
        "weightsFit":true, "requiredBytes":1077936128.0,
        "usableBytes":7301444403.2, "memoryKind":"ram",
        "evidence":"local-runtime-metadata", "throughput":"unknown"
    }]})
}

async fn transcript(report: &Value, command: InstalledCommand, lines: &[&str]) -> String {
    let view = build_installed(report, command).unwrap();
    let (sender, mut receiver) = mpsc::channel(lines.len().max(1));
    for line in lines {
        sender.send(Ok((*line).into())).await.unwrap();
    }
    drop(sender);
    let mut output = Vec::new();
    assert_eq!(
        run_installed(&view, &mut receiver, &mut output, &CancellationToken::new())
            .await
            .unwrap(),
        InstalledOutcome::Exited
    );
    String::from_utf8(output).unwrap()
}

#[tokio::test]
async fn representative_report_preserves_all_native_evidence() {
    let report = report();
    let before = report.clone();
    let output = transcript(&report, InstalledCommand::Recommend, &["1", "?", "q"]).await;
    for expected in [
        "Recommend / Installed / Accessible",
        "Source: local-runtime-metadata",
        "1. local:small; fit yes",
        "Details: local:small",
        "Quantization: Q4_K_M",
        "Context: 4096 tokens",
        "Model context limit: 8192 tokens",
        "KV cache: 1024 bytes/token",
        "Weights: 1073741824 bytes; fit yes",
        "Required memory: 1077936128 bytes",
        "Usable memory: 7301444403.2 bytes",
        "Memory kind: ram",
        "Evidence: local-runtime-metadata",
        "Throughput: unknown",
        "Capabilities: completion",
        "Digest (reported, not verified):",
    ] {
        assert!(output.contains(expected), "missing {expected}: {output}");
    }
    assert_eq!(report, before);
    assert!(!output.contains("tok/s"));
}

#[test]
fn accepts_reports_from_the_actual_native_sizing_producer() {
    let hardware: Hardware = serde_json::from_value(json!({
        "platform":"darwin", "arch":"arm64",
        "totalRamBytes":17179869184_u64, "freeRamBytes":8589934592_u64,
        "freeDiskBytes":107374182400_u64, "gpu":[]
    }))
    .unwrap();
    let mut model = InstalledModel {
        id: "uncatalogued:local".into(),
        digest: "b".repeat(64),
        size_bytes: 1073741824,
        quant: None,
        context_length: Some(8192),
        kv_bytes_per_token: Some(1024),
        capabilities: vec![],
    };
    for (context, expected) in [(None, "unknown"), (Some(4096), "yes"), (Some(9000), "no")] {
        let sized = size_installed(&model, &hardware, context).unwrap();
        assert_eq!(sized["fit"], expected);
        let report = json!({"source":"local-runtime-metadata", "models":[sized]});
        let view = build_installed(&report, InstalledCommand::CanRun).unwrap();
        assert!(view.format().contains(&format!("Fit: {expected}")));
    }
    model.kv_bytes_per_token = None;
    let sized = size_installed(&model, &hardware, Some(4096)).unwrap();
    let report = json!({"source":"local-runtime-metadata", "models":[sized]});
    let screen = build_installed(&report, InstalledCommand::CanRun)
        .unwrap()
        .format();
    assert!(screen.contains("Fit: unknown"));
    assert!(screen.contains("Required memory: unknown"));
    assert!(screen.contains("KV cache: unknown"));
}

#[tokio::test]
async fn unknown_metadata_is_not_replaced_with_catalog_or_invented_evidence() {
    let report = json!({"models":[{"id":"uncatalogued:custom", "fit":"no"}]});
    let output = transcript(
        &report,
        InstalledCommand::CanRun,
        &["?", "1", "/custom", "p", "q"],
    )
    .await;
    for expected in [
        "Source: unknown",
        "Fit: no",
        "Quantization: unknown",
        "Required memory: unknown",
        "Weights: unknown; fit unknown",
        "Evidence: unknown",
        "Throughput: unknown",
        "Capabilities: unknown",
        "Context: unknown",
        "Digest (reported, not verified): unknown",
    ] {
        assert!(output.contains(expected), "missing {expected}");
    }
    assert_eq!(output.matches("Unknown command.").count(), 3);
    assert!(!output.contains("rank"));
    assert!(!output.contains("rigspark up"));
}

#[tokio::test]
async fn search_details_reset_and_cooked_lines_use_current_visible_numbering() {
    let mut report = report();
    let mut second = report["models"][0].clone();
    second["id"] = json!("other:large");
    second["fit"] = json!("no");
    report["models"].as_array_mut().unwrap().push(second);
    let output = transcript(
        &report,
        InstalledCommand::Recommend,
        &[
            "/OTHER\r\n",
            "1\n",
            "2",
            "/missing",
            "1",
            "/",
            "2",
            "0",
            "21",
            "p",
            "q\n",
            "?",
        ],
    )
    .await;
    assert!(output.contains("Filter: OTHER\n1. other:large; fit no"));
    assert!(output.contains("Details: other:large"));
    assert!(output.contains("Filter: missing\nNo results"));
    assert!(output.contains("Filter: off\n1. local:small; fit yes\n2. other:large; fit no"));
    assert_eq!(output.matches("No such result.").count(), 3);
    assert_eq!(output.matches("Commands:").count(), 1);
}

#[tokio::test]
async fn empty_inventory_and_single_target_cardinality_are_explicit() {
    for command in [InstalledCommand::Recommend, InstalledCommand::CanRun] {
        let output = transcript(
            &json!({"source":"local-runtime-metadata", "models":[]}),
            command,
            &["?", "q"],
        )
        .await;
        assert!(output.contains("No installed models match."));
    }
    let mut report = report();
    report["models"] = json!([report["models"][0].clone(), report["models"][0].clone()]);
    assert!(build_installed(&report, InstalledCommand::CanRun).is_err());
}

#[tokio::test]
async fn untrusted_fields_are_escaped_without_terminal_controls() {
    let mut report = report();
    report["source"] = json!("source\n\u{1b}[2J");
    let model = &mut report["models"][0];
    model["id"] = json!("unsafe\n\u{1b}[2J\u{202e}");
    model["quant"] = json!("q\r\n\u{7}");
    model["digest"] = json!("digest\u{1b}");
    model["evidence"] = json!("source\u{202e}");
    model["capabilities"] = json!(["chat\t\u{1b}"]);
    let output = transcript(
        &report,
        InstalledCommand::Recommend,
        &["1", "/\u{1b}[2J", "q"],
    )
    .await;
    assert!(output.contains("unsafe\\u{A}\\u{1B}"));
    assert!(output.contains("q\\n\\u{7}"));
    assert!(output.contains("\\u{202E}"));
    assert!(!output.contains(['\u{1b}', '\u{7}', '\u{202e}', '\r', '\t']));
}

#[test]
fn malformed_and_oversized_reports_fail_closed() {
    for bad in [
        json!(null),
        json!({}),
        json!({"models":{}}),
        json!({"models":[{}]}),
        json!({"models":[{"id":""}]}),
    ] {
        assert!(build_installed(&bad, InstalledCommand::Recommend).is_err());
    }
    for (field, value) in [
        ("sizeBytes", json!(-1)),
        ("requiredBytes", json!(-1)),
        ("usableBytes", json!("large")),
        ("fit", json!("slow")),
        ("weightsFit", json!("true")),
        ("context", json!(0)),
        ("context", json!(10000001)),
        ("memoryKind", json!("disk")),
        ("throughput", json!(123)),
        ("capabilities", json!([false])),
    ] {
        let mut report = report();
        report["models"][0][field] = value;
        assert!(
            build_installed(&report, InstalledCommand::Recommend).is_err(),
            "{field}"
        );
    }
    let mut report = report();
    let model = report["models"][0].clone();
    report["models"] = json!(vec![model.clone(); implementation::MAX_ITEMS + 1]);
    assert!(build_installed(&report, InstalledCommand::Recommend).is_err());
    report["models"] = json!([model]);
    report["models"][0]["quant"] = json!("x".repeat(implementation::MAX_TEXT_BYTES + 1));
    assert!(build_installed(&report, InstalledCommand::Recommend).is_err());
    let mut nested = Value::Null;
    for _ in 0..20 {
        nested = json!([nested]);
    }
    report["models"] = json!([]);
    report["extra"] = nested;
    assert!(build_installed(&report, InstalledCommand::Recommend).is_err());
    report["extra"] = json!(vec![vec![Value::Null; 1000]; 101]);
    assert!(build_installed(&report, InstalledCommand::Recommend).is_err());
    report["extra"] = json!(vec!["x".repeat(implementation::MAX_TEXT_BYTES); 5]);
    assert!(build_installed(&report, InstalledCommand::Recommend).is_err());
}

#[tokio::test]
async fn bounded_rows_remain_searchable_and_large_details_are_bounded() {
    let mut report = report();
    let model = report["models"][0].clone();
    report["models"] = json!(
        (0..25)
            .map(|index| {
                let mut entry = model.clone();
                entry["id"] = json!(format!("model:{index}"));
                entry["capabilities"] = json!(vec!["x".repeat(1000); 100]);
                entry
            })
            .collect::<Vec<_>>()
    );
    let view = build_installed(&report, InstalledCommand::Recommend).unwrap();
    assert!(view.format().contains("Showing first 20 of 25"));
    assert!(!view.format().contains("21. model:"));
    assert!(view.format().len() <= implementation::MAX_DOCUMENT_BYTES);
    let output = transcript(
        &report,
        InstalledCommand::Recommend,
        &["21", "/model:24", "1", "q"],
    )
    .await;
    assert!(output.contains("No such result."));
    assert!(output.contains("Details: model:24"));
    assert!(output.contains("+80 more capabilities"));
    assert!(output.len() < implementation::MAX_DOCUMENT_BYTES * 3);
}

#[tokio::test]
async fn cancellation_eof_and_input_errors_are_observable() {
    let view = build_installed(&report(), InstalledCommand::Recommend).unwrap();
    let (sender, mut receiver) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut output = Vec::new();
    assert_eq!(
        run_installed(&view, &mut receiver, &mut output, &cancel)
            .await
            .unwrap(),
        InstalledOutcome::Cancelled
    );
    assert!(output.is_empty());
    sender
        .send(Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "input failed",
        )))
        .await
        .unwrap();
    let error = run_installed(&view, &mut receiver, &mut output, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    sender
        .send(Ok("x".repeat(implementation::MAX_INPUT_BYTES + 1)))
        .await
        .unwrap();
    assert!(
        run_installed(&view, &mut receiver, &mut output, &CancellationToken::new())
            .await
            .is_err()
    );
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let (_, result) = tokio::join!(
        async move {
            tokio::task::yield_now().await;
            trigger.cancel();
        },
        run_installed(&view, &mut receiver, &mut output, &cancel)
    );
    assert_eq!(result.unwrap(), InstalledOutcome::Cancelled);
    drop(sender);
    assert_eq!(
        run_installed(&view, &mut receiver, &mut output, &CancellationToken::new())
            .await
            .unwrap(),
        InstalledOutcome::Exited
    );
}

struct BrokenOutput {
    fail_flush: bool,
}
impl Write for BrokenOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.fail_flush {
            Ok(bytes.len())
        } else {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::BrokenPipe.into())
    }
}

#[tokio::test]
async fn write_and_flush_errors_propagate() {
    let view = build_installed(&report(), InstalledCommand::CanRun).unwrap();
    let (_sender, mut receiver) = mpsc::channel(1);
    for fail_flush in [false, true] {
        let error = run_installed(
            &view,
            &mut receiver,
            &mut BrokenOutput { fail_flush },
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }
}

#[test]
fn visual_projection_preserves_accessible_reports_and_inventory_bounds() {
    use rigspark_cli::tui_models::ModelView;

    for command in [InstalledCommand::Recommend, InstalledCommand::CanRun] {
        let installed = build_installed(&report(), command).unwrap();
        let before = installed.format();
        let view = ModelView::from_installed(&installed, false).unwrap();
        assert_eq!(view.visible_count(), 1);
        assert_eq!(installed.format(), before);
    }
    let models: Vec<_> = (0..implementation::MAX_ITEMS)
        .map(|index| json!({"id":format!("local:{index}")}))
        .collect();
    let mut report = json!({"models":models});
    let installed = build_installed(&report, InstalledCommand::Recommend).unwrap();
    let view = ModelView::from_installed(&installed, false).unwrap();
    assert_eq!(view.visible_count(), implementation::MAX_ITEMS);

    for model in report["models"].as_array_mut().unwrap() {
        model["capabilities"] = json!(vec!["x".repeat(100); implementation::MAX_ROWS]);
    }
    let installed = build_installed(&report, InstalledCommand::Recommend).unwrap();
    assert!(installed.format().len() <= implementation::MAX_DOCUMENT_BYTES);
    assert!(ModelView::from_installed(&installed, false).is_err());
}
