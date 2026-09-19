use llmup_cli::dialog_smoke::{Action, Progress};

#[test]
fn requires_cancel_select_success_and_clean_exit() {
    let mut progress = Progress::default();
    assert_eq!(progress.observe("startup diagnostic").unwrap(), None);
    assert_eq!(
        progress.observe("R22 directory picker requested").unwrap(),
        Some(Action::Cancel)
    );
    assert!(!progress.complete(true));
    assert_eq!(
        progress.observe("R22 directory picker requested").unwrap(),
        Some(Action::Select)
    );
    assert!(!progress.complete(true));
    assert_eq!(
        progress.observe("Tauri WebView smoke: passed").unwrap(),
        None
    );
    assert!(progress.complete(true));
    assert!(!progress.complete(false));
}

#[test]
fn rejects_extra_dialogs_early_success_and_unbounded_lines() {
    assert!(Progress::default().observe("smoke: passed").is_err());
    assert!(Progress::default().observe(&"x".repeat(4097)).is_err());
    let mut progress = Progress::default();
    for _ in 0..2 {
        progress.observe("R22 directory picker requested").unwrap();
    }
    assert!(progress.observe("R22 directory picker requested").is_err());
}
