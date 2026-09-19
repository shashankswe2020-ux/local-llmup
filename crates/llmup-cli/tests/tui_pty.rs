use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::{
    io::{Read, Write},
    sync::mpsc,
    time::{Duration, Instant},
};

const HARDWARE: &str = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[{"vendor":"nvidia","vramBytes":25769803776}]}"#;

struct Cleanup(Box<dyn portable_pty::Child + Send + Sync>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run(extra: &[&str], columns: u16, rows: u16, keys: Option<&[u8]>) -> (u32, String) {
    run_command("recommend", extra, columns, rows, keys)
}

fn run_command(
    name: &str,
    extra: &[&str],
    columns: u16,
    rows: u16,
    keys: Option<&[u8]>,
) -> (u32, String) {
    let home = tempfile::tempdir().unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_llmup-native"));
    command.arg(name);
    if name != "chat" {
        command.args(["--hardware-json", HARDWARE]);
    }
    command.args(extra);
    command.env("TERM", "xterm-256color");
    command.env("NO_COLOR", "");
    command.env("PATH", "");
    command.env("LOCAL_LLMUP_HOME", home.path().join("unused"));
    for name in [
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
    let (sender, receiver) = mpsc::sync_channel(16);
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut output = Vec::new();
    let mut sent = false;
    let exit = loop {
        assert!(
            Instant::now() < deadline,
            "PTY deadline: {}",
            String::from_utf8_lossy(&output)
        );
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
        if !sent && output.windows(8).any(|bytes| bytes == b"\x1b[?1049h") {
            if let Some(keys) = keys {
                writer.write_all(keys).unwrap();
                writer.flush().unwrap();
            }
            sent = true;
        }
    };
    drop(writer);
    drop(pair.master);
    for bytes in receiver.iter() {
        output.extend_from_slice(&bytes);
    }
    reader_thread.join().unwrap();
    assert!(!home.path().join("unused").exists());
    (
        exit.exit_code(),
        String::from_utf8_lossy(&output).into_owned(),
    )
}

#[test]
fn visual_report_accepts_search_and_restores_terminal_on_exit() {
    let (exit, output) = run(&["--tui"], 80, 24, Some(b"/qwen\rn\x1b[Bq"));
    assert_eq!(exit, 0, "{output}");
    assert!(output.contains("\x1b[?1049h"));
    assert!(output.contains("\x1b[?1049l"));
    assert!(output.contains("recommend"));
}

#[test]
fn small_terminal_falls_back_but_explicit_request_fails_before_rendering() {
    let (exit, output) = run(&[], 40, 10, None);
    assert_eq!(exit, 0, "{output}");
    assert!(!output.contains("\x1b[?1049h"));
    let (exit, output) = run(&["--tui"], 40, 10, None);
    assert_ne!(exit, 0);
    assert!(output.contains("terminal_width"));
    assert!(!output.contains("\x1b[?1049h"));
}

#[test]
fn raw_control_c_restores_terminal_and_returns_130() {
    let (exit, output) = run(&["--tui"], 80, 24, Some(&[3]));
    assert_eq!(exit, 130, "{output}");
    assert!(output.contains("\x1b[?1049l"));
}

#[test]
fn visual_chat_can_exit_without_runtime_or_state_access() {
    let (exit, output) = run_command("chat", &["--tui"], 80, 24, Some(b"\x1b"));
    assert_eq!(exit, 0, "{output}");
    assert!(output.contains("\x1b[?1049l"));
    assert!(output.contains("Chat session ended: 0 turns, 0 memory warnings."));
}

#[test]
fn model_picker_and_lifecycle_confirmation_cancel_before_side_effects() {
    for (name, extra) in [
        ("can-run", vec!["--tui"]),
        ("up", vec!["llama3.1:8b", "--tui"]),
        ("switch", vec!["llama3.1:8b", "--tui"]),
        ("down", vec!["--tui"]),
    ] {
        let (exit, output) = run_command(name, &extra, 80, 24, Some(b"\x1b"));
        assert_eq!(exit, 0, "{name}: {output}");
        assert!(output.contains("\x1b[?1049l"), "{name}: {output}");
    }
}
