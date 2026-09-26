use llmup_cli::accessible_read_only::{active_server_screen, run_screen};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[test]
fn accessible_reports_match_frozen_typescript_outputs() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("accessible-read-only-oracle.json")).unwrap();
    assert_eq!(cases.len(), 11);
    for case in cases {
        let text = if case["screen"] == "ls" {
            active_server_screen(&case["input"]).unwrap()
        } else {
            llmup_cli::accessible_read_only::doctor_screen(&case["input"]).unwrap()
        };
        assert_eq!(text, case["expected"].as_str().unwrap());
    }
}

#[test]
fn doctor_validation_and_document_bounds_preserve_honesty() {
    let mut report = json!({"ok":true,"checks":[],"backends":[],"hardwareScore":null});
    assert!(
        llmup_cli::accessible_read_only::doctor_screen(&report)
            .unwrap()
            .contains("Unknown (not sourced)")
    );
    report["hardwareScore"] = json!({"total":101,"sub":{"vram":20,"ram":20,"compute":20,"storage":20},"bottleneck":"ram"});
    assert!(llmup_cli::accessible_read_only::doctor_screen(&report).is_err());
    report["hardwareScore"] = json!(null);
    report["checks"] = json!([{"name":"test","status":"invented","detail":"test"}]);
    assert!(llmup_cli::accessible_read_only::doctor_screen(&report).is_err());
    report["checks"] = json!(vec![
        json!({"name":"test","status":"ok","detail":"long ".repeat(1200)});
        20
    ]);
    let text = llmup_cli::accessible_read_only::doctor_screen(&report).unwrap();
    assert!(text.len() <= 32768);
    assert!(text.contains('\u{2026}'));
    report["checks"] = json!(vec![
        json!({"name":"test","status":"ok","detail":"x"});
        1001
    ]);
    assert!(llmup_cli::accessible_read_only::doctor_screen(&report).is_err());
}

#[test]
fn active_server_screen_preserves_numbered_legacy_evidence() {
    assert_eq!(
        active_server_screen(&json!({"type":"empty"})).unwrap(),
        "local-llmup / Active Server / Accessible\n1. Status\nNo active model.\n2. Next\nlocal-llmup up <model>\n"
    );
    for owned in [true, false] {
        let report = json!({"type":"active","modelId":"llama3.1:8b","backend":"ollama","endpoint":"http://127.0.0.1:11434","port":11434,"ownedByUs":owned,"runtimeModelId":"llama3.1:8b","context":8192});
        assert_eq!(
            active_server_screen(&report).unwrap(),
            format!(
                "local-llmup / Active Server / Accessible\n1. Model\nllama3.1:8b\n2. Runtime\nBackend: ollama\nEndpoint: http://127.0.0.1:11434\nPort: 11434\nOwnership: {}\n",
                if owned { "owned" } else { "attached" }
            )
        );
    }
}

#[test]
fn doctor_projection_preserves_score_axes_and_escapes_evidence_once() {
    let report = json!({
        "ok": false,
        "checks": [{"name":"state", "status":"fail", "detail":"bad\n\u{1b}[31mstate"}],
        "backends": [{"name":"ollama", "installed":false, "version":null,
            "isDefault":false, "installHint":"run\ninstaller"}],
        "hardwareScore": {"total":73, "sub":{"vram":60,"ram":80,"compute":70,"storage":90}, "bottleneck":"vram"}
    });
    let text = llmup_cli::accessible_read_only::doctor_screen(&report).unwrap();
    for evidence in [
        "73/100",
        "VRAM 60",
        "RAM 80",
        "Compute 70",
        "Storage 90",
        "bad\\n\\u{1B}[31mstate",
        "run\\ninstaller",
    ] {
        assert!(text.contains(evidence), "missing {evidence}: {text}");
    }
    assert!(!text.contains('\u{1b}'));
    assert_eq!(
        text,
        llmup_cli::accessible_read_only::doctor_screen(&report).unwrap()
    );
}

#[test]
fn invalid_or_unsafe_report_is_rejected_before_display() {
    for report in [
        json!({}),
        json!({"type":"unknown"}),
        json!({"type":"active","modelId":"x"}),
        json!({"type":"empty","extra":true}),
    ] {
        assert!(active_server_screen(&report).is_err());
    }
    let mut report = json!({"type":"active","modelId":"x","backend":"ollama","endpoint":"http://127.0.0.1:11434","port":11434,"ownedByUs":true});
    report["modelId"] = json!("x".repeat(1024 * 1024 + 1));
    assert!(active_server_screen(&report).is_err());
    report["modelId"] = json!("x\u{1b}[2J\nspoof");
    let text = active_server_screen(&report).unwrap();
    assert!(!text.contains('\u{1b}'));
    assert!(!text.contains("\nspoof"));
    assert!(text.contains("\\u{1B}"));
}

#[tokio::test]
async fn cooked_read_only_commands_match_legacy_responses() {
    let (sender, mut input) = mpsc::channel(8);
    for line in ["?", "/search", "1", "unknown", "q"] {
        sender.try_send(Ok(line.into())).unwrap();
    }
    drop(sender);
    let mut output = Vec::new();
    run_screen(
        "screen\n",
        &mut input,
        &mut output,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "screen\nCommands: ? help; q quit\nSearch is available on model-list screens only.\nNumbered details are available on model-list screens only.\nUnknown command. Enter ? for help.\n"
    );
}

#[tokio::test]
async fn eof_cancellation_and_bounds_are_enforced() {
    let (sender, mut input) = mpsc::channel(1);
    drop(sender);
    run_screen(
        "screen\n",
        &mut input,
        &mut Vec::new(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let (sender, mut input) = mpsc::channel(1);
    sender.try_send(Ok("q".into())).unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        run_screen("screen\n", &mut input, &mut Vec::new(), &cancel)
            .await
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::Interrupted
    );
    let mut output = Vec::new();
    assert!(
        run_screen(
            &"x".repeat(32769),
            &mut input,
            &mut output,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(output.is_empty());
}
