use std::{path::Path, process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

const DEADLINE: Duration = Duration::from_secs(20);

fn aliases() -> [&'static str; 2] {
    [env!("CARGO_BIN_EXE_llmup"), env!("CARGO_BIN_EXE_rigspark")]
}

fn isolated_command(binary: &Path, directory: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .env_clear()
        .env("HOME", directory)
        .env("USERPROFILE", directory)
        .env("RIGSPARK_HOME", directory.join("state"))
        .env("PATH", "")
        .env("TERM", "dumb")
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    command
}

fn install(directory: &Path) -> Vec<std::path::PathBuf> {
    aliases()
        .into_iter()
        .map(|source| {
            let source = Path::new(source);
            let destination = directory.join(source.file_name().unwrap());
            std::fs::copy(source, &destination).unwrap();
            destination
        })
        .collect()
}

fn install_companion(directory: &Path) {
    let source = Path::new(env!("CARGO_BIN_EXE_llmup")).with_file_name(if cfg!(windows) {
        "rigspark-gui.exe"
    } else {
        "rigspark-gui"
    });
    assert!(
        source.is_file(),
        "build the matching rigspark-gui package first"
    );
    std::fs::copy(&source, directory.join(source.file_name().unwrap())).unwrap();
}

fn unused_port() -> u16 {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn missing_companion_is_actionable_once_prefixed_and_redacted() {
    let directory = tempfile::Builder::new()
        .prefix("c05 secret installation ")
        .tempdir()
        .unwrap();
    for binary in install(directory.path()) {
        let output = timeout(
            DEADLINE,
            isolated_command(&binary, directory.path())
                .args(["gui", "--no-open", "--json"])
                .output(),
        )
        .await
        .expect("missing-companion failure must be bounded")
        .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            "gui: installed rigspark-gui executable is missing; reinstall the complete native distribution\n"
        );
        assert!(!directory.path().join("state").exists());
    }
}

#[tokio::test]
#[ignore = "controlled native GUI integration; first cargo build --offline --locked -p rigspark-gui"]
async fn native_startup_failures_are_bounded_once_prefixed_and_redacted() {
    for invalid_config in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let binaries = install(directory.path());
        install_companion(directory.path());
        if invalid_config {
            std::fs::write(directory.path().join("state"), "secret-config-sentinel").unwrap();
        }
        for binary in binaries {
            let port = unused_port();
            let mut command = isolated_command(&binary, directory.path());
            command.args(["gui", "--json", "--port", &port.to_string()]);
            if !invalid_config {
                command.env("RIGSPARK_HARNESS", "secret-invalid-env\n\u{1b}[31m");
            }
            let output = timeout(DEADLINE, command.output())
                .await
                .expect("native startup failure must be bounded")
                .unwrap();
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert_eq!(
                String::from_utf8(output.stderr).unwrap(),
                "gui: GUI exited before reporting readiness\n"
            );
            assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
            if invalid_config {
                assert_eq!(
                    std::fs::read(directory.path().join("state")).unwrap(),
                    b"secret-config-sentinel"
                );
            } else {
                assert!(!directory.path().join("state").exists());
            }
        }
    }
}

