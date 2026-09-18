use std::process::Command;
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
    let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
        .args(["doctor", "--json", "--hardware-json", hardware])
        .env("LOCAL_LLMUP_HOME", &home)
        .env("PATH", "")
        .output()
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!output.status.success());
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["name"] == "state" && check["status"] == "fail")
    );
    assert_eq!(std::fs::read(&state).unwrap(), b"{broken");
    std::fs::remove_dir_all(home).unwrap();
}
