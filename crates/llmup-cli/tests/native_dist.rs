use llmup_cli::distribution::{package_directory, verify_directory};

#[test]
fn archive_names_preserve_version_and_target() {
    let directory = std::path::Path::new("target/local-llmup-0.11.4-aarch64-apple-darwin-123");
    assert_eq!(
        llmup_cli::distribution::archive_path(directory).unwrap(),
        std::path::Path::new("target/local-llmup-0.11.4-aarch64-apple-darwin-123.tar.gz")
    );
}

#[test]
fn native_distribution_has_no_launcher_and_rejects_tampering_or_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("native");
    std::fs::write(&input, b"native fixture").unwrap();
    let output = root.path().join("package");
    let manifest = package_directory(
        &output,
        "0.11.4",
        "aarch64-apple-darwin",
        &[("llmup", input.as_path())],
    )
    .unwrap();
    assert_eq!(manifest.signing, "unsigned");
    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].name, "llmup");
    verify_directory(&output).unwrap();
    assert!(
        package_directory(
            &output,
            "0.11.4",
            "aarch64-apple-darwin",
            &[("llmup", input.as_path())]
        )
        .is_err()
    );
    assert!(!output.join("package.json").exists());
    std::fs::write(output.join("llmup"), b"tampered").unwrap();
    assert!(verify_directory(&output).is_err());
}

#[test]
fn native_distribution_rejects_unsafe_metadata_and_paths() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("native");
    std::fs::write(&input, b"fixture").unwrap();
    for (version, target, name) in [
        ("../bad", "aarch64-apple-darwin", "llmup"),
        ("0.11.4", "unknown-target", "llmup"),
        ("0.11.4", "aarch64-apple-darwin", "../escape"),
        ("0.11.4", "aarch64-apple-darwin", "launcher.cjs"),
    ] {
        assert!(
            package_directory(
                &root.path().join("output"),
                version,
                target,
                &[(name, input.as_path())]
            )
            .is_err()
        );
    }
}
