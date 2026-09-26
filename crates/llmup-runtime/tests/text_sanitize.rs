use llmup_runtime::sessions::{GuiTextStream, gui_text};

fn streamed(parts: &[&str]) -> String {
    let mut stream = GuiTextStream::default();
    parts.iter().map(|part| stream.push(part)).collect()
}

#[test]
fn line_endings_normalize_while_line_feeds_and_tabs_survive() {
    assert_eq!(
        gui_text("# Title\r\n\rParagraph\tvalue\n```ts\rconst x = 1;\r```"),
        "# Title\n\nParagraph\tvalue\n```ts\nconst x = 1;\n```"
    );
}

#[test]
fn terminal_escapes_unsafe_controls_bidi_and_invisible_characters_are_removed() {
    assert_eq!(
        gui_text("safe\u{1b}[31m red\u{1b}[0m\u{0}\u{8}\u{85}\u{202e}\u{200b}\u{2060} text\nnext"),
        "safe red text\nnext"
    );
}

#[test]
fn control_strings_are_removed_with_their_payloads() {
    let input = [
        "before",
        "\u{1b}]8;;https://example.com\u{7}linked\u{1b}]8;;\u{1b}\\",
        "\u{1b}]52;c;Y2xpcGJvYXJk\u{7}",
        "\u{1b}Pprivate payload\u{1b}\\",
        "\u{1b}Xservice message\u{1b}\\",
        "\u{1b}^privacy message\u{1b}\\",
        "\u{1b}_application command\u{1b}\\",
        "\u{9d}c1 osc\u{9c}",
        "after",
    ]
    .concat();
    assert_eq!(gui_text(&input), "beforelinkedafter");
    assert_eq!(gui_text("safe\u{1b}]title\u{7}end"), "safeend");
}

#[test]
fn sanitizing_is_idempotent() {
    let once = gui_text("a\r\nb\t\u{1b}[2Jc\u{202e}");
    assert_eq!(gui_text(&once), once);
}

#[test]
fn sequences_split_across_stream_chunks_are_still_normalized() {
    assert_eq!(
        streamed(&[
            "# Result\r",
            "\n\r\n```ts\r\nconst value = 1;\r\n```\t\u{1b}[",
            "31mred\u{1b}[0",
            "m\u{202e}",
        ]),
        "# Result\n\n```ts\nconst value = 1;\n```\tred"
    );
}

#[test]
fn fragmented_control_strings_are_dropped_at_every_boundary() {
    let source = "safe\u{1b}]52;c;Y2xpcGJvYXJk\u{1b}\\middle\u{1b}Pprivate\u{1b}\\\u{1b}Xservice\u{1b}\\\u{1b}^privacy\u{1b}\\\u{1b}_command\u{1b}\\end";
    for (boundary, _) in source.char_indices().skip(1) {
        assert_eq!(
            streamed(&[&source[..boundary], &source[boundary..]]),
            "safemiddleend",
            "{boundary}"
        );
    }
}

#[test]
fn bel_ends_only_operating_system_commands() {
    for starter in ['P', 'X', '^', '_'] {
        let source = format!("safe\u{1b}{starter}hidden\u{7}still hidden\u{1b}\\end");
        for (boundary, _) in source.char_indices().skip(1) {
            assert_eq!(
                streamed(&[&source[..boundary], &source[boundary..]]),
                "safeend",
                "{starter} {boundary}"
            );
        }
    }
}
