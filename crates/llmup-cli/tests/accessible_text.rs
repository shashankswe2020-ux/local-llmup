use llmup_cli::accessible_text::{identifier, single_line};

#[test]
fn unicode_normalization_visible_escaping_and_truncation_match_legacy() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("accessible-text-oracle.json")).unwrap();
    assert_eq!(cases.len(), 19);
    for case in cases {
        let raw = case["input"].as_str().unwrap();
        assert_eq!(
            single_line(raw).unwrap(),
            case["line"].as_str().unwrap(),
            "line: {raw:?}"
        );
        assert_eq!(
            identifier(raw).unwrap(),
            case["identifier"].as_str().unwrap(),
            "id: {raw:?}"
        );
    }
    assert!(single_line(&"x".repeat(1024 * 1024 + 1)).is_err());
    assert!(identifier(&"x".repeat(1024 * 1024 + 1)).is_err());
}
