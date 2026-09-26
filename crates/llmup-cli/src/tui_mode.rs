use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub json: bool,
    pub tui: bool,
    pub no_tui: bool,
    pub accessible: bool,
    pub no_color: bool,
    pub environment_no_color: bool,
    pub force_color: bool,
    pub piped_input: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub stdin_tty: bool,
    pub stdout_tty: bool,
    pub stderr_tty: bool,
    pub columns: u16,
    pub rows: u16,
    pub color_depth: u8,
    pub unicode: bool,
    pub ci: bool,
    pub term: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Plain,
    Json,
    Tui,
    Accessible,
}

#[derive(Debug, Serialize)]
pub struct Selection {
    pub mode: Mode,
    pub explicit: bool,
    pub reason: Option<&'static str>,
    pub color: bool,
    pub unicode: bool,
}

pub fn detect_ci(environment: &BTreeMap<String, String>) -> bool {
    [
        ("CI", "true"),
        ("GITHUB_ACTIONS", "true"),
        ("GITLAB_CI", "true"),
        ("TF_BUILD", "True"),
        ("BUILDKITE", "true"),
    ]
    .iter()
    .any(|(name, value)| environment.get(*name).is_some_and(|found| found == value))
        || environment.contains_key("JENKINS_URL")
}

pub fn capture() -> Capabilities {
    use std::io::IsTerminal;
    let environment: BTreeMap<_, _> = [
        "TERM",
        "COLORTERM",
        "LC_ALL",
        "LC_CTYPE",
        "LANG",
        "WT_SESSION",
        "TERM_PROGRAM",
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "TF_BUILD",
        "BUILDKITE",
        "JENKINS_URL",
    ]
    .into_iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| (name.to_string(), value))
    })
    .collect();
    capture_snapshot(
        (
            std::io::stdin().is_terminal(),
            std::io::stdout().is_terminal(),
            std::io::stderr().is_terminal(),
        ),
        crossterm::terminal::size().unwrap_or((0, 0)),
        &environment,
        cfg!(windows),
    )
}

fn capture_snapshot(
    terminals: (bool, bool, bool),
    size: (u16, u16),
    environment: &BTreeMap<String, String>,
    windows: bool,
) -> Capabilities {
    let term = environment
        .get("TERM")
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.encode_utf16().count() <= 256 {
                value.clone()
            } else {
                "?".into()
            }
        });
    let valid = term
        .as_deref()
        .is_some_and(|term| valid_term(term) && !term.eq_ignore_ascii_case("dumb"));
    let (columns, rows) = size;
    let unicode = if windows {
        environment.contains_key("WT_SESSION")
            || environment
                .get("TERM_PROGRAM")
                .is_some_and(|value| value == "vscode")
    } else {
        ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .find_map(|name| environment.get(*name))
            .is_some_and(|value| {
                let value = value.to_ascii_lowercase();
                value.contains("utf-8") || value.contains("utf8")
            })
    };
    Capabilities {
        stdin_tty: terminals.0,
        stdout_tty: terminals.1,
        stderr_tty: terminals.2,
        columns: if columns <= 10000 { columns } else { 0 },
        rows: if rows <= 10000 { rows } else { 0 },
        color_depth: if valid { 4 } else { 1 },
        unicode: valid && unicode,
        ci: detect_ci(environment),
        term,
    }
}

