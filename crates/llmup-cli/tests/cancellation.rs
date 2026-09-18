use llmup_cli::cancellation::*;
use serde_json::json;

#[test]
fn timeouts_and_signal_exit_codes_match_legacy_contract() {
    assert_eq!(CLEANUP_TIMEOUT_MS, 30_000);
    assert_eq!(LOCK_TIMEOUT_MS, 10_000);
    for (signal, code) in [("SIGHUP", 129), ("SIGINT", 130), ("SIGTERM", 143)] {
        assert_eq!(exit_code_for_signal(Some(signal)), Some(code));
        assert!(code > 128);
    }
    assert_eq!(exit_code_for_signal(None), None);
    assert_eq!(exit_code_for_signal(Some("SIGUSR1")), None);
}

#[test]
fn up_cancellation_keeps_exact_phase_effect_and_commit_precedence() {
    for (phase, stopped, spawned, kind, effect) in [
        ("resolve", false, false, "cancelled", "unchanged"),
        (
            "acquire",
            false,
            false,
            "cancelled",
            "artifact_cached_state_unchanged",
        ),
        (
            "verify",
            false,
            false,
            "cancelled",
            "artifact_cached_state_unchanged",
        ),
        ("serve", false, true, "cancelled", "spawned_process_cleaned"),
        ("serve", true, true, "cancelled", "spawned_process_cleaned"),
        ("state-commit", true, true, "success", "state_committed"),
    ] {
        assert_eq!(
            serde_json::to_value(classify_up(phase, stopped, spawned)).unwrap(),
            json!({"type":kind,"phase":phase,"effect":effect})
        );
    }
    for phase in ["serve", "prior-cleanup"] {
        let result = classify_up(phase, true, false);
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["type"], "partial");
        assert_eq!(
            value["effect"],
            "prior_server_stopped_replacement_not_started"
        );
        assert!(
            value["remediation"]
                .as_str()
                .unwrap()
                .contains("local-llmup up")
        );
        assert!(!result.to_string().contains("success"));
    }
}

#[test]
fn down_and_switch_cancellation_preserve_rollback_and_commit_outcomes() {
    assert_eq!(
        serde_json::to_value(classify_down("locked-revalidate", false)).unwrap(),
        json!({"type":"cancelled","phase":"locked-revalidate","effect":"unchanged"})
    );
    assert_eq!(
        serde_json::to_value(classify_down("stop-detach", false)).unwrap(),
        json!({"type":"success","phase":"stop-detach","effect":"state_committed"})
    );
    let rollback = serde_json::to_value(classify_down("stop-detach", true)).unwrap();
    assert_eq!(rollback["effect"], "state_rollback_attempted");
    assert_eq!(rollback["type"], "partial");
    assert!(
        rollback["remediation"]
            .as_str()
            .unwrap()
            .contains("local-llmup down")
    );
    for (phase, kind, effect) in [
        ("locked-revalidate", "cancelled", "unchanged"),
        ("prepare", "cancelled", "artifact_cached_state_unchanged"),
        ("readiness", "cancelled", "artifact_cached_state_unchanged"),
        ("state-commit", "success", "state_committed"),
    ] {
        assert_eq!(
            serde_json::to_value(classify_switch(phase)).unwrap(),
            json!({"type":kind,"phase":phase,"effect":effect})
        );
    }
}

#[test]
fn remediation_and_display_contracts_are_preserved() {
    assert_eq!(
        remediation_prior_stopped("llama3:8b"),
        "The prior server was stopped but its replacement failed to start. Run `local-llmup up llama3:8b` to restore service."
    );
    assert_eq!(
        remediation_rollback("phi3:mini"),
        "State was cleared but stopping phi3:mini failed; state was restored. Inspect the process manually or retry `local-llmup down`."
    );
    assert_eq!(
        remediation_source_retained(),
        "Migration target is valid; source was retained. Re-run `local-llmup migrate --move` to complete source deletion."
    );
    assert_eq!(
        classify_switch("state-commit").to_string(),
        "Completed successfully at phase: state-commit"
    );
    assert_eq!(
        classify_up("acquire", false, false).to_string(),
        "Cancelled at phase: acquire (effect: artifact_cached_state_unchanged)"
    );
    let partial = Termination::Partial {
        phase: "serve",
        effect: Effect::PriorServerStoppedReplacementNotStarted,
        remediation: "restore service".into(),
    };
    assert_eq!(
        partial.to_string(),
        "Partial completion at phase: serve \u{2014} restore service"
    );
    let failed = Termination::Failed {
        phase: "readiness",
        effect: Effect::SpawnedProcessCleaned,
        code: "timeout".into(),
    };
    assert_eq!(
        failed.to_string(),
        "Failed at phase: readiness (timeout; effect: spawned_process_cleaned)"
    );
}
