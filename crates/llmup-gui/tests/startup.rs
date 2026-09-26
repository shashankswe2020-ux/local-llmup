use llmup_gui::{Host, options::StartupOptions};
use serde_json::json;
use std::io::Write;
use std::process::{Command, Output, Stdio};

fn advice_request() -> serde_json::Value {
    json!({"hardware": {
        "arch":"arm64", "platform":"darwin",
        "totalRamBytes":34359738368_u64, "freeRamBytes":25769803776_u64,
        "freeDiskBytes":536870912000_u64, "gpu":[{"vendor":"apple","vramBytes":0}]
    }})
}

fn advice_output(input: &[u8], args: &[&str]) -> Output {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("untouched");
    let mut child = Command::new(env!("CARGO_BIN_EXE_llmup-gui"))
        .args(args)
        .current_dir(directory.path())
        .env_clear()
        .env("PATH", "")
        .env("LOCAL_LLMUP_HOME", &home)
        .env("LOCAL_LLMUP_HARNESS", "invalid")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn({
        let input = input.to_vec();
        move || stdin.write_all(&input)
    });
    let output = child.wait_with_output().unwrap();
    let _ = writer.join().unwrap();
    assert!(output.stderr.is_empty(), "{output:?}");
    assert!(!home.exists(), "advice must not initialize state");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    output
}

