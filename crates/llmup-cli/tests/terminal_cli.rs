use std::process::{Command, Stdio};

fn accessible_cancellation(args: &[&str], answer: &[u8]) -> (u32, String) {
    accessible_cancellation_with_state(args, answer, None)
}

fn accessible_cancellation_with_state(
    args: &[&str],
    answer: &[u8],
    backend: Option<&str>,
) -> (u32, String) {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::{
        io::{Read, Write},
        sync::mpsc,
        time::{Duration, Instant},
    };

    struct Cleanup(Box<dyn portable_pty::Child + Send + Sync>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let home = tempfile::tempdir().unwrap();
    let unused = home.path().join("unused");
    let prior = backend.map(|backend| {
        use llmup_runtime::state::{Config, RuntimeState, StateStore};
        let store = StateStore::new(Config::from_home(&unused).unwrap());
        let mut raw = serde_json::json!({
            "schemaVersion": 2, "active": {"backend": backend, "modelId": "llama3.1:8b",
                "endpoint": "http://127.0.0.1:18080", "port": 18080, "ownedByUs": backend == "mlx",
                "pid": 123, "processExecutable": "/fixture/runtime", "processStartedAt": "fixture-start"}
            });
            if backend == "mlx" {
                raw["active"]["authToken"] = serde_json::json!("a".repeat(64));
            }
            if backend == "lmstudio" {
                raw["active"]["modelPath"] = serde_json::json!("fixture/model.gguf");
            }
            let state = RuntimeState::parse(&raw.to_string()).unwrap();
        let guard = store.lock(Duration::from_secs(1)).unwrap();
        store.write(&guard, &state).unwrap();
        guard.release().unwrap();
        std::fs::read(&store.config.state).unwrap()
    });
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_llmup-native"));
    command.args(args);
    command.arg("--accessible");
    command.env("LOCAL_LLMUP_HOME", &unused);
    command.env("PATH", "");
    command.env("TERM", "xterm-256color");
    for name in [
        "LOCAL_LLMUP_TUI",
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "TF_BUILD",
        "BUILDKITE",
        "JENKINS_URL",
    ] {
        command.env_remove(name);
    }
    let mut child = Cleanup(pair.slave.spawn_command(command).unwrap());
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 || sender.send(buffer[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    writer.write_all(answer).unwrap();
    writer.flush().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    let exit = loop {
        assert!(Instant::now() < deadline, "PTY deadline: {args:?}");
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(bytes) => output.extend_from_slice(&bytes),
            Err(mpsc::RecvTimeoutError::Disconnected) => break child.0.wait().unwrap(),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(exit) = child.0.try_wait().unwrap() {
                    break exit;
                }
            }
        }
        assert!(output.len() < 1024 * 1024);
    };
    drop(writer);
    drop(pair.master);
    for bytes in receiver.iter() {
        output.extend_from_slice(&bytes);
    }
    reader_thread.join().unwrap();
    if let Some(prior) = prior {
        assert_eq!(std::fs::read(unused.join("state.json")).unwrap(), prior);
        assert!(!unused.join("lock").exists());
    } else {
        assert!(!unused.exists(), "cancellation created state: {args:?}");
    }
    (
        exit.exit_code(),
        String::from_utf8_lossy(&output).into_owned(),
    )
}

#[test]
fn accessible_model_picker_cancellation_matches_legacy_exit() {
    for command in ["can-run", "up", "switch"] {
        let (exit, output) = accessible_cancellation(&[command], b"q\r");
        assert_eq!(exit, 130, "{command}: {output}");
        assert!(output.contains("Enter a model number, or q to cancel."));
        assert!(!output.contains("Confirm activation"));
    }
}

#[test]
fn switch_picker_without_backend_eligible_targets_cancels_before_preparation() {
    for backend in ["llamacpp", "mlx", "lmstudio"] {
        let (exit, output) = accessible_cancellation_with_state(&["switch"], b"", Some(backend));
        assert_eq!(exit, 130, "{backend}: {output}");
        assert!(!output.contains("Enter a model number"));
        assert!(!output.contains("Confirm activation"));
        assert!(!output.contains("Switched"));
    }
}

#[test]
fn accessible_confirmation_cancellation_preserves_enter_default() {
    for args in [
        vec!["up", "llama3.1:8b"],
        vec!["switch", "llama3.1:8b"],
        vec!["down"],
    ] {
        for answer in [b"\r".as_slice(), b"1\r", b"q\r"] {
            let (exit, output) = accessible_cancellation(&args, answer);
            assert_eq!(exit, 130, "{args:?}: {output}");
            assert!(output.contains("1. Cancel (default)"));
        }
    }
    let (exit, output) = accessible_cancellation(&["up"], b"1\r\r");
    assert_eq!(exit, 130, "{output}");
    assert!(output.contains("Confirm activation"));
}

#[test]
fn eof_chat_is_native_and_does_not_create_state_or_need_a_runtime() {
    for accessible in [false, true] {
        let home = std::env::temp_dir().join(format!(
            "llmup-native-eof-{}-{accessible}",
            std::process::id()
        ));
        assert!(!home.exists());
        let mut command = Command::new(env!("CARGO_BIN_EXE_llmup-native"));
        command
            .arg("chat")
            .env("LOCAL_LLMUP_HOME", &home)
            .env("PATH", "")
            .stdin(Stdio::null());
        if accessible {
            command.arg("--accessible");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            if accessible {
                "Chat session ended: 0 turns, 0 memory warnings.\n"
            } else {
                ""
            }
        );
        assert!(!home.exists());
    }
}

#[test]
fn incompatible_modes_and_missing_remote_model_fail_before_work() {
    for args in [
        vec!["chat", "--accessible", "--json"],
        vec!["chat", "--accessible", "--no-tui"],
        vec!["chat", "--accessible", "--message", "hello"],
        vec!["recommend", "--accessible"],
        vec!["chat", "--harness", "openai"],
        vec!["up", "llama3.1:8b", "--accessible", "--json"],
        vec!["down", "--accessible", "--no-tui"],
        vec!["down", "--accessible"],
        vec!["ls", "--accessible"],
        vec!["doctor", "--accessible"],
        vec!["ls", "--accessible", "--json"],
        vec!["doctor", "--accessible", "--no-tui"],
        vec!["can-run", "llama3.1:8b", "--accessible"],
        vec!["can-run", "llama3.1:8b", "--accessible", "--json"],
        vec!["can-run", "llama3.1:8b", "--accessible", "--no-tui"],
    ] {
        let home = tempfile::tempdir().unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .env("PATH", "")
            .env("LOCAL_LLMUP_HOME", home.path().join("unused"))
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!home.path().join("unused").exists());
    }
}

#[test]
fn eof_chat_accepts_native_and_legacy_options_without_io() {
    for args in [
        vec!["chat", "-m", "model", "--harness", "local", "--no-memory"],
        vec!["chat", "--model=model", "--harness=openai", "--no-tui"],
        vec![
            "chat",
            "--agent",
            "assistant",
            "--skill",
            "first",
            "--skill",
            "second",
            "--no-color",
        ],
    ] {
        let home = tempfile::tempdir().unwrap();
        let unused = home.path().join("unused");
        let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(&args)
            .env("PATH", "")
            .env("LOCAL_LLMUP_HOME", &unused)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {:?}", output.stderr);
        assert!(output.stdout.is_empty());
        assert!(!unused.exists());
    }
}
