use crate::{
    catalog::{Catalog, require},
    sizing::ValidationError,
};
use regex::Regex;
use serde::Serialize;
use std::collections::BTreeSet;

pub const INVENTORY_URL: &str =
    "https://raw.githubusercontent.com/ollama/ollama/main/integration/reg_library_test.go";
pub const MAX_INVENTORY_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub upstream_count: usize,
    pub covered_count: usize,
    pub missing: Vec<String>,
}

fn regex(pattern: &str) -> Result<Regex, ValidationError> {
    Regex::new(pattern).map_err(|error| ValidationError(error.to_string()))
}

pub fn parse_inventory(source: &str) -> Result<Vec<String>, ValidationError> {
    require(
        source.len() <= MAX_INVENTORY_BYTES,
        "Ollama library inventory response is oversized",
    )?;
    let declaration = "var libraryModels = []string{";
    let start = source
        .find(declaration)
        .ok_or_else(|| ValidationError("Ollama library inventory declaration is missing".into()))?
        + declaration.len();
    let end = source[start..]
        .find("\n}")
        .ok_or_else(|| ValidationError("Ollama library inventory terminator is missing".into()))?
        + start;
    let body = regex(r"(?s)/\*.*?\*/")?.replace_all(&source[start..end], "");
    let body = regex(r"(?m)//.*$")?.replace_all(&body, "");
    let entries = regex(r#"(?m)^\s*"([a-z0-9][a-z0-9._-]*)",\s*$"#)?;
    let models: Vec<String> = entries
        .captures_iter(&body)
        .map(|capture| capture[1].into())
        .collect();
    require(
        !models.is_empty(),
        "Ollama library inventory contains no active models",
    )?;
    sorted(&models)
}

fn weight(byte: u8) -> u16 {
    match byte {
        b'_' => 0,
        b'-' => 1,
        b'.' => 2,
        _ => u16::from(byte) + 3,
    }
}

fn sorted(models: &[String]) -> Result<Vec<String>, ValidationError> {
    require(models.len() <= 10000, "inventory exceeds 10000 models")?;
    for model in models {
        require(
            !model.is_empty()
                && model.len() <= 256
                && model.as_bytes()[0].is_ascii_alphanumeric()
                && model.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                }),
            "Ollama library inventory contains an invalid model name",
        )?;
    }
    let mut models: Vec<_> = models
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    models.sort_by(|left, right| left.bytes().map(weight).cmp(right.bytes().map(weight)));
    Ok(models)
}

fn official_repository(reference: &str) -> Option<&str> {
    let reference = reference.trim();
    let path = match reference.rsplit_once(':') {
        Some((path, tag)) if !path.is_empty() && !tag.contains('/') => path,
        _ => reference,
    };
    if let Some(path) = path.strip_prefix("library/") {
        Some(path)
    } else if path.contains('/') {
        None
    } else {
        Some(path)
    }
}

fn lineage(repository: &str) -> &str {
    let length = repository
        .bytes()
        .take_while(u8::is_ascii_lowercase)
        .count();
    if length == 0 {
        repository
    } else {
        &repository[..length]
    }
}

pub fn monitored(catalog: &Catalog, upstream: &[String]) -> Result<Vec<String>, ValidationError> {
    let vendors: BTreeSet<_> = catalog
        .models
        .iter()
        .filter_map(|model| model.source.ollama.as_deref())
        .filter_map(official_repository)
        .map(lineage)
        .collect();
    Ok(sorted(upstream)?
        .into_iter()
        .filter(|name| vendors.contains(lineage(name)))
        .collect())
}

pub fn evaluate(catalog: &Catalog, upstream: &[String]) -> Result<Coverage, ValidationError> {
    let upstream = sorted(upstream)?;
    let covered: BTreeSet<_> = catalog
        .models
        .iter()
        .filter_map(|model| model.source.ollama.as_deref())
        .filter_map(official_repository)
        .collect();
    let missing: Vec<_> = upstream
        .iter()
        .filter(|name| !covered.contains(name.as_str()))
        .cloned()
        .collect();
    Ok(Coverage {
        upstream_count: upstream.len(),
        covered_count: upstream.len() - missing.len(),
        missing,
    })
}