#[tokio::test]
async fn invalid_public_options_and_private_protocol_fail_before_launch() {
    let directory = tempfile::tempdir().unwrap();
    for binary in install(directory.path()) {
        for args in [
            vec!["gui", "--startup-json"],
            vec!["gui", "--no-open", "--port", "0"],
            vec![
                "gui",
                "--json",
                "--harness",
                "secret-invalid-harness\n\u{1b}[31m",
            ],
        ] {
            let output = timeout(
                DEADLINE,
                isolated_command(&binary, directory.path())
                    .args(args)
                    .output(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            let error = String::from_utf8(output.stderr).unwrap();
            assert!(error.starts_with("gui: "));
            assert_eq!(error.matches("gui:").count(), 1, "{error}");
            assert_eq!(error.lines().count(), 1);
            assert!(!error.contains("secret"));
            assert!(!error.contains("\u{1b}"));
            assert!(!error.contains("reinstall"));
            assert!(!directory.path().join("state").exists());
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod native_smoke {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::{Ipv4Addr, TcpListener, TcpStream},
        process::{Child, Command as StdCommand, ExitStatus},
        sync::mpsc,
        thread,
        time::Instant,
    };

    fn signal(pid: u32, name: &str) -> bool {
        StdCommand::new("/bin/kill")
            .args(["-s", name, &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn companions(pid: u32) -> Vec<u32> {
        let output = StdCommand::new("/bin/ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let child = fields.next()?.parse::<u32>().ok()?;
                let parent = fields.next()?.parse::<u32>().ok()?;
                (parent == pid).then_some(child)
            })
            .collect()
    }

    struct OwnedCli(Child);

    impl OwnedCli {
        fn wait(&mut self, limit: Duration) -> Option<ExitStatus> {
            let deadline = Instant::now() + limit;
            loop {
                if let Some(status) = self.0.try_wait().unwrap() {
                    return Some(status);
                }
                if Instant::now() >= deadline {
                    return None;
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    impl Drop for OwnedCli {
        fn drop(&mut self) {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            let children = companions(self.0.id());
            signal(self.0.id(), "INT");
            if self.wait(Duration::from_secs(8)).is_none() {
                for pid in children {
                    signal(pid, "KILL");
                }
                let _ = self.0.kill();
                let _ = self.wait(Duration::from_secs(3));
            }
        }
    }

    fn request(port: u16, method: &str, path: &str, host: &str, headers: &str) -> (u16, String) {
        let limit = Duration::from_secs(3);
        let mut stream = TcpStream::connect_timeout(
            &std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            limit,
        )
        .unwrap();
        stream.set_read_timeout(Some(limit)).unwrap();
        stream.set_write_timeout(Some(limit)).unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n{headers}\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream
            .take(2 * 1024 * 1024)
            .read_to_string(&mut response)
            .unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, body.to_owned())
    }

    fn check_boundary(port: u16, harness: &str) -> String {
        let host = format!("127.0.0.1:{port}");
        let origin = format!("http://{host}");
        let (status, body) = request(port, "GET", "/api/status", &host, "");
        assert_eq!(status, 200);
        let state: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(state["harness"], harness);
        assert_eq!(state["memory"]["turns"], 0);
        let (status, html) = request(port, "GET", "/", &host, "");
        assert_eq!(status, 200);
        let token = html
            .split_once("<meta name=\"llmup-token\" content=\"")
            .unwrap()
            .1
            .split_once('"')
            .unwrap()
            .0;
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        for headers in ["", "x-llmup-token: wrong-token\r\n"] {
            assert_eq!(
                request(port, "GET", "/api/workspace/status", &host, headers).0,
                403
            );
        }
        let headers = format!("x-llmup-token: {token}\r\n");
        assert_eq!(
            request(port, "GET", "/api/workspace/status", &host, &headers).0,
            200
        );
        assert_eq!(
            request(port, "GET", "/api/status", "foreign.invalid", "").0,
            400
        );
        for headers in [
            "Origin: http://foreign.invalid\r\n",
            "Sec-Fetch-Site: cross-site\r\n",
        ] {
            assert_eq!(request(port, "GET", "/api/status", &host, headers).0, 403);
        }
        assert_eq!(request(port, "POST", "/api/harness", &host, "").0, 403);
        let headers = format!("Origin: {origin}\r\nx-llmup-token: {token}\r\n");
        assert_eq!(
            request(port, "GET", "/api/workspace/status", &host, &headers).0,
            200
        );
        token.to_owned()
    }

    fn check_loopback_listener(pid: u32, port: u16) {
        if cfg!(target_os = "macos") {
            let output = StdCommand::new("/usr/sbin/lsof")
                .args([
                    "-nP",
                    "-a",
                    "-p",
                    &pid.to_string(),
                    "-iTCP",
                    "-sTCP:LISTEN",
                    "-Fn",
                ])
                .output()
                .unwrap();
            assert!(output.status.success());
            let listeners = String::from_utf8(output.stdout).unwrap();
            let addresses: Vec<_> = listeners
                .lines()
                .filter_map(|line| line.strip_prefix('n'))
                .collect();
            assert_eq!(addresses, [format!("127.0.0.1:{port}")]);
        } else {
            let other_loopback = TcpListener::bind((Ipv4Addr::new(127, 0, 0, 2), port))
                .expect("GUI must not bind a wildcard interface");
            drop(other_loopback);
        }
    }

    #[test]
    #[ignore = "controlled loopback smoke; first cargo build --offline --locked -p rigspark-gui"]
    fn public_aliases_start_native_gui_and_reap_it_without_runtime_or_browser() {
        for alias in 0..2 {
            for (json, no_open, explicit, environment, harness, shutdown, code) in [
                (false, true, None, None, "local", "INT", 130),
                (
                    true,
                    false,
                    Some(" openai "),
                    Some("secret-invalid-env"),
                    "openai",
                    "TERM",
                    143,
                ),
                (true, true, None, Some(" claude "), "claude", "INT", 130),
                (true, false, None, None, "local", "TERM", 143),
                (false, true, None, None, "local", "HUP", 129),
            ] {
                let directory = tempfile::Builder::new()
                    .prefix("c05 native install ")
                    .tempdir()
                    .unwrap();
                let binaries = install(directory.path());
                install_companion(directory.path());
                let port = unused_port();
                let mut command = isolated_command(&binaries[alias], directory.path());
                command.args(["gui", "--port", &port.to_string()]);
                if json {
                    command.arg("--json");
                }
                if no_open {
                    command.arg("--no-open");
                }
                if let Some(harness) = explicit {
                    command.args(["--harness", harness]);
                }
                if let Some(harness) = environment {
                    command.env("RIGSPARK_HARNESS", harness);
                }
                let stderr = directory.path().join("stderr");
                command.stderr(std::fs::File::create(&stderr).unwrap());
                let mut process = OwnedCli(command.as_std_mut().spawn().unwrap());
                let stdout = process.0.stdout.take().unwrap();
                let (sender, receiver) = mpsc::channel();
                thread::spawn(move || {
                    for line in BufReader::new(stdout.take(16 * 1024)).lines() {
                        if sender.send(line.unwrap()).is_err() {
                            break;
                        }
                    }
                });
                let startup = receiver
                    .recv_timeout(DEADLINE)
                    .expect("bounded startup record");
                let url = format!("http://127.0.0.1:{port}");
                if json {
                    assert_eq!(
                        serde_json::from_str::<serde_json::Value>(&startup).unwrap(),
                        serde_json::json!({"url": url, "harness": harness, "port": port})
                    );
                } else {
                    assert_eq!(startup, format!("rigspark GUI listening at {url}"));
                }
                let children = companions(process.0.id());
                assert_eq!(
                    children.len(),
                    1,
                    "one installed GUI companion must be supervised"
                );
                let token = check_boundary(port, harness);
                assert!(!startup.contains(&token));
                check_loopback_listener(children[0], port);
                assert!(signal(process.0.id(), shutdown));
                let status = process
                    .wait(Duration::from_secs(8))
                    .expect("bounded shutdown");
                assert_eq!(status.code(), Some(code));
                if shutdown != "HUP" {
                    assert_eq!(
                        receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
                        "Stopped."
                    );
                }
                assert!(matches!(
                    receiver.recv_timeout(Duration::from_secs(1)),
                    Err(mpsc::RecvTimeoutError::Disconnected)
                ));
                assert!(std::fs::read(&stderr).unwrap().is_empty());
                assert!(!signal(children[0], "0"), "GUI companion must be reaped");
                assert!(
                    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok(),
                    "GUI port must be released"
                );
                let config =
                    rigspark_runtime::state::Config::from_home(directory.path().join("state"))
                        .unwrap();
                assert!(!config.state.exists());
                assert!(!config.lock.exists());
                assert!(!config.staging.exists());
            }
        }
    }
}
