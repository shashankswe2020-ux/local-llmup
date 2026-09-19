use futures_util::TryStreamExt;
use llmup_core::coverage::{INVENTORY_URL, MAX_INVENTORY_BYTES, parse_inventory};
use std::{io, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::{io::StreamReader, sync::CancellationToken};

pub async fn read_inventory_response(
    status: u16,
    declared_bytes: Option<u64>,
    body: impl AsyncRead + Unpin,
    cancel: &CancellationToken,
) -> io::Result<Vec<String>> {
    let operation = async {
        if !(200..300).contains(&status) {
            return Err(io::Error::other(format!(
                "Ollama library inventory returned status {status}"
            )));
        }
        if declared_bytes.is_some_and(|bytes| bytes > MAX_INVENTORY_BYTES as u64) {
            return Err(io::Error::other(
                "Ollama library inventory response is oversized",
            ));
        }
        let mut bytes = Vec::new();
        body.take(MAX_INVENTORY_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_INVENTORY_BYTES {
            return Err(io::Error::other(
                "Ollama library inventory response is oversized",
            ));
        }
        let source =
            std::str::from_utf8(&bytes).map_err(|_| io::Error::other("inventory is not UTF-8"))?;
        parse_inventory(source).map_err(io::Error::other)
    };
    tokio::select! {
        biased;
        _=cancel.cancelled()=>Err(io::Error::new(io::ErrorKind::Interrupted,"coverage cancelled")),
        result=tokio::time::timeout(Duration::from_secs(15),operation)=>result.map_err(|_|io::Error::new(io::ErrorKind::TimedOut,"coverage timed out"))?,
    }
}

pub async fn fetch_inventory(cancel: &CancellationToken) -> io::Result<Vec<String>> {
    let operation = async {
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| io::Error::other("coverage client initialization failed"))?;
        let response = client
            .get(INVENTORY_URL)
            .send()
            .await
            .map_err(|_| io::Error::other("coverage request failed"))?;
        let status = response.status().as_u16();
        let declared = response.content_length();
        let body = StreamReader::new(response.bytes_stream().map_err(io::Error::other));
        read_inventory_response(status, declared, body, cancel).await
    };
    tokio::select! {
        biased;
        _=cancel.cancelled()=>Err(io::Error::new(io::ErrorKind::Interrupted,"coverage cancelled")),
        result=tokio::time::timeout(Duration::from_secs(15),operation)=>result.map_err(|_|io::Error::new(io::ErrorKind::TimedOut,"coverage timed out"))?,
    }
}
