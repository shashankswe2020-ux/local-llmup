use std::{fs, path::Path, process::Command};

fn setup(root: &Path) {
    fs::create_dir_all(root.join("crates/rigspark-core/data")).unwrap();
    fs::write(
        root.join("crates/rigspark-core/data/models.json"),
        include_str!("../../rigspark-core/data/models.json"),
    )
    .unwrap();
    fs::write(root.join("inventory.go"),"var libraryModels = []string{\n \"gemma4\",\n \"qwen3\",\n \"qwen999\",\n \"unmonitored\",\n}\n").unwrap();
}
fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-coverage"));
    command
        .current_dir(root)
        .env("PATH", "")
        .env_remove("GITHUB_STEP_SUMMARY")
        .args(["--inventory-path", "inventory.go"]);
    command
}

#[test]
fn offline_report_matches_legacy_contract_and_preserves_inputs() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let inventory = fs::read(root.path().join("inventory.go")).unwrap();
    let catalog = fs::read(root.path().join("crates/rigspark-core/data/models.json")).unwrap();
    let summary = root.path().join("summary.md");
    fs::write(&summary, "Existing\n").unwrap();
    let output = command(root.path())
        .arg("--json")
        .env("GITHUB_STEP_SUMMARY", &summary)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report["checkedAt"].as_str().unwrap().ends_with('Z'));
    report.as_object_mut().unwrap().remove("checkedAt");
    assert_eq!(
        report,
        serde_json::json!({"source":rigspark_core::coverage::INVENTORY_URL,"inventoryCount":4,"upstreamCount":3,"coveredCount":2,"missing":["qwen999"]})
    );
    assert_eq!(
        fs::read(root.path().join("catalog-coverage.json")).unwrap(),
        output.stdout
    );
    let human = "Catalog coverage\n  upstream: 3\n  covered:  2\n  missing:  1\n";
    assert_eq!(String::from_utf8(output.stderr).unwrap(), human);
    assert_eq!(
        fs::read_to_string(&summary).unwrap(),
        format!("Existing\n### Catalog coverage\n\n```\n{human}```\n")
    );
    assert_eq!(
        fs::read(root.path().join("inventory.go")).unwrap(),
        inventory
    );
    assert_eq!(
        fs::read(root.path().join("crates/rigspark-core/data/models.json")).unwrap(),
        catalog
    );
    let repeat = command(root.path()).output().unwrap();
    assert!(repeat.status.success());
    assert!(repeat.stdout.is_empty());
    assert_eq!(String::from_utf8(repeat.stderr).unwrap(), human);
}

#[cfg(unix)]
#[test]
fn symlink_report_cannot_modify_catalog() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    let catalog = root.path().join("crates/rigspark-core/data/models.json");
    let original = fs::read(&catalog).unwrap();
    std::os::unix::fs::symlink(&catalog, root.path().join("catalog-coverage.json")).unwrap();
    assert!(!command(root.path()).output().unwrap().status.success());
    assert_eq!(fs::read(catalog).unwrap(), original);
}

#[test]
fn invalid_inventory_and_path_collisions_fail_before_writes() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path());
    for path in ["inventory.go", "crates/rigspark-core/data/models.json"] {
        let before = fs::read(root.path().join(path)).unwrap();
        assert!(
            !command(root.path())
                .args(["--out", path])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(fs::read(root.path().join(path)).unwrap(), before);
        assert!(!root.path().join("catalog-coverage.json").exists());
    }
    assert!(
        !command(root.path())
            .env("GITHUB_STEP_SUMMARY", root.path().join("inventory.go"))
            .output()
            .unwrap()
            .status
            .success()
    );
    fs::write(root.path().join("inventory.go"), "invalid").unwrap();
    assert!(!command(root.path()).output().unwrap().status.success());
    assert!(!root.path().join("catalog-coverage.json").exists());
}
