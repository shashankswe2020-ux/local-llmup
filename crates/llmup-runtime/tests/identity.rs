use llmup_runtime::{
    identity::{Confirmation, Listener, Operation, ProcessIdentity, capture, choose_listener},
    state::RuntimeState,
};
use serde_json::json;

fn active() -> llmup_runtime::state::ServerState {
    RuntimeState::parse(&json!({"schemaVersion":2,"active":{"backend":"ollama","modelId":"test:latest","endpoint":"http://127.0.0.1:11435","port":11435,"ownedByUs":true,"pid":123,"processExecutable":"/opt/bin/ollama","processStartedAt":"2026-09-17 01:02:03"}}).to_string()).unwrap().active.unwrap()
}
fn listener() -> Listener {
    Listener {
        identity: ProcessIdentity {
            pid: 123,
            process: "ollama".into(),
            executable: "/opt/bin/ollama".into(),
            started: "2026-09-17 01:02:03".into(),
        },
        address: "127.0.0.1".into(),
        port: 11435,
    }
}
#[test]
fn listener_identity_rejects_ambiguity_wildcards_pid_reuse_and_executable_drift() {
    let observed = listener();
    assert_eq!(
        choose_listener(std::slice::from_ref(&observed), 11435, "127.0.0.1").unwrap(),
        observed
    );
    assert!(choose_listener(&[observed.clone(), observed.clone()], 11435, "127.0.0.1").is_err());
    let mut wildcard = observed.clone();
    wildcard.address = "0.0.0.0".into();
    assert!(capture(&active(), &wildcard, true).is_err());
    assert!(capture(&active(), &observed, false).is_err());
    for field in ["pid", "started", "executable"] {
        let mut changed = observed.clone();
        match field {
            "pid" => changed.identity.pid = 124,
            "started" => changed.identity.started = "reused".into(),
            _ => changed.identity.executable = "/tmp/unrelated".into(),
        }
        assert!(capture(&active(), &changed, true).is_err());
    }
    assert!(capture(&active(), &observed, true).is_ok());
}
#[test]
fn confirmation_binds_state_context_target_ownership_and_observed_process() {
    let state = RuntimeState {
        schema_version: 2,
        active: Some(active()),
    };
    let live = capture(state.active.as_ref().unwrap(), &listener(), true).unwrap();
    let approved = Confirmation::prepare(Operation::Down, &state, None, Some(&live)).unwrap();
    approved.verify(&approved).unwrap();
    let mut changed = state.clone();
    changed.active.as_mut().unwrap().context = Some(8192);
    let current = Confirmation::prepare(Operation::Down, &changed, None, Some(&live)).unwrap();
    assert!(approved.verify(&current).is_err());
    changed.active.as_mut().unwrap().owned_by_us = false;
    assert!(Confirmation::prepare(Operation::Down, &changed, None, Some(&live)).is_err());
    assert!(Confirmation::prepare(Operation::Detach, &state, None, Some(&live)).is_err());
    assert!(
        Confirmation::prepare(
            Operation::ReplaceServer,
            &state,
            Some("../escape"),
            Some(&live)
        )
        .is_err()
    );
    assert!(Confirmation::prepare(Operation::Down, &state, None, None).is_err());
}

#[test]
fn bounded_platform_identity_parsers_fail_closed() {
    use llmup_runtime::identity::{parse_lsof_listener, parse_start_time, parse_windows_listener};
    assert_eq!(
        parse_lsof_listener("p123\nn127.0.0.1:11435\n", 11435, "127.0.0.1").unwrap(),
        123
    );
    for raw in [
        "p123\nn*:11435\n",
        "p123\nn127.0.0.1:11435\np456\nn127.0.0.1:11435\n",
        "p0\nn127.0.0.1:11435\n",
    ] {
        assert!(parse_lsof_listener(raw, 11435, "127.0.0.1").is_err());
    }
    assert_eq!(
        parse_start_time("Thu Sep 17 01:02:03 2026\n").unwrap(),
        "2026-09-17 01:02:03"
    );
    assert!(parse_start_time("Thu Sep 17 01:02:03 2026\nThu Sep 17 01:02:03 2026").is_err());
    let raw = r#"[{"pid":123,"process":"ollama.exe","executable":"C:\\Ollama\\ollama.exe","started":"2026-09-17 01:02:03","address":"127.0.0.1","port":11435}]"#;
    assert_eq!(
        parse_windows_listener(raw, 11435, "localhost")
            .unwrap()
            .identity
            .pid,
        123
    );
    assert!(parse_windows_listener("{}", 11435, "localhost").is_err());
}
