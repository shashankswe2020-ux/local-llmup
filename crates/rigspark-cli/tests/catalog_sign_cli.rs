use std::{fs, process::Command};

const SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

#[test]
fn publication_is_protected_separate_from_binary_releases_and_not_latest() {
    let workflow = include_str!("../../../.github/workflows/catalog-publish.yml");
    for required in [
        "workflow_dispatch:",
        "github.ref == 'refs/heads/main'",
        "environment: catalog-signing",
        "cancel-in-progress: false",
        "umask 077",
        "--prerelease --latest=false",
        "catalog-r${GITHUB_RUN_NUMBER}",
        "gh release upload catalog-v1 catalog.json --clobber",
    ] {
        assert!(workflow.contains(required), "{required}");
    }
    assert!(!workflow.contains("pull_request"));
    assert!(!workflow.contains("set -x"));
}

#[test]
fn signer_validates_key_and_refuses_to_overwrite_output() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("seed"), SEED).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.path().join("seed"), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fs::write(root.path().join("public"), PUBLIC).unwrap();
    fs::write(root.path().join("models.json"), rigspark_core::MODELS_JSON).unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_llmup-catalog-sign"))
            .current_dir(root.path())
            .args([
                "--catalog-path",
                "models.json",
                "--key-file",
                "seed",
                "--public-key-file",
                "public",
                "--output",
                "catalog.json",
                "--revision",
                "1",
                "--published-at",
                "2026-09-30T00:00:00Z",
            ])
            .output()
            .unwrap()
    };
    let first = run();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let artifact = fs::read(root.path().join("catalog.json")).unwrap();
    let public = rigspark_runtime::catalog_update::decode_hex(PUBLIC).unwrap();
    assert_eq!(
        rigspark_runtime::catalog_update::verify(&artifact, &public)
            .unwrap()
            .revision,
        1
    );
    assert!(!run().status.success());
    assert_eq!(
        fs::read(root.path().join("catalog.json")).unwrap(),
        artifact
    );
    fs::remove_file(root.path().join("catalog.json")).unwrap();
    fs::write(root.path().join("public"), "00".repeat(32)).unwrap();
    assert!(!run().status.success());
    assert!(!root.path().join("catalog.json").exists());
    assert!(!String::from_utf8_lossy(&first.stderr).contains(SEED));
}