#[test]
fn advice_json_is_deterministic_offline_and_preserves_model_shape() {
    let request = advice_request();
    let first = advice_output(request.to_string().as_bytes(), &["--advice-json"]);
    assert!(first.status.success(), "{first:?}");
    let second = advice_output(request.to_string().as_bytes(), &["--advice-json"]);
    assert!(second.status.success());
    assert_eq!(first.stdout, second.stdout);
    let response: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(response.as_object().unwrap().len(), 1);
    let hardware = serde_json::from_value(request["hardware"].clone()).unwrap();
    let catalog =
        llmup_core::catalog::Catalog::parse(include_str!("../../llmup-core/data/models.json"))
            .unwrap();
    let perf =
        llmup_core::catalog::PerfDataset::parse(include_str!("../../llmup-core/data/perf.json"))
            .unwrap();
    let expected =
        llmup_gui::models::recommended(&catalog, &hardware, &perf, &Default::default(), 8).unwrap();
    assert_eq!(
        first.stdout,
        format!("{}\n", json!({"models":expected})).into_bytes()
    );
    assert_eq!(response["models"].as_array().unwrap().len(), 8);
    assert_eq!(
        first.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
}

#[test]
fn advice_json_honors_limits_and_context_backend_options() {
    for limit in [1, 8, 12, 100] {
        let mut request = advice_request();
        request["options"] = json!({"limit":limit});
        let output = advice_output(request.to_string().as_bytes(), &["--advice-json"]);
        assert!(output.status.success(), "{output:?}");
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let models = response["models"].as_array().unwrap();
        assert!(models.len() <= limit);
        if limit <= 12 {
            assert_eq!(models.len(), limit);
        } else {
            assert!(models.len() >= 12);
        }
    }
    for options in [
        json!({"context":4096,"backend":"llamacpp"}),
        json!({"contextPercent":25,"backend":"mlx"}),
    ] {
        let mut request = advice_request();
        request["options"] = options;
        let output = advice_output(request.to_string().as_bytes(), &["--advice-json"]);
        assert!(output.status.success(), "{output:?}");
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let models = response["models"].as_array().unwrap();
        assert!(!models.is_empty());
        for model in models {
            let expected = request["options"]["context"]
                .as_f64()
                .unwrap_or_else(|| model["contextLength"].as_f64().unwrap() * 0.25);
            assert_eq!(model["contextTokens"].as_f64().unwrap(), expected);
        }
    }
}

#[test]
fn advice_json_rejects_invalid_requests_without_echoing_input() {
    let valid = advice_request();
    let mut requests = vec![
        json!({}),
        json!(null),
        json!([]),
        json!({"hardware":valid["hardware"],"secret":true}),
    ];
    for options in [
        json!({"limit":0}),
        json!({"limit":101}),
        json!({"limit":1.5}),
        json!({"limit":"8"}),
        json!({"context":0}),
        json!({"context":1.5}),
        json!({"context":10000001}),
        json!({"context":4096,"contextPercent":25}),
        json!({"contextPercent":26}),
        json!({"backend":"secret"}),
        json!({"task":"chat"}),
        json!({"maxContext":true}),
        json!({"availableBackends":[]}),
        json!({"secret":true}),
        json!(null),
    ] {
        requests.push(json!({"hardware":valid["hardware"],"options":options}));
    }
    for (field, value) in [
        ("arch", json!("secret")),
        ("platform", json!("unknown")),
        ("totalRamBytes", json!(-1)),
        ("freeRamBytes", json!(0.5)),
        ("freeDiskBytes", json!(9007199254740992_u64)),
        ("secret", json!(true)),
        ("gpu", json!([{"vendor":"apple","vramBytes":-1}])),
        (
            "gpu",
            json!([{"vendor":"apple","vramBytes":0,"secret":true}]),
        ),
        (
            "gpu",
            json!(vec![json!({"vendor":"apple","vramBytes":0}); 129]),
        ),
    ] {
        let mut request = valid.clone();
        request["hardware"][field] = value;
        requests.push(request);
    }
    let mut inputs: Vec<Vec<u8>> = requests
        .iter()
        .map(|request| request.to_string().into_bytes())
        .collect();
    inputs.extend([
        b"".to_vec(),
        b"{".to_vec(),
        b"{}{}".to_vec(),
        vec![0xff],
        format!(
            "{{\"hardware\":{},\"options\":{{\"limit\":1,\"limit\":2}}}}",
            valid["hardware"]
        )
        .into_bytes(),
        format!("{} trailing", valid).into_bytes(),
    ]);
    for input in inputs {
        let output = advice_output(&input, &["--advice-json"]);
        assert!(
            !output.status.success(),
            "accepted {}",
            String::from_utf8_lossy(&input)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
            json!({"error":{"code":"INVALID_REQUEST"}})
        );
    }
}

#[test]
fn advice_json_enforces_64_kib_input_boundary() {
    let mut input = advice_request().to_string().into_bytes();
    input.resize(64 * 1024, b' ');
    let output = advice_output(&input, &["--advice-json"]);
    assert!(output.status.success(), "{output:?}");
    input.push(b' ');
    let output = advice_output(&input, &["--advice-json"]);
    assert!(!output.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        json!({"error":{"code":"REQUEST_TOO_LARGE"}})
    );
}

#[test]
fn advice_json_is_standalone_and_rejects_all_other_arguments() {
    assert!(StartupOptions::parse(["--advice-json".to_owned()]).is_ok());
    for other in [
        "--port=0",
        "--harness=local",
        "--startup-json",
        "--version",
        "--advice-json",
        "--unknown",
    ] {
        for args in [["--advice-json", other], [other, "--advice-json"]] {
            assert!(StartupOptions::parse(args.map(str::to_owned)).is_err());
            let output = advice_output(b"", &args);
            assert!(!output.status.success());
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
                json!({"error":{"code":"INVALID_ARGUMENTS"}})
            );
        }
    }
    assert!(StartupOptions::parse(["--advice-json=true".to_owned()]).is_err());
}

fn parse(args: &[&str]) -> StartupOptions {
    StartupOptions::parse(args.iter().map(|arg| (*arg).to_owned())).unwrap()
}

#[test]
fn companion_version_is_available_without_environment_state_or_server() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("untouched");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_llmup-gui"))
        .arg("--version")
        .current_dir(directory.path())
        .env_clear()
        .env("PATH", "")
        .env("LOCAL_LLMUP_HOME", &home)
        .env("LOCAL_LLMUP_HARNESS", "invalid")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("llmup-gui {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(output.stderr.is_empty());
    assert!(!home.exists());
}

