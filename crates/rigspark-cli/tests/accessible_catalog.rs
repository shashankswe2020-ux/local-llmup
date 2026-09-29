use rigspark_cli::accessible_catalog as implementation;
use rigspark_cli::accessible_catalog::{
    CatalogOptions, build_catalog, catalog_screen, run_catalog,
};
use rigspark_core::{catalog::Catalog, sizing::Hardware};
use serde::Deserialize;
use std::io::{self, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
struct Case {
    name: String,
    catalog: Catalog,
    hardware: Hardware,
    options: CatalogOptions,
    commands: Vec<String>,
    expected: String,
    transcript: String,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("accessible-catalog-oracle.json")).unwrap()
}

#[tokio::test]
async fn native_catalog_matches_frozen_typescript_screens_and_conversations() {
    let cases = cases();
    assert_eq!(cases.len(), 20);
    for case in cases {
        let before = serde_json::to_value((&case.catalog, &case.hardware)).unwrap();
        let catalog = build_catalog(&case.catalog, &case.hardware, &case.options).unwrap();
        assert_eq!(catalog_screen(&catalog), case.expected, "{}", case.name);
        let (sender, mut receiver) = mpsc::channel(case.commands.len().max(1));
        for command in case.commands {
            sender.send(Ok(command)).await.unwrap();
        }
        drop(sender);
        let mut output = Vec::new();
        run_catalog(
            &catalog,
            &mut receiver,
            &mut output,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            case.transcript,
            "{}",
            case.name
        );
        assert_eq!(
            serde_json::to_value((&case.catalog, &case.hardware)).unwrap(),
            before
        );
    }
}

fn base() -> Case {
    cases()
        .into_iter()
        .find(|case| case.name == "complete")
        .unwrap()
}

#[test]
fn catalog_rounds_exact_half_decimal_ties_like_legacy_output() {
    let mut case = base();
    for (bytes, expected) in [(1_342_177_280.0, "1.3"), (1_879_048_192.0, "1.8")] {
        case.hardware.free_disk_bytes = bytes;
        let catalog = build_catalog(&case.catalog, &case.hardware, &case.options).unwrap();
        assert!(catalog_screen(&catalog).contains(&format!("disk {expected} GiB free")));
    }
}

#[test]
fn bounds_reject_oversized_collections_nodes_and_text_without_panics() {
    let mut case = base();
    let original = case.catalog.clone();
    case.catalog.models = vec![original.models[0].clone(); 1001];
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
    case.catalog = original.clone();
    case.catalog.models[0].capabilities = vec!["chat".into(); 1001];
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
    case.catalog = original.clone();
    case.catalog.models[0].quantizations = vec![original.models[0].quantizations[0].clone(); 1001];
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
    case.catalog = original.clone();
    let source = case.catalog.models[0].source.mlx.as_mut().unwrap();
    source.files = vec![source.files[0].clone(); 1001];
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
    case.catalog = original.clone();
    case.catalog.models[0].capabilities = vec!["chat".into(); 1000];
    case.catalog.models = vec![case.catalog.models[0].clone(); 101];
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
    case.catalog = original.clone();
    case.catalog.models[0].family = "x".repeat(1024 * 1024 + 1);
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
    case.catalog = original;
    case.options.refresh = Some(implementation::CatalogRefresh {
        added: vec!["id".into(); 1001],
        ..Default::default()
    });
    assert!(build_catalog(&case.catalog, &case.hardware, &case.options).is_err());
}

#[test]
fn invalid_numeric_evidence_and_missing_quants_are_not_presented() {
    let case = base();
    for invalid in [-1.0, f64::NAN, f64::INFINITY, 0.5, 9_007_199_254_740_992.0] {
        let mut hardware = case.hardware.clone();
        hardware.free_disk_bytes = invalid;
        let mut empty = case.catalog.clone();
        empty.models.clear();
        assert!(build_catalog(&empty, &hardware, &case.options).is_err());
        let mut catalog = case.catalog.clone();
        catalog.models[0].quantizations[0].disk_bytes = invalid;
        assert!(build_catalog(&catalog, &case.hardware, &case.options).is_err());
    }
    let mut catalog = case.catalog.clone();
    catalog.models[0].quantizations.clear();
    assert!(build_catalog(&catalog, &case.hardware, &case.options).is_err());
    assert!(build_catalog(&catalog, &case.hardware, &CatalogOptions::default()).is_err());
}

