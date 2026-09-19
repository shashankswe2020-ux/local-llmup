use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Default, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_hit_tokens: Option<u64>,
    pub cache_miss_tokens: Option<u64>,
}
#[derive(Clone, Copy)]
pub enum Provider {
    OpenAi,
    Claude,
    Ollama,
}
fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|count| *count <= 9007199254740991)
}
pub fn parse(value: &Value, provider: Provider) -> InferenceUsage {
    let mut result = InferenceUsage::default();
    if matches!(provider, Provider::Ollama) {
        result.input_tokens = count(&value["prompt_eval_count"]);
        result.output_tokens = count(&value["eval_count"]);
        return result;
    }
    let usage = value
        .get("usage")
        .filter(|usage| !usage.is_null())
        .unwrap_or(&value["message"]["usage"]);
    if matches!(provider, Provider::Claude) {
        let input = count(&usage["input_tokens"]);
        let hits = count(&usage["cache_read_input_tokens"]);
        let writes = count(&usage["cache_creation_input_tokens"]);
        result.output_tokens = count(&usage["output_tokens"]);
        if let (Some(input), Some(hits), Some(writes)) = (input, hits, writes) {
            if input + hits + writes <= 9007199254740991 {
                result.input_tokens = Some(input + hits + writes);
                result.cache_hit_tokens = Some(hits);
                result.cache_miss_tokens = Some(input + writes);
            }
        } else if usage.get("cache_read_input_tokens").is_none()
            && usage.get("cache_creation_input_tokens").is_none()
        {
            result.input_tokens = input;
        }
    } else {
        result.input_tokens = count(&usage["prompt_tokens"]);
        result.output_tokens = count(&usage["completion_tokens"]);
        if let (Some(input), Some(hits)) = (
            result.input_tokens,
            count(&usage["prompt_tokens_details"]["cached_tokens"]),
        ) && hits <= input
        {
            result.cache_hit_tokens = Some(hits);
            result.cache_miss_tokens = Some(input - hits);
        }
    }
    result
}
tokio::task_local! { static CURRENT: Arc<Mutex<InferenceUsage>>; }
pub async fn scope<ResultValue>(
    usage: Arc<Mutex<InferenceUsage>>,
    operation: impl std::future::Future<Output = ResultValue>,
) -> ResultValue {
    CURRENT.scope(usage, operation).await
}
pub fn begin() {
    let _ = CURRENT.try_with(|usage| {
        if let Ok(mut usage) = usage.lock() {
            *usage = InferenceUsage::default();
        }
    });
}
pub fn record(value: &Value, provider: Provider) {
    let parsed = parse(value, provider);
    let _ = CURRENT.try_with(|usage| {
        if let Ok(mut usage) = usage.lock() {
            if parsed.input_tokens.is_some() {
                usage.input_tokens = parsed.input_tokens;
            }
            if parsed.output_tokens.is_some() {
                usage.output_tokens = parsed.output_tokens;
            }
            if parsed.cache_hit_tokens.is_some() {
                usage.cache_hit_tokens = parsed.cache_hit_tokens;
            }
            if parsed.cache_miss_tokens.is_some() {
                usage.cache_miss_tokens = parsed.cache_miss_tokens;
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn provider_counters_merge_without_double_counting() {
        let usage = Arc::new(Mutex::new(InferenceUsage::default()));
        scope(usage.clone(), async {
            record(&json!({"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":60,"cache_creation_input_tokens":30,"output_tokens":0}}}), Provider::Claude);
            record(&json!({"usage":{"output_tokens":20}}), Provider::Claude);
        }).await;
        assert_eq!(
            *usage.lock().unwrap(),
            InferenceUsage {
                input_tokens: Some(100),
                output_tokens: Some(20),
                cache_hit_tokens: Some(60),
                cache_miss_tokens: Some(40)
            }
        );
        assert_eq!(
            parse(
                &json!({"prompt_eval_count":100,"eval_count":20}),
                Provider::Ollama
            )
            .cache_hit_tokens,
            None
        );
        assert_eq!(
            parse(
                &json!({"usage":{"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":20}}}),
                Provider::OpenAi
            )
            .cache_hit_tokens,
            None
        );
    }
}
