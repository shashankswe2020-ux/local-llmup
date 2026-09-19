use llmup_cli::tui_mode::{Capabilities, Options, detect_ci, resolve};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[test]
fn matches_all_frozen_typescript_selections_and_error_reasons() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("tui-mode-oracle.json")).unwrap();
    assert_eq!(cases.len(), 360);
    for case in cases {
        let options: Options = serde_json::from_value(case["options"].clone()).unwrap();
        let capabilities: Capabilities =
            serde_json::from_value(case["capabilities"].clone()).unwrap();
        match resolve(&options, &capabilities) {
            Ok(selection) => assert_eq!(
                serde_json::to_value(selection).unwrap(),
                case["expected"],
                "{case}"
            ),
            Err(reason) => assert_eq!(reason, case["error"].as_str().unwrap(), "{case}"),
        }
    }
}

#[test]
fn ci_detection_uses_exact_documented_environment_values() {
    for (name, value) in [
        ("CI", "true"),
        ("GITHUB_ACTIONS", "true"),
        ("GITLAB_CI", "true"),
        ("TF_BUILD", "True"),
        ("BUILDKITE", "true"),
        ("JENKINS_URL", ""),
    ] {
        assert!(detect_ci(&BTreeMap::from([(name.into(), value.into())])));
    }
    assert!(!detect_ci(&BTreeMap::from([
        ("CI".into(), "1".into()),
        ("TF_BUILD".into(), "true".into())
    ])));
}

#[test]
fn rejects_invalid_capability_bounds_and_unknown_option_fields() {
    let base = json!({"stdinTty":true,"stdoutTty":true,"stderrTty":true,"columns":80,"rows":24,"colorDepth":24,"unicode":true,"ci":false,"term":"xterm"});
    for (field, value) in [
        ("columns", json!(10001)),
        ("rows", json!(10001)),
        ("colorDepth", json!(3)),
        ("term", json!("x".repeat(257))),
    ] {
        let mut invalid = base.clone();
        invalid[field] = value;
        let capabilities: Capabilities = serde_json::from_value(invalid).unwrap();
        assert_eq!(
            resolve(&Options::default(), &capabilities).unwrap_err(),
            "invalid_capabilities"
        );
    }
    assert!(serde_json::from_value::<Options>(json!({"unknown":true})).is_err());
}
