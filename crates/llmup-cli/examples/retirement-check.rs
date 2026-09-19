use llmup_cli::retirement::check_file;
use serde::Serialize;
use std::{
    error::Error,
    fs,
    io::Read,
    path::{Component, Path},
    process::{Command, ExitCode},
};

#[derive(Serialize)]
struct Finding {
    path: String,
    reasons: Vec<&'static str>,
}

fn run() -> Result<bool, Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let output = Command::new("git")
        .current_dir(&root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()?;
    if !output.status.success() || output.stdout.len() > 16 * 1024 * 1024 {
        return Err("cannot obtain bounded repository inventory".into());
    }
    let mut findings = Vec::new();
    let mut paths: Vec<_> = std::str::from_utf8(&output.stdout)?
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    for path in paths {
        if Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("unsafe repository path".into());
        }
        let full = root.join(path);
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            findings.push(Finding {
                path: path.into(),
                reasons: vec!["non-regular inventory entry requires review"],
            });
            continue;
        }
        let mut bytes = Vec::new();
        fs::File::open(full)?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(format!("inventory entry exceeds inspection bound: {path}").into());
        }
        let text = String::from_utf8_lossy(&bytes);
        let reasons = check_file(path, &text);
        if !reasons.is_empty() {
            findings.push(Finding {
                path: path.into(),
                reasons,
            });
        }
    }
    eprintln!("Node retirement blockers: {}", findings.len());
    println!("{}", serde_json::to_string_pretty(&findings)?);
    Ok(findings.is_empty())
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("retirement-check: {error}");
            ExitCode::FAILURE
        }
    }
}
