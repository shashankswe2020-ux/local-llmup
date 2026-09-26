use std::process::Command;

fn public_aliases() -> [&'static str; 2] {
    [
        env!("CARGO_BIN_EXE_llmup"),
        env!("CARGO_BIN_EXE_local-llmup"),
    ]
}

#[test]
fn native_ls_is_read_only_and_reports_empty_state_without_runtime_tools() {
    let home = std::env::temp_dir().join(format!("llmup-native-ls-{}", std::process::id()));
    assert!(!home.exists());
    let result = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
        .args(["ls", "--json"])
        .env("LOCAL_LLMUP_HOME", &home)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(json["type"], "empty");
    assert!(!home.exists());
}
#[test]
fn native_lifecycle_validates_flags_before_starting_work() {
    for args in [
        vec!["up", "test", "--port", "0"],
        vec!["down", "--bypass"],
        vec!["ls", "--context", "8192"],
        vec!["up", "test", "--context", "1.5"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }
}

#[test]
fn empty_down_needs_no_hardware_or_runtime_and_creates_no_state() {
    let home = std::env::temp_dir().join(format!("llmup-native-down-{}", std::process::id()));
    assert!(!home.exists());
    let result = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
        .args(["down", "--json"])
        .env("LOCAL_LLMUP_HOME", &home)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!home.exists());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()["type"],
        "no-active"
    );
}

#[test]
fn public_empty_down_is_unchanged_by_yes_and_creates_no_state() {
    for binary in public_aliases() {
        let mut outputs = Vec::new();
        for args in [vec!["down"], vec!["down", "--yes"]] {
            let directory = tempfile::tempdir().unwrap();
            let home = directory.path().join("unused");
            let output = Command::new(binary)
                .args(args)
                .env("LOCAL_LLMUP_HOME", &home)
                .env("PATH", "")
                .env("TERM", "dumb")
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(0), "{binary}");
            assert!(output.stderr.is_empty(), "{binary}: {output:?}");
            assert!(!home.exists(), "{binary}");
            outputs.push(output.stdout);
        }
        assert_eq!(outputs[0], b"No active server to stop.\n");
        assert_eq!(outputs[1], outputs[0]);
    }
}

#[test]
fn public_down_target_mismatch_preserves_owned_and_attached_state() {
    for binary in public_aliases() {
        for owned_by_us in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let state = home.path().join("state.json");
            let bytes = format!(
                r#"{{"schemaVersion":2,"active":{{"backend":"ollama","modelId":"unknown:latest","endpoint":"http://127.0.0.1:11435","port":11435,"ownedByUs":{owned_by_us},"pid":123,"processExecutable":"/trusted/ollama","processStartedAt":"instance"}}}}"#
            );
            std::fs::write(&state, &bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o600)).unwrap();
            }

            let output = Command::new(binary)
                .args(["down", " LLAMA3.1:8B "])
                .env("LOCAL_LLMUP_HOME", home.path())
                .env("PATH", "")
                .output()
                .unwrap();

            assert_eq!(output.status.code(), Some(1), "{binary}");
            assert!(output.stdout.is_empty(), "{binary}");
            let stderr = String::from_utf8(output.stderr).unwrap();
            assert!(
                stderr.contains("llama3.1:8b is not the active model (unknown:latest)"),
                "{stderr}"
            );
            assert!(!stderr.contains('\u{1b}'), "{stderr}");
            assert_eq!(std::fs::read(&state).unwrap(), bytes.as_bytes());
            assert!(!home.path().join("lock").exists());
        }
    }
}

#[test]
fn down_forget_clears_only_attached_pointers_without_runtime_tools() {
    for owned_by_us in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state.json");
        let bytes = format!(
            r#"{{"schemaVersion":2,"active":{{"backend":"ollama","modelId":"qwen3:30b-a3b","endpoint":"http://127.0.0.1:11435","port":11435,"ownedByUs":{owned_by_us},"pid":123,"processExecutable":"/trusted/ollama","processStartedAt":"instance"}}}}"#
        );
        std::fs::write(&state, &bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let output = Command::new(env!("CARGO_BIN_EXE_llmup"))
            .args(["down", "--forget", "--json"])
            .env("LOCAL_LLMUP_HOME", home.path())
            .env("PATH", "")
            .output()
            .unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        if owned_by_us {
            assert_eq!(output.status.code(), Some(1));
            assert!(stderr.contains("owned by local-llmup"), "{stderr}");
            assert_eq!(std::fs::read(&state).unwrap(), bytes.as_bytes());
        } else {
            assert_eq!(output.status.code(), Some(0), "{stderr}");
            let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(json["type"], "forgotten");
            assert_eq!(json["modelId"], "qwen3:30b-a3b");
            let after: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
            assert!(after["active"].is_null(), "{after}");
        }
        assert!(!home.path().join("lock").exists());
    }
    for args in [
        vec!["down", "llama3.1:8b", "--forget"],
        vec!["up", "llama3.1:8b", "--forget"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_llmup"))
            .args(&args)
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
    }
}

#[test]
fn doctor_reports_corrupt_state_without_rewriting_it() {
    let home = std::env::temp_dir().join(format!("llmup-native-doctor-{}", std::process::id()));
    std::fs::create_dir(&home).unwrap();
    let state = home.join("state.json");
    std::fs::write(&state, b"{broken").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let hardware = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[]}"#;
    for json in [false, true] {
        let mut args = vec!["doctor", "--hardware-json", hardware];
        if json {
            args.push("--json");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .env("LOCAL_LLMUP_HOME", &home)
            .env("PATH", "")
            .env("TERM", "dumb")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stderr.is_empty());
        assert!(!output.stdout.contains(&0x1b));
        if json {
            let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["ok"], false);
            assert!(
                report["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|check| check["name"] == "state" && check["status"] == "fail")
            );
        } else {
            let text = String::from_utf8(output.stdout).unwrap();
            assert!(text.contains("state"), "{text}");
            assert!(text.contains("fail"), "{text}");
        }
        assert_eq!(std::fs::read(&state).unwrap(), b"{broken");
    }
    std::fs::remove_dir_all(home).unwrap();
}
