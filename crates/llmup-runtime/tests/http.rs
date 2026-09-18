use llmup_runtime::http::{Request, Response, Transport, read_json};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[test]
fn loopback_requests_reject_redirect_targets_and_credential_injection() {
    for endpoint in [
        "https://127.0.0.1:11434",
        "http://example.com:11434",
        "http://user:pass@127.0.0.1:11434",
    ] {
        assert!(Request::new(endpoint, "/api/tags", None, None).is_err());
    }
    for path in [
        "//example.com",
        "http://example.com",
        "/../escape",
        "/api/../tags",
    ] {
        assert!(Request::new("http://127.0.0.1:11435", path, None, None).is_err());
    }
    assert!(
        Request::new(
            "http://127.0.0.1:11435",
            "/api/tags",
            None,
            Some("secret\r\ninjected".into())
        )
        .is_err()
    );
    assert_eq!(
        Request::new("http://127.0.0.1:11435", "/api/tags", None, None)
            .unwrap()
            .url
            .as_str(),
        "http://127.0.0.1:11435/api/tags"
    );
}
struct Fake {
    bytes: Vec<u8>,
    status: u16,
}
#[async_trait::async_trait]
impl Transport for Fake {
    async fn send(&self, _request: Request) -> Result<Response, llmup_runtime::http::HttpError> {
        Ok(Response {
            status: self.status,
            body: Box::pin(std::io::Cursor::new(self.bytes.clone())),
        })
    }
}
#[tokio::test]
async fn bounded_json_rejects_status_overflow_malformed_and_cancelled_reads() {
    let request = || Request::new("http://127.0.0.1:11435", "/api/tags", None, None).unwrap();
    let cancel = CancellationToken::new();
    assert_eq!(
        read_json(
            &Fake {
                bytes: b"{}".to_vec(),
                status: 200
            },
            request(),
            &cancel,
            16
        )
        .await
        .unwrap(),
        json!({})
    );
    for response in [
        Fake {
            bytes: vec![b' '; 100],
            status: 200,
        },
        Fake {
            bytes: b"not json".to_vec(),
            status: 200,
        },
        Fake {
            bytes: b"{}".to_vec(),
            status: 302,
        },
    ] {
        assert!(read_json(&response, request(), &cancel, 16).await.is_err());
    }
    cancel.cancel();
    assert!(
        read_json(
            &Fake {
                bytes: b"{}".to_vec(),
                status: 200
            },
            request(),
            &cancel,
            16
        )
        .await
        .is_err()
    );
}
