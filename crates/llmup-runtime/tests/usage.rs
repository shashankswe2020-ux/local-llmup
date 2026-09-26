use llmup_runtime::usage::{InferenceUsage, Provider, begin, parse, record, scope};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[test]
fn openai_cache_tokens_normalize_without_inventing_counts() {
    assert_eq!(
        parse(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60}}}),
            Provider::OpenAi
        ),
        InferenceUsage {
            input_tokens: Some(100),
            output_tokens: Some(20),
            cache_hit_tokens: Some(60),
            cache_miss_tokens: Some(40)
        }
    );
    assert_eq!(
        parse(
            &json!({"usage":{"prompt_tokens":-1,"completion_tokens":1.5}}),
            Provider::OpenAi
        ),
        InferenceUsage::default()
    );
}

#[tokio::test]
async fn each_request_starts_from_unknown_usage() {
    let usage = Arc::new(Mutex::new(InferenceUsage::default()));
    scope(usage.clone(), async {
        record(
            &json!({"prompt_eval_count":100,"eval_count":20}),
            Provider::Ollama,
        );
        begin();
        record(&json!({"usage":{"output_tokens":12}}), Provider::Claude);
    })
    .await;
    assert_eq!(
        *usage.lock().unwrap(),
        InferenceUsage {
            output_tokens: Some(12),
            ..InferenceUsage::default()
        }
    );
    let other = Arc::new(Mutex::new(InferenceUsage::default()));
    scope(other.clone(), async {}).await;
    assert_eq!(*other.lock().unwrap(), InferenceUsage::default());
}
