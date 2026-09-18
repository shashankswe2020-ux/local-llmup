use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream::BoxStream};
use std::io;

const LIMIT: usize = 1048576;

pub(crate) async fn json_body<Source, Failure>(source: Source) -> io::Result<Vec<u8>>
where
    Source: Stream<Item = Result<Bytes, Failure>>,
{
    futures_util::pin_mut!(source);
    let mut bytes = Vec::new();
    while let Some(chunk) = source.next().await {
        let chunk = chunk.map_err(|_| io::Error::other("MCP body failed"))?;
        if chunk.len() > LIMIT - bytes.len() {
            return Err(io::Error::other("MCP response limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) fn events<Source, Failure>(
    source: Source,
) -> BoxStream<'static, Result<sse_stream::Sse, sse_stream::Error>>
where
    Source: Stream<Item = Result<Bytes, Failure>> + Send + 'static,
    Failure: Send + 'static,
{
    let mut event_size = 0usize;
    let mut line_size = 0usize;
    let mut total = 0usize;
    let mut previous_cr = false;
    let mut failed = false;
    let checked = source.map(move |chunk| {
        let chunk = chunk.map_err(|_| io::Error::other("MCP stream failed"))?;
        if failed || chunk.len() > 64 * LIMIT - total {
            failed = true;
            return Err(io::Error::other("MCP stream limit"));
        }
        total += chunk.len();
        for byte in &chunk {
            if previous_cr && *byte == b'\n' {
                previous_cr = false;
                continue;
            }
            previous_cr = *byte == b'\r';
            event_size += 1;
            if event_size > LIMIT {
                failed = true;
                return Err(io::Error::other("MCP event limit"));
            }
            if matches!(*byte, b'\r' | b'\n') {
                if line_size == 0 {
                    event_size = 0;
                }
                line_size = 0;
            } else {
                line_size += 1;
            }
        }
        Ok(chunk)
    });
    sse_stream::SseStream::from_bytes_stream(checked).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn json_is_capped_across_chunks() {
        let source = futures_util::stream::iter([
            Ok::<_, io::Error>(Bytes::from(vec![b' '; LIMIT])),
            Ok(Bytes::from_static(b"x")),
        ]);
        assert!(json_body(source).await.is_err());
    }
    #[tokio::test]
    async fn sse_limits_multiline_events_and_handles_split_crlf() {
        let source = futures_util::stream::iter(
            (0..1025)
                .map(|_| Ok::<_, io::Error>(Bytes::from(format!("data: {}\n", "x".repeat(1024))))),
        );
        assert!(events(source).next().await.unwrap().is_err());
        let source = futures_util::stream::iter(
            [b"data: hello\r".as_slice(), b"\n\r", b"\ndata: world\n\n"]
                .map(|chunk| Ok::<_, io::Error>(Bytes::copy_from_slice(chunk))),
        );
        let result: Vec<_> = events(source).collect().await;
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].as_ref().unwrap().data.as_deref(), Some("hello"));
        assert_eq!(result[1].as_ref().unwrap().data.as_deref(), Some("world"));
    }
}
