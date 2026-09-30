use clap::Parser;
use rigspark_runtime::{
    catalog_update::{CatalogPayload, MAX_ARTIFACT_BYTES, decode_hex, sign_catalog},
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
    let seed = decode_hex::<32>(read(&args.key_file, 128, true)?.trim())?;
    let public = decode_hex::<32>(read(&args.public_key_file, 128, false)?.trim())?;
    let bytes = sign_catalog(
        CatalogPayload {
            format_version: 1,
            revision: args.revision,
            published_at: args.published_at,
            catalog,
        },
        &seed,
        &public,
    )?;
    let output = std::path::absolute(&args.output)?;
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
                "catalog-sign: signing failed; check catalog, revision, key files, permissions, and output path"
            );
            ExitCode::FAILURE
        }
    }
}
