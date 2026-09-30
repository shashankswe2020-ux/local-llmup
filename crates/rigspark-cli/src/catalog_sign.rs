use clap::Parser;
use rigspark_runtime::{
    catalog_quality::{evaluate, sign_reviewed_catalog},
    catalog_update::{CatalogPayload, MAX_ARTIFACT_BYTES, decode_hex},
    secure_fs::Directory,
};
use std::{
    error::Error,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Sign a reviewed catalog for independent publication")]
struct Args {
    #[arg(long, default_value = "crates/rigspark-core/data/models.json")]
    catalog_path: PathBuf,
    #[arg(long)]
    key_file: PathBuf,
    #[arg(
        long,
        default_value = "crates/rigspark-runtime/src/catalog_public_key.hex"
    )]
    public_key_file: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    revision: u64,
    #[arg(long)]
    published_at: String,
    #[arg(long)]
    quality_evidence: PathBuf,
    #[arg(long)]
    quality_output: PathBuf,
}

fn read(path: &Path, maximum: u64, secret: bool) -> Result<String, Box<dyn Error>> {
    let absolute = std::path::absolute(path)?;
    let directory = Directory::open(absolute.parent().ok_or("parent required")?)?;
    let bytes = directory.read(
        Path::new(absolute.file_name().ok_or("filename required")?),
        maximum,
        secret,
    )?;
    Ok(String::from_utf8(bytes)?)
}

fn run(args: Args) -> Result<(), Box<dyn Error>> {
    let catalog = read(&args.catalog_path, MAX_ARTIFACT_BYTES as u64, false)?;
    let evidence = read(&args.quality_evidence, MAX_ARTIFACT_BYTES as u64, false)?;
    let report = evaluate(&catalog, &evidence, &args.published_at)?;
    eprintln!("{}", serde_json::to_string(&report)?);
    if !report.passed {
        return Err("catalog quality policy failed".into());
    }
    let output = std::path::absolute(&args.output)?;
    let quality_output = std::path::absolute(&args.quality_output)?;
    for path in [&output, &quality_output] {
        if std::fs::symlink_metadata(path).is_ok() {
            return Err("output already exists".into());
        }
    }
    if output == quality_output {
        return Err("catalog and quality output paths must be distinct".into());
    }
    let seed = decode_hex::<32>(read(&args.key_file, 128, true)?.trim())?;
    let public = decode_hex::<32>(read(&args.public_key_file, 128, false)?.trim())?;
    let (bytes, quality) = sign_reviewed_catalog(
        CatalogPayload {
            format_version: 1,
            revision: args.revision,
            published_at: args.published_at,
            catalog,
        },
        &evidence,
        &seed,
        &public,
    )?;
    let quality_directory = Directory::open(
        quality_output
            .parent()
            .ok_or("quality output parent required")?,
    )?;
    quality_directory.write(
        Path::new(
            quality_output
                .file_name()
                .ok_or("quality filename required")?,
        ),
        &quality,
        true,
        false,
    )?;
    let directory = Directory::open(output.parent().ok_or("output parent required")?)?;
    directory.write(
        Path::new(output.file_name().ok_or("output filename required")?),
        &bytes,
        true,
        false,
    )?;
    eprintln!("catalog-sign: signed revision {}", args.revision);
    Ok(())
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!(
                "catalog-sign: signing failed; check quality evidence, catalog, revision, key files, permissions, and output paths"
            );
            ExitCode::FAILURE
        }
    }
}
