use llmup_core::sizing::{SizingRequest, evaluate, kv_cache_bytes, parse_param_count, quant_bits};
use serde_json::{Value, json};

fn fixture() -> Value {
    json!({
        "model": {"id": "test:4b", "params": "4B", "architecture": "dense",
            "contextLength": 131072, "kvBytesPerToken": 16384,
            "quantizations": [{"name": "Q4_K_M", "diskBytes": 3000000000_u64,
                "minRamBytes": 0, "minVramBytes": 0}]},
        "hardware": {"arch": "x64", "platform": "linux", "totalRamBytes": 34359738368_u64,
            "freeRamBytes": 25769803776_u64, "freeDiskBytes": 100000000000_u64,
            "gpu": [{"vendor": "nvidia", "vramBytes": 8589934592_u64}]},
        "context": 65536
    })
}

fn result(value: Value) -> Value {
    let request: SizingRequest = serde_json::from_value(value).unwrap();
    serde_json::to_value(evaluate(&request).unwrap()).unwrap()
}

#[test]
fn fits_at_64k_and_accounts_for_kv_without_double_counting() {
    let response = result(fixture());
    assert_eq!(response["fit"]["fits"], true);
    assert_eq!(response["weights"][0].as_f64(), Some(3000000000.0));
    assert_eq!(response["required"][0].as_f64(), Some(3450000000.0));
    assert_eq!(response["atContext"][0].as_f64(), Some(4223741824.0));
    assert_eq!(response["memoryKind"], "vram");
}

#[test]
fn unknown_geometry_preserves_weights_fit_and_null_context_metrics() {
    let mut request = fixture();
    request["model"]
        .as_object_mut()
        .unwrap()
        .remove("kvBytesPerToken");
    let response = result(request);
    assert_eq!(response["fit"]["fits"], true);
    assert_eq!(response["atContext"][0], Value::Null);
    assert_eq!(response["maxContext"][0], Value::Null);
}

#[test]
fn rejects_model_cap_before_memory_fit() {
    let mut request = fixture();
    request["context"] = json!(131073);
    assert_eq!(result(request)["fit"]["reason"], "context-bound");
}

#[test]
fn memory_pressure_wins_over_disk_pressure() {
    let mut request = fixture();
    request["hardware"]["gpu"][0]["vramBytes"] = json!(1);
    request["hardware"]["freeDiskBytes"] = json!(0);
    assert_eq!(result(request.clone())["fit"]["reason"], "vram-bound");
    request["hardware"]["gpu"][0]["vramBytes"] = json!(8589934592_u64);
    assert_eq!(result(request)["fit"]["reason"], "disk-bound");
}

#[test]
fn quant_ties_prefer_known_higher_precision_and_moe_keeps_all_experts() {
    let mut request = fixture();
    let mut second = request["model"]["quantizations"][0].clone();
    second["name"] = json!("Q5_K_M");
    request["model"]["quantizations"]
        .as_array_mut()
        .unwrap()
        .push(second);
    assert_eq!(result(request.clone())["fit"]["quant"]["name"], "Q5_K_M");
    request["model"]["architecture"] = json!("moe");
    request["model"]["params"] = json!("30B");
    assert_eq!(result(request)["weights"][0].as_f64(), Some(17625000000.0));
}

#[test]
fn unified_and_cpu_memory_use_the_correct_reserve_pool() {
    let mut request = fixture();
    request["hardware"]["arch"] = json!("arm64");
    request["hardware"]["platform"] = json!("darwin");
    assert_eq!(
        result(request.clone())["usableBytes"].as_f64(),
        Some(32212254720.0)
    );
    request["hardware"]["platform"] = json!("linux");
    request["hardware"]["gpu"] = json!([]);
    assert_eq!(result(request)["usableBytes"].as_f64(), Some(23622320128.0));
}

#[test]
fn max_context_is_an_exact_inverse_and_small_context_keeps_legacy_floor() {
    let mut request = fixture();
    request["context"] = json!(1);
    let response = result(request.clone());
    assert_eq!(response["atContext"][0], response["required"][0]);
    let max = response["maxContext"][0].as_f64().unwrap() as u64;
    request["model"]["contextLength"] = json!(10000000);
    request["context"] = json!(max);
    assert_eq!(result(request.clone())["fit"]["fits"], true);
    request["context"] = json!(max + 1);
    assert_eq!(result(request)["fit"]["fits"], false);
}

