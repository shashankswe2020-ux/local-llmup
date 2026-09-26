use llmup_cli::distribution::{package_directory, verify_directory};

#[test]
fn archive_names_preserve_version_and_target() {
    let directory = std::path::Path::new("target/local-llmup-0.11.4-aarch64-apple-darwin-123");
    assert_eq!(
        llmup_cli::distribution::archive_path(directory).unwrap(),
        std::path::Path::new("target/local-llmup-0.11.4-aarch64-apple-darwin-123.tar.gz")
    );
}

#[test]
fn native_distribution_has_no_launcher_and_rejects_tampering_or_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("native");
    std::fs::write(&input, b"native fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&input, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let output = root.path().join("package");
    let files = [
        ("llmup", input.as_path()),
        ("local-llmup", input.as_path()),
        ("llmup-gui", input.as_path()),
    ];
    let manifest = package_directory(&output, "0.11.4", "aarch64-apple-darwin", &files).unwrap();
    assert_eq!(manifest.signing, "unsigned");
    assert_eq!(manifest.files.len(), 3);
    assert_eq!(manifest.files[0].name, "llmup");
    verify_directory(&output).unwrap();
    assert!(package_directory(&output, "0.11.4", "aarch64-apple-darwin", &files).is_err());
    assert!(!output.join("package.json").exists());
    std::fs::write(output.join("llmup"), b"tampered").unwrap();
    assert!(verify_directory(&output).is_err());
}

#[test]
fn native_distribution_rejects_unsafe_metadata_and_paths() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("native");
    std::fs::write(&input, b"fixture").unwrap();
    for (version, target, name) in [
        ("../bad", "aarch64-apple-darwin", "llmup"),
        ("0.11.4", "unknown-target", "llmup"),
        ("0.11.4", "aarch64-apple-darwin", "../escape"),
        ("0.11.4", "aarch64-apple-darwin", "launcher.cjs"),
    ] {
        assert!(
            package_directory(
                &root.path().join("output"),
                version,
                target,
                &[(name, input.as_path())]
            )
            .is_err()
        );
    }
}

#[tokio::test]
#[ignore = "controlled C06 artifact proof; first cargo build --offline --locked -p llmup-cli --bin llmup --bin local-llmup -p llmup-gui --bin llmup-gui"]
async fn real_artifact_directory_round_trip_runs_without_node_or_source_tree() {
    use std::{fs, path::Path, process::Stdio, time::Duration};
    use tokio::{process::Command, time::timeout};

    async fn invoke(binary: &Path, args: &[&str], working: &Path) -> std::process::Output {
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(working)
            .env_clear()
            .env("PATH", "")
            .env("HOME", working)
            .env("USERPROFILE", working)
            .env("LOCAL_LLMUP_HOME", working.join("unused-state"))
            .env("TERM", "dumb")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        timeout(Duration::from_secs(20), command.output())
            .await
            .expect("artifact invocation must be bounded")
            .unwrap()
    }

    let target = match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "macos") => "aarch64-apple-darwin",
        ("x86_64", "macos") => "x86_64-apple-darwin",
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu",
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu",
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        platform => panic!("unsupported native distribution host: {platform:?}"),
    };
    let extension = std::env::consts::EXE_SUFFIX;
    let names = ["llmup", "local-llmup", "llmup-gui"].map(|name| format!("{name}{extension}"));
    let sources = [
        Path::new(env!("CARGO_BIN_EXE_llmup")).to_path_buf(),
        Path::new(env!("CARGO_BIN_EXE_local-llmup")).to_path_buf(),
        Path::new(env!("CARGO_BIN_EXE_llmup")).with_file_name(&names[2]),
    ];
    assert!(
        sources[2].is_file(),
        "build the matching llmup-gui package first"
    );
    let root = tempfile::Builder::new()
        .prefix("c06 artifact ")
        .tempdir()
        .unwrap();
    let artifact = root.path().join("artifact");
    let files: Vec<_> = names
        .iter()
        .zip(&sources)
        .map(|(name, source)| (name.as_str(), source.as_path()))
        .collect();
    package_directory(&artifact, env!("CARGO_PKG_VERSION"), target, &files).unwrap();
    let installed = root.path().join("isolated prefix");
    fs::create_dir(&installed).unwrap();
    for entry in fs::read_dir(&artifact).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), installed.join(entry.file_name())).unwrap();
    }
    fs::remove_dir_all(&artifact).unwrap();
    let manifest = verify_directory(&installed).unwrap();
    assert_eq!(manifest.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(manifest.target, target);
    assert_eq!(manifest.files.len(), 3);
    for (index, name) in names.iter().enumerate() {
        let output = invoke(&installed.join(name), &["--version"], root.path()).await;
        assert!(output.status.success(), "{name}: {output:?}");
        assert!(output.stderr.is_empty());
        let product = if index == 2 {
            "llmup-gui"
        } else {
            "local-llmup"
        };
        assert_eq!(
            output.stdout,
            format!("{product} {}\n", env!("CARGO_PKG_VERSION")).as_bytes()
        );
    }
    let mut advice = Vec::new();
    let hardware = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[]}"#;
    for name in &names[..2] {
        let binary = installed.join(name);
        let help = invoke(&binary, &["--help"], root.path()).await;
        assert!(help.status.success(), "{help:?}");
        assert!(help.stderr.is_empty());
        assert!(String::from_utf8(help.stdout).unwrap().contains("gui"));
        let output = invoke(
            &binary,
            &["--json", "--hardware-json", hardware],
            root.path(),
        )
        .await;
        assert!(output.status.success(), "{output:?}");
        assert!(output.stderr.is_empty());
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(report.is_object());
        advice.push(report);
    }
    assert_eq!(advice[0], advice[1]);
    fs::remove_file(installed.join(&names[2])).unwrap();
    assert!(verify_directory(&installed).is_err());
    for name in &names[..2] {
        let output = invoke(
            &installed.join(name),
            &["gui", "--no-open", "--json"],
            root.path(),
        )
        .await;
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"gui: installed llmup-gui executable is missing; reinstall the complete native distribution\n");
    }
    assert!(!root.path().join("unused-state").exists());
}
