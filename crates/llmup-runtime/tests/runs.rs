use llmup_runtime::runs::RunCoordinator;
use tokio_util::sync::CancellationToken;
#[test]
fn runs_enforce_one_active_turn_and_reject_late_completion() {
    let runs = RunCoordinator::default();
    let run = runs.begin("session", &CancellationToken::new()).unwrap();
    assert!(runs.begin("session", &CancellationToken::new()).is_err());
    assert!(!runs.cancel("session", Some("wrong-id")).unwrap());
    assert!(runs.cancel("session", Some(run.id())).unwrap());
    assert!(run.token().is_cancelled());
    assert!(run.commit(|| Ok(())).is_err());
    let next = runs.begin("session", &CancellationToken::new()).unwrap();
    drop(run);
    assert!(next.commit(|| Ok(42)).is_ok());
    drop(next);
    assert!(runs.begin("session", &CancellationToken::new()).is_ok());
}
#[test]
fn settled_runs_cannot_be_cancelled_and_new_runs_get_fresh_ids() {
    let runs = RunCoordinator::default();
    let first = runs.begin("session", &CancellationToken::new()).unwrap();
    assert_eq!(
        runs.active_id("session").unwrap().as_deref(),
        Some(first.id())
    );
    first.commit(|| Ok(())).unwrap();
    assert!(runs.active_id("session").unwrap().is_none());
    assert!(!runs.cancel("session", None).unwrap());
    assert!(!runs.cancel("session", Some(first.id())).unwrap());
    let second = runs.begin("session", &CancellationToken::new()).unwrap();
    assert_ne!(second.id(), first.id());
    assert!(runs.cancel("session", None).unwrap());
    assert!(!runs.cancel("session", None).unwrap());
    assert!(runs.begin("other", &CancellationToken::new()).is_ok());
}