#[test]
fn validates_numeric_and_enum_boundaries() {
    for field in ["totalRamBytes", "freeRamBytes", "freeDiskBytes"] {
        let mut value = fixture();
        value["hardware"][field] = json!(-1);
        let parsed: SizingRequest = serde_json::from_value(value).unwrap();
        assert!(evaluate(&parsed).is_err());
    }
    for context in [0, 10000001] {
        let mut value = fixture();
        value["context"] = json!(context);
        let parsed: SizingRequest = serde_json::from_value(value).unwrap();
        assert!(evaluate(&parsed).is_err());
    }
    let mut value = fixture();
    value["model"]["architecture"] = json!("invented");
    assert!(serde_json::from_value::<SizingRequest>(value).is_err());
    assert!(kv_cache_bytes(9007199254740991, 2).is_err());
    assert_eq!(kv_cache_bytes(16384, 0).unwrap(), 0);
    for label in ["", "-4B", "4b", "NaNB", "0B", "1e3B", ".5B"] {
        assert!(parse_param_count(label).is_err(), "{label}");
    }
    assert_eq!(parse_param_count("360M").unwrap(), 360000000.0);
    assert_eq!(quant_bits("IQ4_XS"), Some(4.3));
    assert_eq!(quant_bits("custom"), None);
}

#[test]
fn rejects_fractional_unsafe_and_missing_required_fields() {
    for value in [json!(0.5), json!(9007199254740992_u64)] {
        let mut input = fixture();
        input["hardware"]["freeDiskBytes"] = value;
        assert!(evaluate(&serde_json::from_value(input).unwrap()).is_err());
    }
    let mut input = fixture();
    input["model"]["kvBytesPerToken"] = json!(0);
    assert!(evaluate(&serde_json::from_value(input.clone()).unwrap()).is_err());
    input["model"].as_object_mut().unwrap().remove("params");
    assert!(serde_json::from_value::<SizingRequest>(input).is_err());
    assert!(kv_cache_bytes(0, 1).is_err());
    assert!(kv_cache_bytes(u64::MAX, 2).is_err());
    for label in [
        "1.B",
        "1.2.3B",
        "1 B",
        "\u{00e9}B",
        "999999999999999999999T",
    ] {
        assert!(parse_param_count(label).is_err());
    }
}

#[test]
fn refuses_unknown_moe_quant_and_clamps_unreachable_context_to_zero() {
    let mut input = fixture();
    input["model"]["architecture"] = json!("moe");
    input["model"]["quantizations"][0]["name"] = json!("custom");
    assert!(evaluate(&serde_json::from_value(input.clone()).unwrap()).is_err());
    input["model"]["architecture"] = json!("dense");
    input["hardware"]["gpu"][0]["vramBytes"] = json!(1);
    assert_eq!(result(input)["maxContext"][0].as_f64(), Some(0.0));
}

#[test]
fn validates_quantization_and_input_size_constraints() {
    for (field, value) in [
        ("diskBytes", json!(0)),
        ("minRamBytes", json!(-1)),
        ("minVramBytes", json!(-1)),
        ("name", json!("")),
        ("sha256", json!("bad")),
    ] {
        let mut input = fixture();
        input["model"]["quantizations"][0][field] = value;
        assert!(evaluate(&serde_json::from_value(input).unwrap()).is_err());
    }
    let mut input = fixture();
    input["model"]["quantizations"] =
        Value::Array(vec![input["model"]["quantizations"][0].clone(); 1025]);
    assert!(evaluate(&serde_json::from_value(input).unwrap()).is_err());
    let mut input = fixture();
    input["model"]["id"] = json!("");
    assert!(evaluate(&serde_json::from_value(input).unwrap()).is_err());
    assert_eq!(parse_param_count("1T").unwrap(), 1e12);
    assert_eq!(parse_param_count("0.5B").unwrap(), 5e8);
    for (name, bits) in [
        ("IQ1", 1.9),
        ("IQ2", 2.4),
        ("IQ3", 3.4),
        ("Q2", 2.8),
        ("Q3", 3.5),
        ("Q6", 6.6),
        ("Q8", 8.5),
        ("F16", 16.5),
        ("BF16", 16.5),
        ("FP16", 16.5),
        ("F32", 32.5),
        ("FP32", 32.5),
    ] {
        assert_eq!(quant_bits(name), Some(bits));
    }
}
