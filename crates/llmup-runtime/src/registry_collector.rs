use futures_util::TryStreamExt;
use llmup_core::{
    catalog::Catalog,
    registry_collector::{
        MANIFEST_ACCEPT, MAX_MANIFEST_BYTES, ModelLayer, apply_layer, parse_layer, parse_reference,
    },
};
use serde::{Deserialize, Serialize};
use std::{io, pin::Pin, time::Duration};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::{io::StreamReader, sync::CancellationToken};
use url::Url;

pub struct ManifestResponse {
    pub status: u16,
    pub declared_bytes: Option<u64>,
    pub body: Pin<Box<dyn AsyncRead + Send>>,
}
#[async_trait::async_trait]
pub trait ManifestTransport: Send + Sync {
    async fn fetch(&self, url: &Url) -> io::Result<ManifestResponse>;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedResponse {
    status: u16,
    body: serde_json::Value,
}
pub struct RecordedTransport {
    responses: std::collections::BTreeMap<String, RecordedResponse>,
}
impl RecordedTransport {
    pub fn parse(raw: &str) -> io::Result<Self> {
        let responses: std::collections::BTreeMap<String, RecordedResponse> =
            llmup_core::catalog::parse_document(raw).map_err(io::Error::other)?;
        if responses.len() > 10000 {
            return Err(io::Error::other("too many recorded manifests"));
        }
        for (key, response) in &responses {
            let url = Url::parse(key).map_err(io::Error::other)?;
            if url.scheme() != "https"
                || url.host_str() != Some("registry.ollama.ai")
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.path().starts_with("/v2/")
                || !(100..=599).contains(&response.status)
                || serde_json::to_vec(&response.body)
                    .map_err(io::Error::other)?
                    .len()
                    > MAX_MANIFEST_BYTES
            {
                return Err(io::Error::other("invalid recorded registry response"));
            }
        }
        Ok(Self { responses })
    }
}
#[async_trait::async_trait]
impl ManifestTransport for RecordedTransport {
    async fn fetch(&self, url: &Url) -> io::Result<ManifestResponse> {
        let (status, bytes) = match self.responses.get(url.as_str()) {
            Some(response) => (
                response.status,
                serde_json::to_vec(&response.body).map_err(io::Error::other)?,
            ),
            None => (404, b"{}".to_vec()),
        };
        Ok(ManifestResponse {
            status,
            declared_bytes: Some(bytes.len() as u64),
            body: Box::pin(std::io::Cursor::new(bytes)),
        })
    }
}
pub struct NativeManifestTransport {
    client: reqwest::Client,
}
impl NativeManifestTransport {
    pub fn new() -> io::Result<Self> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| io::Error::other("registry client initialization failed"))?;
        Ok(Self { client })
    }
}
#[async_trait::async_trait]
impl ManifestTransport for NativeManifestTransport {
    async fn fetch(&self, url: &Url) -> io::Result<ManifestResponse> {
        if url.scheme() != "https"
            || url.host_str() != Some("registry.ollama.ai")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(io::Error::other("invalid registry manifest URL"));
        }
        let response = self
            .client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, MANIFEST_ACCEPT)
            .send()
            .await
            .map_err(|_| io::Error::other("registry request failed"))?;
        Ok(ManifestResponse {
            status: response.status().as_u16(),
            declared_bytes: response.content_length(),
            body: Box::pin(StreamReader::new(
                response.bytes_stream().map_err(io::Error::other),
            )),
        })
    }
}

pub fn manifest_url(reference: &str) -> io::Result<Url> {
    if reference.len() > 8192 || reference.chars().any(char::is_control) {
        return Err(io::Error::other("invalid registry reference"));
    }
    let (path, tag) = parse_reference(reference);
    let valid = |part: &str| {
        !part.is_empty()
            && part.len() <= 256
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    };
    if !valid(tag) || !path.split('/').all(valid) {
        return Err(io::Error::other("unsafe registry coordinates"));
    }
    let path = if path.contains('/') {
        path.to_string()
    } else {
        format!("library/{path}")
    };
    Url::parse(&format!(
        "https://registry.ollama.ai/v2/{path}/manifests/{tag}"
    ))
    .map_err(io::Error::other)
}

pub async fn fetch_layer(
    transport: &dyn ManifestTransport,
    reference: &str,
    cancel: &CancellationToken,
) -> io::Result<Option<ModelLayer>> {
    let operation = async {
        let url = manifest_url(reference)?;
        let response = transport.fetch(&url).await?;
        if !(200..300).contains(&response.status) {
            return Ok(None);
        }
        if response
            .declared_bytes
            .is_some_and(|bytes| bytes > MAX_MANIFEST_BYTES as u64)
        {
            return Err(io::Error::other("manifest exceeds 4 MiB"));
        }
        let mut bytes = Vec::new();
        response
            .body
            .take(MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(io::Error::other("manifest exceeds 4 MiB"));
        }
        let raw =
            std::str::from_utf8(&bytes).map_err(|_| io::Error::other("manifest is not UTF-8"))?;
        parse_layer(raw).map_err(io::Error::other)
    };
    tokio::select! {
        biased;
        _=cancel.cancelled()=>Err(io::Error::new(io::ErrorKind::Interrupted,"catalog enrichment cancelled")),
        result=tokio::time::timeout(Duration::from_secs(15),operation)=>result.map_err(|_|io::Error::new(io::ErrorKind::TimedOut,"registry request timed out"))?,
    }
}

#[derive(Serialize)]
pub struct RefreshResult {
    pub catalog: Catalog,
    pub updated: Vec<String>,
}

pub async fn refresh(
    catalog: &Catalog,
    transport: &dyn ManifestTransport,
    now: &str,
    cancel: &CancellationToken,
) -> io::Result<RefreshResult> {
    if cancel.is_cancelled() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "catalog enrichment cancelled",
        ));
    }
    let encoded = serde_json::to_string(catalog).map_err(io::Error::other)?;
    let mut output = Catalog::parse(&encoded).map_err(io::Error::other)?;
    let stamp = OffsetDateTime::parse(now, &Rfc3339)
        .map_err(io::Error::other)?
        .to_offset(time::UtcOffset::UTC)
        .format(time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .map_err(io::Error::other)?;
    let mut updated = Vec::new();
    for model in &mut output.models {
        if cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "catalog enrichment cancelled",
            ));
        }
        let Some(reference) = model.source.ollama.as_deref() else {
            continue;
        };
        let layer = match fetch_layer(transport, reference, cancel).await {
            Ok(Some(layer)) => layer,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
            _ => continue,
        };
        if let Some(changed) = apply_layer(model, &layer).map_err(io::Error::other)? {
            updated.push(model.id.clone());
            *model = changed;
        }
    }
    if cancel.is_cancelled() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "catalog enrichment cancelled",
        ));
    }
    if !updated.is_empty() {
        output.generated_at = stamp;
    }
    Catalog::parse(&serde_json::to_string(&output).map_err(io::Error::other)?)
        .map_err(io::Error::other)?;
    Ok(RefreshResult {
        catalog: output,
        updated,
    })
}