#[test]
fn frozen_large_screen_is_line_bounded_and_evidence_remains_available_in_details() {
    let case = cases()
        .into_iter()
        .find(|case| case.name == "bounds")
        .unwrap();
    assert!(case.expected.contains("[output bounded;"));
    assert!(case.expected.len() <= implementation::MAX_CATALOG_FRAME_BYTES);
    assert!(case.transcript.contains("Details: large:0\n1. large:0;"));
    let catalog = build_catalog(&case.catalog, &case.hardware, &case.options).unwrap();
    assert_eq!(catalog_screen(&catalog), case.expected);
}

#[tokio::test]
async fn eof_quit_and_errors_do_not_consume_later_input() {
    let case = base();
    let catalog = build_catalog(&case.catalog, &case.hardware, &case.options).unwrap();
    for answer in [
        Ok("q".into()),
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "reader failed")),
        Ok("x".repeat(257)),
        Ok("\u{00e9}".repeat(129)),
    ] {
        let expected_error = match &answer {
            Err(error) => Some(error.kind()),
            Ok(line) if line.len() > 256 => Some(io::ErrorKind::InvalidInput),
            _ => None,
        };
        let (sender, mut input) = mpsc::channel(2);
        sender.send(answer).await.unwrap();
        sender.send(Ok("unconsumed".into())).await.unwrap();
        drop(sender);
        let mut output = Vec::new();
        let result =
            run_catalog(&catalog, &mut input, &mut output, &CancellationToken::new()).await;
        assert_eq!(result.err().map(|error| error.kind()), expected_error);
        assert_eq!(String::from_utf8(output).unwrap(), case.expected);
        assert_eq!(input.try_recv().unwrap().unwrap(), "unconsumed");
    }
}

struct CancellingWriter {
    output: Vec<u8>,
    cancel: CancellationToken,
}

impl Write for CancellingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.output.extend_from_slice(buffer);
        Ok(buffer.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.cancel.cancel();
        Ok(())
    }
}

#[tokio::test]
async fn cancellation_interrupts_waiting_input_and_wins_over_queued_commands() {
    let case = base();
    let catalog = build_catalog(&case.catalog, &case.hardware, &case.options).unwrap();
    for queued in [false, true] {
        let (sender, mut input) = mpsc::channel(1);
        if queued {
            sender.send(Ok("/example".into())).await.unwrap();
        }
        let cancel = CancellationToken::new();
        let mut output = CancellingWriter {
            output: Vec::new(),
            cancel: cancel.clone(),
        };
        let error = run_catalog(&catalog, &mut input, &mut output, &cancel)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(String::from_utf8(output.output).unwrap(), case.expected);
        if queued {
            assert!(input.try_recv().is_ok());
        }
    }
    let (_sender, mut input) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut output = Vec::new();
    assert_eq!(
        run_catalog(&catalog, &mut input, &mut output, &cancel)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::Interrupted
    );
    assert!(output.is_empty());
}

struct BrokenWriter {
    fail_flush: bool,
}

impl Write for BrokenWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.fail_flush {
            Ok(buffer.len())
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "write failed"))
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "flush failed"))
    }
}

#[tokio::test]
async fn write_and_flush_errors_propagate_before_reading() {
    let case = base();
    let catalog = build_catalog(&case.catalog, &case.hardware, &case.options).unwrap();
    for fail_flush in [false, true] {
        let (sender, mut input) = mpsc::channel(1);
        sender.send(Ok("q".into())).await.unwrap();
        let error = run_catalog(
            &catalog,
            &mut input,
            &mut BrokenWriter { fail_flush },
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        assert!(input.try_recv().is_ok());
    }
}
