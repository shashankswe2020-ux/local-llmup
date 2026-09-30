use std::process::Command;

#[test]
fn catalog_status_is_offline_and_does_not_create_state() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let output = Command::new(env!("CARGO_BIN_EXE_rigspark"))
        .args(["catalog", "--status"])
        .env("RIGSPARK_HOME", &home)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("Source: bundled"));
    assert!(text.contains("Generated:"));
    assert!(text.contains("Digest:"));
    assert!(!home.exists());
}

#[test]
fn update_options_reject_conflicts_before_creating_state() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    for args in [
        vec!["recommend", "--update"],
        vec!["gui", "--update"],
        vec!["catalog", "--update", "--refresh"],
        vec!["catalog", "--update", "--status"],
        vec!["catalog", "--update", "--catalog-path", "missing.json"],
        vec!["catalog", "--status", "--all"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_rigspark"))
            .args(&args)
            .env("RIGSPARK_HOME", &home)
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(!home.exists());
    }
}

#[test]
fn catalog_help_distinguishes_network_update_from_offline_refresh() {
    let output = Command::new(env!("CARGO_BIN_EXE_rigspark"))
        .args(["catalog", "--help"])
        .output()
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("--update"));
    assert!(text.contains("--status"));
    assert!(text.contains("--refresh"));
}
