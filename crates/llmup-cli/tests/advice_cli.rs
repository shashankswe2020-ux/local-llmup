use std::process::Command;

const HARDWARE: &str = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[{"vendor":"nvidia","vramBytes":25769803776}]}"#;

#[test]
fn rejects_irrelevant_flags_instead_of_ignoring_them() {
    for args in [
        vec!["catalog", "--context", "65536"],
        vec!["doctor", "--task", "code"],
        vec!["can-run", "llama3.1:8b", "--max-context"],
        vec!["recommend", "unwanted-model"],
        vec!["recommend", "--all"],
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
