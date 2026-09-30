use clap::Parser;
use rigspark_runtime::{
    catalog_quality::evaluate, catalog_update::MAX_ARTIFACT_BYTES, secure_fs::Directory,
};
use std::{
    error::Error,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Evaluate independent 90% catalog quality gates against reviewed evidence")]
struct Args {
    #[arg(long, default_value = "crates/rigspark-core/data/models.json")]
    catalog_path: PathBuf,
    #[arg(long, default_value = "docs/references/catalog-quality-evidence.json")]
    evidence: PathBuf,
    #[arg(long)]
    now: Option<String>,
}

fn read(path: &Path) -> Result<String, Box<dyn Error>> {
    let absolute = std::path::absolute(path)?;
    let directory = Directory::open(absolute.parent().ok_or("parent required")?)?;
    let bytes = directory.read(
        Path::new(absolute.file_name().ok_or("filename required")?),
        MAX_ARTIFACT_BYTES as u64,
        false,
    )?;
    Ok(String::from_utf8(bytes)?)
}

fn run(args: Args) -> Result<bool, Box<dyn Error>> {
    let now = args
        .now
        .map(Ok)
        .unwrap_or_else(rigspark_runtime::native_chat::timestamp)?;
    let report = evaluate(&read(&args.catalog_path)?, &read(&args.evidence)?, &now)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.passed {
        eprintln!("catalog-quality: blocked; both scores must be >= 90% with no hard blockers");
    }
    Ok(report.passed)
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(_) => {
            eprintln!(
                "catalog-quality: invalid or unreadable catalog/evidence; publication blocked"
            );
            ExitCode::FAILURE
        }
    }
}
