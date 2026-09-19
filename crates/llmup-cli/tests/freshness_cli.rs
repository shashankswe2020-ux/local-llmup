use std::{fs, process::Command};

fn command(root: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-freshness"));
    command
        .current_dir(root)
        .env("PATH", "")
        .env_remove("GITHUB_STEP_SUMMARY");
    command
}

fn fixture(root: &std::path::Path) -> String {
    fs::create_dir(root.join("data")).unwrap();
    let catalog = include_str!("../../../data/models.json");
    fs::write(root.join("data/models.json"), catalog).unwrap();
    catalog.into()
}

#[test]
fn offline_freshness_writes_reports_without_modifying_catalog() {
    let root = tempfile::tempdir().unwrap();
    let before = fixture(root.path());
    let summary = root.path().join("summary.md");
    fs::write(&summary, "Existing summary\n").unwrap();
    let output = command(root.path())
        .args(["--now", "2026-09-18T00:00:00Z", "--json"])
        .env("GITHUB_STEP_SUMMARY", &summary)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(root.path().join("catalog-freshness.json")).unwrap(),
        output.stdout
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["drift"]["added"], 0);
    assert_eq!(report["hasDrift"], false);
    let human = String::from_utf8(output.stderr).unwrap();
    assert!(human.starts_with("Catalog freshness\n"));
    assert_eq!(
        fs::read_to_string(summary).unwrap(),
        format!("Existing summary\n### Catalog freshness\n\n```\n{human}```\n")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("data/models.json")).unwrap(),
        before
    );
    let repeat = command(root.path()).output().unwrap();
    assert!(repeat.status.success());
    assert!(repeat.stdout.is_empty());
}

#[test]
fn custom_paths_read_the_current_catalog_not_the_embedded_copy() {
    let root = tempfile::tempdir().unwrap();
    let mut catalog: serde_json::Value = serde_json::from_str(&fixture(root.path())).unwrap();
    catalog["generatedAt"] = "2026-09-18T00:00:00.000Z".into();
    let before = catalog.to_string();
    fs::write(root.path().join("current.json"), &before).unwrap();
    let output = command(root.path())
        .args([
            "--catalog-path",
            "current.json",
            "--out",
            "custom-report.json",
            "--now",
            "2026-09-18T00:00:00Z",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ageDays"], 0);
    assert_eq!(report["status"], "fresh");
    assert_eq!(
        fs::read(root.path().join("custom-report.json")).unwrap(),
        output.stdout
    );
    assert_eq!(
        fs::read_to_string(root.path().join("current.json")).unwrap(),
        before
    );
    assert!(!root.path().join("catalog-freshness.json").exists());
}

#[test]
fn invalid_input_and_conflicting_outputs_fail_before_writing() {
    let root = tempfile::tempdir().unwrap();
    let before = fixture(root.path());
    for args in [
        vec!["--out", "data/models.json"],
        vec!["--now", "invalid"],
        vec!["--unknown"],
    ] {
        let output = command(root.path()).args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!root.path().join("catalog-freshness.json").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("data/models.json")).unwrap(),
            before
        );
    }
    let output = command(root.path())
        .env("GITHUB_STEP_SUMMARY", root.path().join("data/models.json"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(
        fs::read_to_string(root.path().join("data/models.json")).unwrap(),
        before
    );
    fs::write(root.path().join("data/models.json"), "{}").unwrap();
    assert!(!command(root.path()).output().unwrap().status.success());
    assert!(!root.path().join("catalog-freshness.json").exists());
}

#[cfg(unix)]
#[test]
fn report_symlinks_are_rejected_without_touching_targets() {
    let root = tempfile::tempdir().unwrap();
    let before = fixture(root.path());
    std::os::unix::fs::symlink(
        "data/models.json",
        root.path().join("catalog-freshness.json"),
    )
    .unwrap();
    assert!(!command(root.path()).output().unwrap().status.success());
    assert_eq!(
        fs::read_to_string(root.path().join("data/models.json")).unwrap(),
        before
    );
}
