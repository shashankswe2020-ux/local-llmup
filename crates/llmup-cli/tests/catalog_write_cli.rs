use llmup_core::{
    catalog::Catalog,
    enrich::{Mode, enrich, parse_candidates},
};
use std::{fs, path::Path, process::Command};

fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-refresh"));
    command
        .current_dir(root)
        .env("PATH", "")
        .env("LOCAL_LLMUP_HOME", root.join("unused-home"));
    command
}

#[test]
fn no_op_preserves_input_bytes_and_reports_exact_counts() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("data")).unwrap();
    let path = root.path().join("data/models.json");
    let original = include_str!("../../../data/models.json");
    fs::write(&path, original).unwrap();
    let output = command(root.path()).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "catalog-refresh: added=0 updated=0 removed=0 skipped=0 capped=0\n"
    );
    assert_eq!(fs::read_to_string(path).unwrap(), original);
    assert!(!root.path().join("unused-home").exists());
}

#[test]
fn older_catalog_is_enriched_then_becomes_a_byte_identical_no_op() {
    let root = tempfile::tempdir().unwrap();
    let mut catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
    catalog.models = catalog.models.into_iter().rev().take(2).collect();
    let path = root.path().join("older.json");
    fs::write(&path, serde_json::to_vec(&catalog).unwrap()).unwrap();
    let now = "2026-09-19T00:00:00Z";
    let candidates = parse_candidates(include_str!(
        "../../llmup-core/fixtures/registry-snapshot.json"
    ))
    .unwrap();
    let expected = enrich(&catalog, &candidates, Mode::Incremental, now, None).unwrap();
    assert!(!expected.diff.added.is_empty());
    let run = || {
        command(root.path())
            .args(["--catalog-path", "older.json", "--now", now])
            .output()
            .unwrap()
    };
    assert!(run().status.success());
    let first = fs::read_to_string(&path).unwrap();
    assert_eq!(
        serde_json::to_value(Catalog::parse(&first).unwrap()).unwrap(),
        serde_json::to_value(expected.catalog).unwrap()
    );
    assert!(run().status.success());
    assert_eq!(fs::read_to_string(&path).unwrap(), first);
}

#[test]
fn rejects_invalid_input_before_writing() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("catalog.json");
    for text in ["{}", "invalid", "null"] {
        fs::write(&path, text).unwrap();
        assert!(
            !command(root.path())
                .args(["--catalog-path", "catalog.json"])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
    let original = include_str!("../../../data/models.json");
    fs::write(&path, original).unwrap();
    assert!(
        !command(root.path())
            .args(["--catalog-path", "catalog.json", "--now", "invalid"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn rejects_catalog_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("catalog.json");
    let original = include_str!("../../../data/models.json");
    fs::write(&path, original).unwrap();
    std::os::unix::fs::symlink(&path, root.path().join("link.json")).unwrap();
    assert!(
        !command(root.path())
            .args(["--catalog-path", "link.json"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), original);
}
