use rigspark_core::{
    catalog::Catalog,
    enrich::{Mode, enrich, parse_candidates},
};
use std::{fs, process::Command};

#[test]
fn dry_run_reports_changes_without_replacing_or_reformatting_input() {
    for older in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("catalog.json");
        let mut catalog =
            Catalog::parse(include_str!("../../rigspark-core/data/models.json")).unwrap();
        if older {
            catalog.models = catalog.models.into_iter().rev().take(2).collect();
        }
        let original = format!(" {} \n", serde_json::to_string(&catalog).unwrap());
        fs::write(&path, &original).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let candidates = parse_candidates(include_str!(
            "../../rigspark-core/fixtures/registry-snapshot.json"
        ))
        .unwrap();
        let now = "2026-09-19T00:00:00Z";
        let expected = enrich(&catalog, &candidates, Mode::Incremental, now, None)
            .unwrap()
            .diff;
        if older {
            assert!(!expected.added.is_empty());
        }
        let output = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-refresh"))
            .args(["--dry-run", "--catalog-path"])
            .arg(&path)
            .args(["--now", now])
            .env("PATH", "")
            .env("RIGSPARK_HOME", root.path().join("unused"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            format!(
                "catalog-refresh dry-run: added={} updated={} removed={} skipped={} capped={}\n",
                expected.added.len(),
                expected.updated.len(),
                expected.removed.len(),
                expected.skipped.len(),
                expected.capped.len()
            )
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert!(!root.path().join("unused").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[test]
fn dry_run_rejects_invalid_catalog_without_writing() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("catalog.json");
    fs::write(&path, "invalid").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-refresh"))
        .args(["--dry-run", "--catalog-path"])
        .arg(&path)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read_to_string(path).unwrap(), "invalid");
}
