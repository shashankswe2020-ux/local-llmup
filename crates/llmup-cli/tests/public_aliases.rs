use std::process::{Command, Output, Stdio};

const HARDWARE: &str = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[{"vendor":"nvidia","vramBytes":25769803776}]}"#;

#[test]
fn both_public_targets_include_the_same_native_implementation() {
    for source in [
        include_str!("../src/llmup.rs"),
        include_str!("../src/local_llmup.rs"),
    ] {
        assert_eq!(source.trim(), "include!(\"native.rs\");");
    }
}

fn binaries() -> [&'static str; 2] {
    [
        env!("CARGO_BIN_EXE_llmup"),
        env!("CARGO_BIN_EXE_local-llmup"),
    ]
}

fn invoke(binary: &str, args: &[&str]) -> Output {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("unused");
    let output = Command::new(binary)
        .args(args)
        .current_dir(directory.path())
        .env("LOCAL_LLMUP_HOME", &home)
        .env("PATH", "")
        .env("TERM", "dumb")
        .env_remove("LOCAL_LLMUP_TUI")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{binary} {args:?}: {output:?}");
    assert!(!home.exists(), "advice must not create state");
    assert!(output.stderr.is_empty(), "{output:?}");
    output
}

#[test]
fn public_aliases_show_help_without_node() {
    for binary in binaries() {
        let output = invoke(binary, &["--help"]);
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("local-llmup"));
        assert!(help.contains("recommend"));
        assert!(help.contains("gui"));
        assert!(!help.contains("llmup-native"));
        assert!(!help.contains("Experimental"));
    }
}

#[test]
fn public_aliases_and_internal_binary_report_public_version_without_node() {
    for binary in binaries()
        .into_iter()
        .chain([env!("CARGO_BIN_EXE_llmup-native")])
    {
        let output = invoke(binary, &["--version"]);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("local-llmup {}\n", env!("CARGO_PKG_VERSION"))
        );
    }
}

#[test]
fn public_aliases_default_to_identical_offline_json_recommendations_without_node() {
    let expected: serde_json::Value = serde_json::from_slice(
        &invoke(
            env!("CARGO_BIN_EXE_llmup-native"),
            &["recommend", "--json", "--hardware-json", HARDWARE],
        )
        .stdout,
    )
    .unwrap();
    assert!(expected.is_object());
    for binary in binaries() {
        for args in [
            vec!["--json", "--hardware-json", HARDWARE],
            vec!["recommend", "--json", "--hardware-json", HARDWARE],
        ] {
            let observed: serde_json::Value =
                serde_json::from_slice(&invoke(binary, &args).stdout).unwrap();
            assert_eq!(observed, expected);
        }
    }
}
