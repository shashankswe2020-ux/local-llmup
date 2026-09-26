use llmup_cli::accessible_text::{chat_message, identifier, multiline, single_line};

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

#[test]
fn multiline_profiles_preserve_lines_escape_controls_and_bound_graphemes() {
    let raw = "Cafe\u{301}\r\nnext\rthird\tfourth\u{1b}[31m\u{202e}";
    assert_eq!(
        multiline(raw).unwrap(),
        "Caf\u{e9}\nnext\nthird  fourth\\u{1B}[31m\\u{202E}"
    );
    for (limit, render) in [
        (8192, multiline as fn(&str) -> std::io::Result<String>),
        (65536, chat_message as fn(&str) -> std::io::Result<String>),
    ] {
        let prefix = "x".repeat(limit - 5);
        let raw = format!("{prefix}\u{1f1fa}\u{1f1f3}tail");
        assert_eq!(render(&raw).unwrap(), format!("{prefix}\u{2026}"));
        assert_eq!(render(&"x".repeat(limit)).unwrap().len(), limit);
        let escaped = render(&format!("{}\0tail", "x".repeat(limit - 5))).unwrap();
        assert_eq!(escaped, format!("{prefix}\u{2026}"));
        assert!(render(&"\0".repeat(1024 * 1024 + 1)).is_err());
    }
    for value in [
        '\u{34f}',
        '\u{115f}',
        '\u{17b4}',
        '\u{180b}',
        '\u{3164}',
        '\u{fe00}',
        '\u{e0001}',
        '\u{e007f}',
    ] {
        assert_eq!(
            multiline(&format!("a{value}b")).unwrap(),
            format!("a\\u{{{:X}}}b", u32::from(value))
        );
    }
}
