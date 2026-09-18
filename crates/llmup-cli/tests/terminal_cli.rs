use std::process::{Command, Stdio};

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
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
            .args(args)
            .env("PATH", "")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