fn valid_term(term: &str) -> bool {
    !term.is_empty()
        && term.len() <= 128
        && term.as_bytes()[0].is_ascii_alphanumeric()
        && term
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

pub fn resolve(options: &Options, capabilities: &Capabilities) -> Result<Selection, &'static str> {
    if capabilities.columns > 10000
        || capabilities.rows > 10000
        || ![1, 4, 8, 24].contains(&capabilities.color_depth)
        || capabilities
            .term
            .as_ref()
            .is_some_and(|term| term.encode_utf16().count() > 256)
    {
        return Err("invalid_capabilities");
    }
    if options.json && (options.tui || options.accessible) {
        return Err("json_conflict");
    }
    if options.no_tui && (options.tui || options.accessible) {
        return Err("mode_conflict");
    }
    let selection = |mode, explicit, reason| Selection {
        mode,
        explicit,
        reason,
        color: mode == Mode::Tui
            && !options.no_color
            && !options.environment_no_color
            && capabilities.color_depth > 1,
        unicode: mode == Mode::Tui && capabilities.unicode,
    };
    if options.json {
        return Ok(selection(Mode::Json, true, None));
    }
    if options.no_tui {
        return Ok(selection(Mode::Plain, true, Some("forced_plain")));
    }
    let term = capabilities.term.as_deref().unwrap_or("");
    let reason = [
        (options.piped_input, "piped_input"),
        (!capabilities.stdin_tty, "stdin_not_tty"),
        (!capabilities.stdout_tty, "stdout_not_tty"),
        (!capabilities.stderr_tty, "stderr_not_tty"),
        (term.is_empty(), "term_missing"),
        (!term.is_empty() && !valid_term(term), "term_invalid"),
        (term.eq_ignore_ascii_case("dumb"), "term_dumb"),
        (capabilities.ci, "ci_environment"),
        (
            capabilities.columns < if options.accessible { 40 } else { 60 },
            "terminal_width",
        ),
        (
            capabilities.rows < if options.accessible { 10 } else { 16 },
            "terminal_height",
        ),
    ]
    .into_iter()
    .find_map(|(failed, reason)| failed.then_some(reason));
    let explicit = options.tui || options.accessible;
    if let Some(reason) = reason {
        if explicit {
            return Err(reason);
        }
        return Ok(selection(Mode::Plain, false, Some(reason)));
    }
    Ok(selection(
        if options.accessible {
            Mode::Accessible
        } else {
            Mode::Tui
        },
        explicit,
        None,
    ))
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    #[test]
    fn captured_environment_preserves_eligibility_and_safe_defaults() {
        let environment = BTreeMap::from([
            ("TERM".into(), "xterm-256color".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
            ("GITHUB_ACTIONS".into(), "true".into()),
        ]);
        let captured = capture_snapshot((true, true, true), (100, 30), &environment, false);
        assert!(captured.stdin_tty && captured.stdout_tty && captured.stderr_tty);
        assert_eq!((captured.columns, captured.rows), (100, 30));
        assert!(captured.unicode && captured.ci);
        assert!(captured.color_depth > 1);
        assert_eq!(captured.term.as_deref(), Some("xterm-256color"));

        let empty = capture_snapshot(
            (false, false, false),
            (10001, 10001),
            &BTreeMap::new(),
            true,
        );
        assert!(!empty.stdin_tty && !empty.stdout_tty && !empty.stderr_tty);
        assert_eq!((empty.columns, empty.rows, empty.color_depth), (0, 0, 1));
        assert!(!empty.unicode && !empty.ci);
        assert!(empty.term.is_none());
    }

    #[test]
    fn captured_term_bounds_locale_precedence_and_windows_unicode_are_conservative() {
        for length in [129, 256, 257, 10000] {
            let environment = BTreeMap::from([("TERM".into(), "x".repeat(length))]);
            let captured = capture_snapshot((true, true, true), (80, 24), &environment, false);
            assert_eq!(
                resolve(&Options::default(), &captured).unwrap().reason,
                Some("term_invalid")
            );
            assert_eq!(captured.color_depth, 1);
            assert!(!captured.unicode);
        }
        let mut environment = BTreeMap::from([
            ("TERM".into(), "xterm".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
            ("LC_ALL".into(), "C".into()),
        ]);
        assert!(!capture_snapshot((true, true, true), (80, 24), &environment, false).unicode);
        assert!(!capture_snapshot((true, true, true), (80, 24), &environment, true).unicode);
        environment.insert("WT_SESSION".into(), String::new());
        assert!(capture_snapshot((true, true, true), (80, 24), &environment, true).unicode);
        environment.insert("TERM".into(), "dumb".into());
        assert!(!capture_snapshot((true, true, true), (80, 24), &environment, true).unicode);
    }
}
