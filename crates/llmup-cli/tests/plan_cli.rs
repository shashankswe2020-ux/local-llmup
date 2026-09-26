use std::process::Command;

const GIB: u64 = 1024 * 1024 * 1024;

fn profile(root: &std::path::Path, value: serde_json::Value) -> std::path::PathBuf {
    let path = root.join("profile.json");
    std::fs::write(&path, value.to_string()).unwrap();
    path
}

fn run(args: &[&str], profile: &std::path::Path, home: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_llmup"))
        .args(args)
        .arg("--hardware")
        .arg(profile)
        .env("PATH", "")
        .env("LOCAL_LLMUP_HOME", home)
        .output()
        .unwrap()
}

fn dual_gpu() -> serde_json::Value {
    serde_json::json!({
        "arch": "x64", "platform": "linux",
        "totalRamBytes": 64 * GIB, "freeRamBytes": 60 * GIB, "freeDiskBytes": 500 * GIB,
        "gpu": [{"vendor": "nvidia", "vramBytes": 24 * GIB}, {"vendor": "nvidia", "vramBytes": 24 * GIB}]
    })
}

#[test]
fn plan_reports_every_path_for_a_simulated_machine_offline() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("unused-home");
    let file = profile(root.path(), dual_gpu());
    let output = run(&["plan", "mixtral:8x7b", "--json"], &file, &home);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(plan["model"], "mixtral:8x7b");
    assert_eq!(plan["recommended"], "multi-gpu");
    let text = run(&["plan", "mixtral:8x7b"], &file, &home);
    assert!(text.status.success());
    let text = String::from_utf8(text.stdout).unwrap();
    for expected in [
        "Plan for mixtral:8x7b",
        "gpu (1 GPU)",
        "multi-gpu (2 GPUs)",
        "cpu-offload",
        "cpu",
        "needs",
        "not modeled",
        "Recommended path: multi-gpu",
    ] {
        assert!(text.contains(expected), "{expected}\n{text}");
    }
    assert!(!home.exists(), "plan must not create state");
}

#[test]
fn plan_exits_nonzero_when_no_path_fits_and_rejects_unknown_models() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("unused-home");
    let small = profile(
        root.path(),
        serde_json::json!({
            "arch": "x64", "platform": "win32",
            "totalRamBytes": 8 * GIB, "freeRamBytes": 6 * GIB, "freeDiskBytes": 500 * GIB,
            "gpu": [{"vendor": "nvidia", "vramBytes": 8 * GIB}]
        }),
    );
    let output = run(&["plan", "llama3.1:70b"], &small, &home);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("No path fits")
    );
    let unknown = run(&["plan", "not-a-real-model:1b"], &small, &home);
    assert_ne!(unknown.status.code(), Some(0));
    let missing = Command::new(env!("CARGO_BIN_EXE_llmup"))
        .args(["plan", "--json"])
        .env("LOCAL_LLMUP_HOME", &home)
        .output()
        .unwrap();
    assert_ne!(missing.status.code(), Some(0));
}

#[test]
fn hardware_profiles_drive_advice_and_are_strictly_validated() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("unused-home");
    let file = profile(root.path(), dual_gpu());
    let output = run(&["can-run", "qwen3:8b", "--json"], &file, &home);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let verdict: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(verdict["verdict"], "yes");
    for invalid in [
        serde_json::json!({"arch": "x64"}),
        serde_json::json!({"arch": "x64", "platform": "linux", "totalRamBytes": 1, "freeRamBytes": 1,
            "freeDiskBytes": 1, "gpu": [], "surprise": true}),
        serde_json::json!({"arch": "x64", "platform": "linux", "totalRamBytes": -5, "freeRamBytes": 1,
            "freeDiskBytes": 1, "gpu": []}),
    ] {
        let file = profile(root.path(), invalid);
        let output = run(&["can-run", "qwen3:8b", "--json"], &file, &home);
        assert_ne!(output.status.code(), Some(0));
    }
    let huge = root.path().join("huge.json");
    std::fs::write(&huge, vec![b' '; 70_000]).unwrap();
    assert_ne!(
        run(&["plan", "qwen3:8b"], &huge, &home).status.code(),
        Some(0)
    );
    let both = Command::new(env!("CARGO_BIN_EXE_llmup"))
        .args(["can-run", "qwen3:8b", "--hardware"])
        .arg(&file)
        .args(["--hardware-json", &dual_gpu().to_string()])
        .env("LOCAL_LLMUP_HOME", &home)
        .output()
        .unwrap();
    assert_ne!(both.status.code(), Some(0));
    assert!(!home.exists());
}
