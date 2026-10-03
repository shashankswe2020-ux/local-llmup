//! Renders TUI screens from offline fixtures as plain text, for visual review and demos.
//! Usage: cargo run -p rigspark-cli --example tui-preview -- [screen|all] [width] [height]

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use rigspark_cli::{
    accessible_catalog, accessible_recommend, terminal::ChatReply, tui_chat, tui_models, tui_view,
};
use std::process::ExitCode;

const SCREENS: [&str; 6] = [
    "recommend",
    "detail",
    "compare",
    "catalog",
    "chat",
    "picker",
];

fn frame(width: u16, height: u16, draw: impl FnOnce(&mut ratatui::Frame<'_>)) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test backend");
    terminal.draw(draw).expect("render");
    terminal
        .backend()
        .buffer()
        .content
        .chunks(usize::from(width))
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn press(view: &mut tui_models::ModelView, code: KeyCode) {
    tui_models::handle_key(view, KeyEvent::new(code, KeyModifiers::NONE));
}

fn recommendation() -> tui_models::ModelView {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/accessible-recommend-oracle.json"))
            .expect("recommend fixture");
    let case = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .max_by_key(|case| case["catalog"]["models"].as_array().map_or(0, Vec::len))
        .expect("case");
    let presentation = accessible_recommend::build_recommendation(
        &serde_json::from_value(case["catalog"].clone()).expect("catalog"),
        &serde_json::from_value(case["hardware"].clone()).expect("hardware"),
        &rigspark_core::catalog::PerfDataset::parse(&case["perf"].to_string()).expect("perf"),
        &serde_json::from_value(case["options"].clone()).expect("options"),
    )
    .expect("recommendation");
    tui_models::ModelView::from_recommendation(&presentation, false).expect("view")
}

fn render(screen: &str, width: u16, height: u16) -> Option<String> {
    Some(match screen {
        "recommend" => {
            let mut view = recommendation();
            frame(width, height, |frame| tui_models::render(frame, &mut view))
        }
        "detail" => {
            let mut view = recommendation();
            press(&mut view, KeyCode::Enter);
            frame(width, height, |frame| tui_models::render(frame, &mut view))
        }
        "compare" => {
            let mut view = recommendation();
            press(&mut view, KeyCode::Char(' '));
            press(&mut view, KeyCode::Down);
            press(&mut view, KeyCode::Char(' '));
            press(&mut view, KeyCode::Char('c'));
            frame(width, height, |frame| tui_models::render(frame, &mut view))
        }
        "catalog" => {
            let cases: serde_json::Value =
                serde_json::from_str(include_str!("../tests/accessible-catalog-oracle.json"))
                    .expect("catalog fixture");
            let case = &cases.as_array().expect("cases")[0];
            let presentation = accessible_catalog::build_catalog(
                &serde_json::from_value(case["catalog"].clone()).expect("catalog"),
                &serde_json::from_value(case["hardware"].clone()).expect("hardware"),
                &serde_json::from_value(case["options"].clone()).expect("options"),
            )
            .expect("presentation");
            let mut view = tui_models::ModelView::from_catalog(&presentation, false).expect("view");
            frame(width, height, |frame| tui_models::render(frame, &mut view))
        }
        "chat" => {
            let mut view = tui_chat::ChatView::new("llama3.1:8b");
            view.insert("How much memory does an 8B model need?")
                .expect("draft");
            view.submit().expect("submit");
            view.finish(Ok(ChatReply {
                content: "## Short answer\nAbout **5 GiB** at `Q4_K_M`, plus KV cache.\n- weights: ~4.7 GiB\n- KV cache: grows with context\n```\nrigspark can-run llama3.1:8b\n```".into(),
                memory_warning: false,
            }));
            frame(width, height, |frame| tui_chat::render(frame, &view, false))
        }
        "picker" => {
            let mut view = tui_view::ReportView::new(
                "up / choose model",
                "llama3.1:8b\nqwen3.6:35b\nmistral:7b\nbonsai:8b",
                false,
            )
            .expect("view");
            frame(width, height, |frame| tui_view::render(frame, &mut view))
        }
        _ => return None,
    })
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let screen = args.next().unwrap_or_else(|| "all".into());
    let width = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(120);
    let height = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(32);
    if !(20..=500).contains(&width) || !(8..=200).contains(&height) {
        eprintln!("width must be 20-500 and height 8-200");
        return ExitCode::FAILURE;
    }
    let screens: Vec<&str> = if screen == "all" {
        SCREENS.to_vec()
    } else {
        vec![screen.as_str()]
    };
    for screen in screens {
        let Some(output) = render(screen, width, height) else {
            eprintln!(
                "unknown screen {screen}; choose one of: all, {}",
                SCREENS.join(", ")
            );
            return ExitCode::FAILURE;
        };
        println!("== {screen} {width}x{height} ==\n{output}\n");
    }
    ExitCode::SUCCESS
}
