use llmup_runtime::coverage::read_inventory_response;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn accepts_bounded_official_inventory_and_rejects_http_failures() {
    let source = b"var libraryModels = []string{\n \"qwen3\",\n}\n";
    assert_eq!(
        read_inventory_response(200, None, &source[..], &CancellationToken::new())
            .await
            .unwrap(),
        vec!["qwen3"]
    );
    for status in [301, 302, 404, 503] {
        assert!(
            read_inventory_response(status, None, &source[..], &CancellationToken::new())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn enforces_declared_and_actual_limits_before_parsing() {
    let maximum = llmup_core::coverage::MAX_INVENTORY_BYTES;
    assert!(
        read_inventory_response(
            200,
            Some(maximum as u64 + 1),
            &b""[..],
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let bytes = vec![b'x'; maximum + 10];
    let mut input = std::io::Cursor::new(bytes);
    assert!(
        read_inventory_response(200, None, &mut input, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(input.position(), maximum as u64 + 1);
    assert!(
        read_inventory_response(200, None, &b"invalid"[..], &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cancellation_does_not_wait_for_an_unresponsive_body() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let (_writer, reader) = tokio::io::duplex(8);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        read_inventory_response(200, None, reader, &cancel),
    )
    .await
    .unwrap();
    assert!(result.is_err());
}
