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
