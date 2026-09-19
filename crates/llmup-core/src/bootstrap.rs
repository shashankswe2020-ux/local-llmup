use crate::sizing::{ValidationError, parse_param_count};

pub fn derive_benchmark_proxy(family: &str, params: &str) -> Result<f64, ValidationError> {
    let offset = match family {
        "kimi-k2" | "deepseek-r1" | "phi4" => 0.12,
        "kimi-k2-thinking" => 0.14,
        "kimi-vl" | "qwen2.5" | "gemma3n" | "gemma3" | "phi3" => 0.06,
        "kimi-dev" | "kimi-linear" | "llama3.3" | "qwen2.5-coder" | "gemma4" | "phi3.5" => 0.08,
        "llama3.1" | "gemma2" => 0.04,
        "qwen3" | "deepseek-v3" | "phi4-mini" => 0.1,
        "mixtral" | "mistral-small" | "glm4" => 0.05,
        "mistral-nemo" | "yi" | "granite3.1" => 0.03,
        "mistral" | "olmo2" | "granite3-moe" => 0.02,
        _ => 0.0,
    };
    let billions = parse_param_count(params)? / 1e9;
    let base = [
        (0.5, 0.05),
        (1.0, 0.12),
        (2.0, 0.2),
        (4.0, 0.28),
        (7.0, 0.36),
        (10.0, 0.44),
        (15.0, 0.52),
        (25.0, 0.58),
        (40.0, 0.64),
        (80.0, 0.7),
        (200.0, 0.78),
    ]
    .into_iter()
    .find_map(|(ceiling, score)| (billions < ceiling).then_some(score))
    .unwrap_or(0.85_f64);
    Ok(((base + offset).clamp(0.05, 0.99) * 100.0).round() / 100.0)
}
