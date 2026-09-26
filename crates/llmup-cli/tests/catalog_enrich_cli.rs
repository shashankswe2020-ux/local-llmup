use llmup_core::catalog::Catalog;
use std::{fs, path::Path, process::Command};

fn setup(root: &Path) -> Catalog {
    let mut catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    catalog.models.retain(|model| model.id == "llama3.1:8b");
    fs::write(
        root.join("catalog.json"),
        serde_json::to_string_pretty(&catalog).unwrap(),
    )
    .unwrap();
    catalog
}
fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-enrich"));
    command
        .current_dir(root)
        .env("PATH", "")
        .env("LOCAL_LLMUP_HOME", root.join("unused"))
        .args([
            "--catalog-path",
            "catalog.json",
            "--manifest-fixture",
            "manifests.json",
            "--now",
            "2026-09-19T00:00:00Z",
        ]);
    command
}
fn fixtures(root: &Path, catalog: &Catalog, size: f64) {
    let url = llmup_runtime::registry_collector::manifest_url(
        catalog.models[0].source.ollama.as_deref().unwrap(),
    )
    .unwrap()
    .to_string();
    let value = serde_json::json!({url:{"status":200,"body":{"layers":[{"mediaType":"application/vnd.ollama.image.model","size":size,"digest":format!("sha256:{}","a".repeat(64))}]}}});
    fs::write(root.join("manifests.json"), value.to_string()).unwrap();
}

#[test]
fn applies_recorded_updates_then_preserves_bytes_on_repeated_run() {
    let root = tempfile::tempdir().unwrap();
    let input = setup(root.path());
    fixtures(root.path(), &input, 6_000_000_000.0);
    let output = command(root.path()).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "catalog-enrich: updated=1 (llama3.1:8b)\n"
    );
    let raw = fs::read(root.path().join("catalog.json")).unwrap();
    let actual = Catalog::parse(std::str::from_utf8(&raw).unwrap()).unwrap();
    assert_eq!(actual.generated_at, "2026-09-19T00:00:00.000Z");
    assert_eq!(
        actual.models[0].quantizations[0].disk_bytes,
        6_000_000_000.0
    );
    assert_eq!(
        actual.models[0].quantizations[0].min_ram_bytes,
        6_900_000_000.0
    );
    assert_eq!(
        actual.models[0].kv_bytes_per_token,
        input.models[0].kv_bytes_per_token
    );
    let repeat = command(root.path()).output().unwrap();
    assert!(repeat.status.success());
    assert_eq!(
        String::from_utf8(repeat.stderr).unwrap(),
        "catalog-enrich: updated=0\n"
    );
    assert_eq!(fs::read(root.path().join("catalog.json")).unwrap(), raw);
    assert!(!root.path().join("unused").exists());
}

#[test]
fn dry_run_and_total_registry_failure_never_rewrite_catalog() {
    let root = tempfile::tempdir().unwrap();
    let input = setup(root.path());
    fixtures(root.path(), &input, 6_000_000_000.0);
    let path = root.path().join("catalog.json");
    let before = fs::read(&path).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let output = command(root.path()).arg("--dry-run").output().unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("updated=1")
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    fs::write(root.path().join("manifests.json"), "{}").unwrap();
    assert!(command(root.path()).output().unwrap().status.success());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn invalid_fixture_or_clock_fails_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let input = setup(root.path());
    let path = root.path().join("catalog.json");
    let before = fs::read(&path).unwrap();
    fs::write(root.path().join("manifests.json"), "invalid").unwrap();
    assert!(!command(root.path()).output().unwrap().status.success());
    assert_eq!(fs::read(&path).unwrap(), before);
    fixtures(root.path(), &input, 6_000_000_000.0);
    let output = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-enrich"))
        .current_dir(root.path())
        .args([
            "--catalog-path",
            "catalog.json",
            "--manifest-fixture",
            "manifests.json",
            "--now",
            "invalid",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn refuses_symlink_catalog_and_preserves_existing_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let input = setup(root.path());
    fixtures(root.path(), &input, 6_000_000_000.0);
    let path = root.path().join("catalog.json");
    let original = root.path().join("original.json");
    fs::rename(&path, &original).unwrap();
    symlink(&original, &path).unwrap();
    assert!(!command(root.path()).output().unwrap().status.success());
    fs::remove_file(&path).unwrap();
    fs::rename(&original, &path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(command(root.path()).output().unwrap().status.success());
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o640
    );
}
