use std::process::Command;

const HARDWARE: &str = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[{"vendor":"nvidia","vramBytes":25769803776}]}"#;

#[test]
fn catalog_refresh_is_offline_read_only_and_native() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("unused-home");
    let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
        .args(["catalog", "--refresh", "--all", "--hardware-json", HARDWARE])
        .env("PATH", "")
        .env("LOCAL_LLMUP_HOME", &home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.starts_with("Refresh (dry-run):\n  added: 0\n  updated: 0\n  removed: 0\n"));
    assert!(text.contains("No catalog file was written.\n\nCatalog (Filter: all"));
    assert!(!home.exists());
}

#[test]
fn catalog_refresh_matches_frozen_legacy_text_and_never_writes_input() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("catalog-refresh-goldens.json")).unwrap();
    for case in cases {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("catalog.json");
        let before = case["existing"].to_string();
        std::fs::write(&path, &before).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_llmup-native"));
        command
            .args(["catalog", "--refresh", "--catalog-path"])
            .arg(&path)
            .args(["--hardware-json", &case["hardware"].to_string()])
            .env("PATH", "");
        if case["all"] == true {
            command.arg("--all");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            case["expected"].as_str().unwrap()
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), before);
    }
}

#[test]
fn rejects_irrelevant_flags_instead_of_ignoring_them() {
    for args in [
        vec!["catalog", "--context", "65536"],
        vec!["doctor", "--task", "code"],
        vec!["can-run", "llama3.1:8b", "--max-context"],
        vec!["recommend", "unwanted-model"],
        vec!["recommend", "--all"],
        vec!["recommend", "--refresh"],
        vec!["chat", "--refresh", "--message", "hello"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .args(["--hardware-json", HARDWARE])
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn native_commands_work_without_node_or_runtime_mutations() {
    for args in [
        vec!["recommend", "--json", "--context", "65536"],
        vec!["can-run", "llama3.1:8b", "--json"],
        vec!["catalog", "--all"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .args(["--hardware-json", HARDWARE])
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!result.stdout.is_empty());
    }
}

#[test]
fn native_cli_rejects_unsupported_operations_and_invalid_context() {
    for args in [
        vec!["up", "test"],
        vec!["recommend", "--context", "0"],
        vec!["recommend", "--context", "65536", "--max-context"],
        vec!["can-run", "missing"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .args(["--hardware-json", HARDWARE])
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }
}
