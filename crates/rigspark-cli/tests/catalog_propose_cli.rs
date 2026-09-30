use std::{fs, process::Command};

#[test]
fn fixture_proposals_are_offline_bounded_and_do_not_change_catalog() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("fixture.json"),
        r#"{"inventory":["new-model"],"responses":{}}"#,
    )
    .unwrap();
    fs::write(root.path().join("catalog.json"), rigspark_core::MODELS_JSON).unwrap();
    let run = |limit: &str| {
        Command::new(env!("CARGO_BIN_EXE_llmup-catalog-propose"))
            .current_dir(root.path())
            .args([
                "--catalog-path",
                "catalog.json",
                "--fixture",
                "fixture.json",
                "--out",
                "proposals.json",
                "--limit",
                limit,
                "--now",
                "2026-09-30T00:00:00Z",
            ])
            .env("PATH", "")
            .env("OPENAI_API_KEY", "test-must-not-be-used")
            .env("OPENAI_CATALOG_MODEL", "test")
            .output()
            .unwrap()
    };
    assert!(!run("11").status.success());
    assert!(!root.path().join("proposals.json").exists());
    let output = run("10");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("proposals.json")).unwrap()).unwrap();
    assert_eq!(report["inventoryComplete"], false);
    assert_eq!(report["requiresReview"], true);
    assert_eq!(report["proposals"][0]["status"], "unavailable");
    assert_eq!(
        fs::read_to_string(root.path().join("catalog.json")).unwrap(),
        rigspark_core::MODELS_JSON
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("test-must-not-be-used"));
}

#[test]
fn workflow_enrichment_scopes_credentials_and_keeps_review_and_signing_separate() {
    let workflow = include_str!("../../../.github/workflows/catalog-refresh.yml");
    for required in [
        "github.ref == 'refs/heads/main'",
        "timeout-minutes: 45",
        "cargo test --locked -p rigspark-runtime --test catalog_proposals",
        "cargo build --locked -p rigspark-cli --bin llmup-catalog-propose",
        "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
        "OPENAI_CATALOG_MODEL: ${{ vars.OPENAI_CATALOG_MODEL }}",
        "target/debug/llmup-catalog-propose --limit 10",
        "cargo catalog-quality",
        "git add docs/references/catalog-proposals.json",
        "gh pr create --base main",
    ] {
        assert!(workflow.contains(required), "{required}");
    }
    assert!(!workflow.contains("CATALOG_SIGNING_SEED"));
    assert!(!workflow.contains("cargo catalog-sign"));
    assert!(!workflow.contains("gh pr merge"));
    assert!(!workflow.contains("git add docs/references/catalog-quality-evidence.json"));
    assert!(
        workflow
            .find("cargo build --locked -p rigspark-cli --bin llmup-catalog-propose")
            .unwrap()
            < workflow.find("OPENAI_API_KEY:").unwrap()
    );
}
