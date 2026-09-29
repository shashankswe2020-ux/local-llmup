use regex::Regex;
use std::{io, sync::OnceLock};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

fn truncate(value: &str, already_truncated: bool, limit: usize) -> String {
    if value.len() <= limit && !already_truncated {
        return value.into();
    }
    static ESCAPE: OnceLock<Regex> = OnceLock::new();
    let escape = ESCAPE
        .get_or_init(|| Regex::new(r"\\u\{[0-9A-F]+\}").expect("valid visible escape pattern"));
    let mut units = Vec::new();
    let mut offset = 0;
    for token in escape.find_iter(value) {
        units.extend(value[offset..token.start()].graphemes(true));
        units.push(token.as_str());
        offset = token.end();
    }
    units.extend(value[offset..].graphemes(true));
    let mut output = String::new();
    for unit in units {
        if output.len() + unit.len() > limit - 3 {
            break;
        }
        output.push_str(unit);
    }
    output.push('\u{2026}');
    output
}

fn escape(value: &str, action: bool, multiline: bool, limit: usize) -> io::Result<String> {
    if value.len() > 1024 * 1024 {
        return Err(io::Error::other("terminal text exceeds 1 MiB"));
    }
    static IGNORABLE: OnceLock<Regex> = OnceLock::new();
    let ignorable = IGNORABLE.get_or_init(|| {
        Regex::new(r"^\p{Default_Ignorable_Code_Point}$").expect("valid Unicode property")
    });
    let mut characters = value.chars().peekable();
    let mut escaped = String::new();
    let mut truncated = false;
    while let Some(character) = characters.next() {
        let replacement = if action {
            if character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || "._:/-".contains(character)
            {
                character.to_string()
            } else {
                format!("\\u{{{:X}}}", u32::from(character))
            }
        } else {
            match character {
                '\r' => {
                    if characters.peek() == Some(&'\n') {
                        characters.next();
                    }
                    if multiline { "\n" } else { "\\n" }.into()
                }
                '\n' => if multiline { "\n" } else { "\\n" }.into(),
                '\t' => "  ".into(),
                value
                    if value.is_control()
                        || matches!(value, '\u{2028}' | '\u{2029}')
                        || ignorable.is_match(&value.to_string()) =>
                {
                    format!("\\u{{{:X}}}", u32::from(value))
                }
                value => value.to_string(),
            }
        };
        if escaped.len() + replacement.len() > limit + 1024 {
            truncated = true;
            break;
        }
        escaped.push_str(&replacement);
    }
    let normalized = if action {
        escaped
    } else {
        escaped.nfc().collect()
    };
    Ok(truncate(&normalized, truncated, limit))
}

pub fn single_line(value: &str) -> io::Result<String> {
    escape(value, false, false, 256)
}
pub fn identifier(value: &str) -> io::Result<String> {
    escape(value, true, false, 256)
}
pub fn multiline(value: &str) -> io::Result<String> {
    escape(value, false, true, 8192)
}
pub fn chat_message(value: &str) -> io::Result<String> {
    escape(value, false, true, 65536)
}
