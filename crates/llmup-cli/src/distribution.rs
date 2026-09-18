use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

const MAX_FILE: u64 = 256 * 1024 * 1024;
const TARGETS: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
];
const FILES: &[&str] = &[
    "llmup",
    "llmup.exe",
    "llmup-gui",
    "llmup-gui.exe",
    "LICENSE",
    "marked.LICENSE.md",
    "dompurify.LICENSE",
    "THIRD-PARTY.md",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub version: String,
    pub target: String,
    pub signing: String,
    pub files: Vec<Artifact>,
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub fn archive_path(directory: &Path) -> io::Result<PathBuf> {
    let mut name = directory
        .file_name()
        .ok_or_else(|| invalid("missing archive directory name"))?
        .to_os_string();
    name.push(".tar.gz");
    Ok(directory.with_file_name(name))
}
fn validate(version: &str, target: &str, names: &[&str]) -> io::Result<()> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty() || part.len() > 8 || !part.bytes().all(|byte| byte.is_ascii_digit())
        })
        || !TARGETS.contains(&target)
    {
        return Err(invalid("invalid native package version or target"));
    }
    let mut seen = BTreeSet::new();
    if names.is_empty()
        || names.len() > FILES.len()
        || names
            .iter()
            .any(|name| !FILES.contains(name) || !seen.insert(*name))
    {
        return Err(invalid("invalid or duplicate native artifact name"));
    }
    Ok(())
}
pub fn checksum(path: &Path) -> io::Result<(u64, String)> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE {
        return Err(invalid("invalid native artifact file"));
    }
    let mut file = fs::File::open(path)?.take(MAX_FILE + 1);
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        hash.update(&buffer[..count]);
    }
    if total != metadata.len() || total > MAX_FILE {
        return Err(invalid("native artifact changed while reading"));
    }
    Ok((total, format!("{:x}", hash.finalize())))
}
pub fn package_directory(
    output: &Path,
    version: &str,
    target: &str,
    files: &[(&str, &Path)],
) -> io::Result<Manifest> {
    validate(
        version,
        target,
        &files.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
    )?;
    let mut manifest = Manifest {
        schema_version: 1,
        version: version.into(),
        target: target.into(),
        signing: "unsigned".into(),
        files: Vec::new(),
    };
    for (name, source) in files {
        let (bytes, sha256) = checksum(source)?;
        manifest.files.push(Artifact {
            name: (*name).into(),
            bytes,
            sha256,
        });
    }
    fs::create_dir(output)?;
    for (name, source) in files {
        fs::copy(source, output.join(name))?;
    }
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    verify_directory(output)?;
    Ok(manifest)
}
pub fn verify_directory(directory: &Path) -> io::Result<Manifest> {
    if !fs::symlink_metadata(directory)?.is_dir() {
        return Err(invalid("native package must be a directory"));
    }
    let path = directory.join("manifest.json");
    if !fs::symlink_metadata(&path)?.is_file() {
        return Err(invalid("invalid manifest file"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(invalid("manifest exceeds limit"));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    validate(
        &manifest.version,
        &manifest.target,
        &manifest
            .files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>(),
    )?;
    if manifest.schema_version != 1 || manifest.signing != "unsigned" {
        return Err(invalid("unsupported native manifest"));
    }
    let mut expected = BTreeSet::from(["manifest.json".to_owned()]);
    for file in &manifest.files {
        let (bytes, hash) = checksum(&directory.join(&file.name))?;
        if bytes != file.bytes || hash != file.sha256 {
            return Err(invalid("native artifact checksum mismatch"));
        }
        expected.insert(file.name.clone());
    }
    for entry in fs::read_dir(directory)? {
        if !expected.remove(&entry?.file_name().to_string_lossy().into_owned()) {
            return Err(invalid("unexpected package file"));
        }
    }
    if !expected.is_empty() {
        return Err(invalid("missing package file"));
    }
    Ok(manifest)
}
