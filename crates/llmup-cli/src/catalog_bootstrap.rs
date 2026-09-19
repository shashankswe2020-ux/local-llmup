use clap::Parser;
use llmup_core::{
    bootstrap::{BOOTSTRAP_CLOCK, build_catalog},
    enrich::parse_candidates,
    reports::strip_control,
};
use llmup_runtime::secure_fs::Directory;
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Rebuild the catalog from the frozen offline snapshot and pinned metadata")]
struct Args {
    #[arg(long, default_value = "data/models.json")]
    out: PathBuf,
    #[arg(long, default_value = BOOTSTRAP_CLOCK)]
    now: String,
    #[arg(long)]
    dry_run: bool,
}

fn run(args: Args) -> Result<(), Box<dyn Error>> {
    let candidates = parse_candidates(include_str!(
        "../../llmup-core/fixtures/registry-snapshot.json"
    ))?;
    let catalog = build_catalog(&candidates, &args.now)?;
    let encoded = format!("{}\n", serde_json::to_string_pretty(&catalog)?);
    if args.dry_run {
        print!("{encoded}");
        return Ok(());
    }
    let absolute = std::path::absolute(&args.out)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| io::Error::other("output parent required"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| io::Error::other("output filename required"))?;
    let parent = parent.canonicalize()?;
    let output = parent.join(name);
    let exists = match fs::symlink_metadata(&output) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
        Ok(_) => return Err(io::Error::other("output must be a regular non-symlink file").into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let directory = Directory::open(&parent)?;
    directory.write(Path::new(name), encoded.as_bytes(), !exists, exists)?;
    eprintln!(
        "bootstrap: wrote {} models to {}",
        catalog.models.len(),
        strip_control(&output.to_string_lossy())
    );
    Ok(())
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("bootstrap: {}", strip_control(&error.to_string()));
            ExitCode::FAILURE
        }
    }
}
