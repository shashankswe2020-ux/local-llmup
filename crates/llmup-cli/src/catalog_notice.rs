use clap::Parser;
use llmup_core::{catalog_notice::render, reports::strip_control};
use llmup_runtime::secure_fs::Directory;
use std::{
    error::Error,
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Format a validated catalog maintenance report; no writes or GitHub operations")]
struct Args {
    #[arg(value_parser=["refresh-pr","freshness-issue","coverage-issue","needs-attention","missing-count"])]
    kind: String,
    #[arg(long)]
    input: PathBuf,
}

fn run(args: Args) -> Result<(), Box<dyn Error>> {
    let path = std::path::absolute(&args.input)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("report parent required"))?
        .canonicalize()?;
    let name = Path::new(
        path.file_name()
            .ok_or_else(|| io::Error::other("report filename required"))?,
    );
    let raw = Directory::open(&parent)?.read(name, 1024 * 1024, false)?;
    let text = render(&args.kind, std::str::from_utf8(&raw)?)?;
    io::stdout().lock().write_all(text.as_bytes())?;
    Ok(())
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("catalog-notice: {}", strip_control(&error.to_string()));
            ExitCode::FAILURE
        }
    }
}
