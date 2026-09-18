use llmup_runtime::openai::{chat_result, embedding_result};
use serde_json::json;
#[test]
fn chat_requires_content_and_embeddings_require_unique_ordered_indices() {
    assert_eq!(
        chat_result(json!({"choices":[{"message":{"content":"hello"}}]}))
            .unwrap()
            .content,
        "hello"
    );
    assert!(chat_result(json!({"choices":[]})).is_err());
    let result = embedding_result(
        json!({"data":[{"index":1,"embedding":[0.3,0.4]},{"index":0,"embedding":[0.1,0.2]}]}),
        2,
    )
    .unwrap();
    assert_eq!(result.dimension, 2);
    assert_eq!(result.vectors[0], vec![0.1, 0.2]);
    for value in [
        json!({"data":[{"index":0,"embedding":[1.0]},{"index":0,"embedding":[2.0]}]}),
        json!({"data":[{"index":0,"embedding":[]},{"index":1,"embedding":[]}]}),
        json!({"data":[{"index":0,"embedding":[1.0]},{"index":1,"embedding":[1.0,2.0]}]}),
    ] {
        assert!(embedding_result(value, 2).is_err());
    }
}