#[cfg(unix)]
#[test]
fn host_shuts_down_gracefully_on_interrupt_terminate_and_hangup() {
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant};
    for signal in ["INT", "TERM", "HUP"] {
        let directory = tempfile::tempdir().unwrap();
        let port = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut child = Command::new(env!("CARGO_BIN_EXE_llmup-gui"))
            .args(["--port", &port.to_string(), "--startup-json"])
            .env_clear()
            .env("PATH", "")
            .env("HOME", directory.path())
            .env("LOCAL_LLMUP_HOME", directory.path().join("state"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert!(ready.contains(&format!("\"port\":{port}")), "{ready}");
        assert!(
            Command::new("/bin/kill")
                .args(["-s", signal, &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("{signal}: host did not shut down");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(status.code(), Some(0), "{signal}: {status:?}");
        assert!(
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok(),
            "{signal}: port must be released"
        );
    }
}

#[tokio::test]
async fn direct_defaults_and_existing_host_api_are_preserved() {
    let options = parse(&[]);
    assert_eq!(options.port(), 0);
    let home = tempfile::tempdir().unwrap();
    let host = options
        .create_host(home.path(), 4321, Some("openai"))
        .await
        .unwrap();
    assert_eq!(host.ui.lock().await.harness, "local");
    assert_eq!(
        options.readiness(&host).await.unwrap(),
        "http://127.0.0.1:4321"
    );
    assert_eq!(
        Host::new(home.path(), 4322)
            .unwrap()
            .ui
            .lock()
            .await
            .harness,
        "local"
    );
}

#[tokio::test]
async fn direct_defaults_do_not_require_native_runtime_environment() {
    if std::env::var_os("LLMUP_TEST_DIRECT_GUI_DEFAULTS").is_some() {
        let home = tempfile::tempdir().unwrap();
        let host = parse(&[])
            .create_host(home.path(), 4321, None)
            .await
            .unwrap();
        assert_eq!(host.ui.lock().await.harness, "local");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "direct_defaults_do_not_require_native_runtime_environment",
            "--nocapture",
        ])
        .env("LLMUP_TEST_DIRECT_GUI_DEFAULTS", "1")
        .env_remove("HOME")
        .env_remove("USERPROFILE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[tokio::test]
async fn cli_harness_precedence_uses_actual_host_state_and_token_free_json() {
    let home = tempfile::tempdir().unwrap();
    for (args, env, expected) in [
        (vec!["--startup-json"], None, "local"),
        (vec!["--startup-json"], Some(" openai "), "openai"),
        (
            vec!["--port", "4321", "--startup-json", "--harness", " claude "],
            Some("openai"),
            "claude",
        ),
        (
            vec!["--harness=opencode", "--port=4321", "--startup-json"],
            Some("invalid"),
            "opencode",
        ),
        (
            vec!["--startup-json", "--harness=openai-compatible"],
            None,
            "openai-compatible",
        ),
    ] {
        let options = parse(&args);
        let host = options.create_host(home.path(), 4321, env).await.unwrap();
        assert_eq!(host.ui.lock().await.harness, expected);
        let line = options.readiness(&host).await.unwrap();
        assert!(!line.contains(&host.token));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap(),
            json!({
                "url": "http://127.0.0.1:4321", "harness": expected, "port": 4321
            })
        );
    }
}

#[tokio::test]
async fn invalid_harness_fails_before_creating_state_and_redacts_input() {
    for harness in ["", "  ", "unknown", "secret\n\u{1b}[31m"] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("untouched");
        let options = parse(&["--startup-json"]);
        let error = options
            .create_host(&path, 4321, Some(harness))
            .await
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret"));
        assert!(!path.exists());
    }
}

#[test]
fn option_parser_rejects_missing_duplicate_unknown_and_invalid_values() {
    for args in [
        vec!["--port"],
        vec!["--harness"],
        vec!["--port", "-1"],
        vec!["--port", "65536"],
        vec!["--port", "4e3"],
        vec!["--port", " 4000"],
        vec!["--port", "1", "--port", "2"],
        vec!["--harness=local", "--harness=claude"],
        vec!["--startup-json", "--startup-json"],
        vec!["--startup-json=true"],
        vec!["--version", "--port=0"],
        vec!["--harness=local", "--version"],
        vec!["--version", "--startup-json"],
        vec!["--version", "--version"],
        vec!["--version=true"],
        vec!["--unknown=secret"],
        vec!["secret"],
    ] {
        let error = StartupOptions::parse(args.iter().map(|arg| (*arg).to_owned())).unwrap_err();
        assert!(!error.to_string().contains("secret"));
    }
    assert_eq!(parse(&["--port", "0"]).port(), 0);
    assert_eq!(parse(&["--port=65535"]).port(), 65535);
}
