use clap::{Parser, Subcommand};
use llmup_cli::distribution::{archive_path, checksum, package_directory, verify_directory};
use std::{
    fs,
    path::PathBuf,
    process::{Command, ExitCode},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(about = "Build and verify unsigned native CLI/GUI archives; never publishes")]
struct Args {
    #[command(subcommand)]
    command: Operation,
}
#[derive(Subcommand)]
enum Operation {
    Package,
    Verify { directory: PathBuf },
}

fn checked(command: &mut Command) -> Result<(), Box<dyn std::error::Error>> {
    if !command.status()?.success() {
        return Err("native build or archive command failed".into());
    }
    Ok(())
}
fn execute(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    if let Operation::Verify { directory } = args.command {
        let manifest = verify_directory(&directory)?;
        println!(
            "Verified {} {} (unsigned; checksums do not authenticate publishers)",
            manifest.version, manifest.target
        );
        return Ok(());
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let version = Command::new(rustc).arg("-vV").output()?;
    if !version.status.success() {
        return Err("rustc version query failed".into());
    }
    let version = String::from_utf8(version.stdout)?;
    let target = version
        .lines()
        .find_map(|line| line.strip_prefix("host: "))
        .ok_or("missing Rust host target")?;
    if ![
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
    ]
    .contains(&target)
    {
        return Err("unsupported native distribution target".into());
    }
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let build_target = root.join("target/native-build");
    checked(
        Command::new(cargo)
            .current_dir(&root)
            .args([
                "build",
                "--release",
                "--locked",
                "--target",
                target,
                "-p",
                "llmup-cli",
                "--bin",
                "llmup-native",
                "-p",
                "llmup-gui",
                "--bin",
                "llmup-gui",
            ])
            .arg("--target-dir")
            .arg(&build_target),
    )?;
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let release = build_target.join(target).join("release");
    let cli = release.join(format!("llmup-native{extension}"));
    let gui = release.join(format!("llmup-gui{extension}"));
    let observed = Command::new(&cli).arg("--version").output()?;
    if !observed.status.success()
        || String::from_utf8(observed.stdout)?.trim()
            != format!("llmup-native {}", env!("CARGO_PKG_VERSION"))
    {
        return Err("native binary version mismatch".into());
    }
    let parent = root.join("target/native-dist");
    fs::create_dir_all(&parent)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let output = parent.join(format!(
        "local-llmup-{}-{target}-{stamp}",
        env!("CARGO_PKG_VERSION")
    ));
    let files = [
        (format!("llmup{extension}"), cli),
        (format!("llmup-gui{extension}"), gui),
        ("LICENSE".into(), root.join("LICENSE")),
        (
            "marked.LICENSE.md".into(),
            root.join("vendor/gui/marked.LICENSE.md"),
        ),
        (
            "dompurify.LICENSE".into(),
            root.join("vendor/gui/dompurify.LICENSE"),
        ),
        ("THIRD-PARTY.md".into(), root.join("vendor/gui/README.md")),
    ];
    package_directory(
        &output,
        env!("CARGO_PKG_VERSION"),
        target,
        &files
            .iter()
            .map(|(name, path)| (name.as_str(), path.as_path()))
            .collect::<Vec<_>>(),
    )?;
    let archive = archive_path(&output)?;
    checked(
        Command::new("tar")
            .args(["-czf"])
            .arg(&archive)
            .arg("-C")
            .arg(&parent)
            .arg(output.file_name().ok_or("missing package name")?),
    )?;
    let (_, sha256) = checksum(&archive)?;
    fs::write(
        archive.with_extension("gz.sha256"),
        format!(
            "{sha256}  {}\n",
            archive
                .file_name()
                .ok_or("missing archive name")?
                .to_string_lossy()
        ),
    )?;
    println!("Unsigned native archive: {}", archive.display());
    println!("SHA-256: {sha256}");
    Ok(())
}
fn main() -> ExitCode {
    match execute(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("native-dist: {error}");
            ExitCode::FAILURE
        }
    }
}
