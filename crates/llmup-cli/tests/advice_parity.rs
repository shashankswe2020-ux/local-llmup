use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn compare(actual: &Value, expected: &Value, path: &str) -> Result<(), String> {
    match (actual, expected) {
        (Value::Number(actual), Value::Number(expected)) => {
            let actual = actual.as_f64().unwrap();
            let expected = expected.as_f64().unwrap();
            if (actual - expected).abs() <= 1e-12 * expected.abs().max(1.0) {
                return Ok(());
            }
        }
        (Value::Array(actual), Value::Array(expected)) => {
            if actual.len() != expected.len() {
                return Err(format!("{path}: array length mismatch"));
            }
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                compare(actual, expected, &format!("{path}[{index}]"))?;
            }
            return Ok(());
        }
        (Value::Object(actual), Value::Object(expected)) => {
            if actual.len() != expected.len()
                || actual.keys().any(|key| !expected.contains_key(key))
            {
                return Err(format!("{path}: object keys mismatch"));
            }
            for (key, expected) in expected {
                compare(&actual[key], expected, &format!("{path}.{key}"))?;
            }
            return Ok(());
        }
        _ if actual == expected => return Ok(()),
        _ => {}
    }
    Err(format!("{path}: actual {actual} != expected {expected}"))
}

fn run(input: &Value) -> Vec<Value> {
    let mut stdin = tempfile::tempfile().unwrap();
    serde_json::to_writer(&mut stdin, input).unwrap();
    stdin.flush().unwrap();
    stdin.seek(SeekFrom::Start(0)).unwrap();
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_llmup-native"))
        .arg("--parity")
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout.try_clone().unwrap()))
        .stderr(Stdio::from(stderr.try_clone().unwrap()))
        .spawn()
        .unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() > Duration::from_secs(120) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("advice parity exceeded the original 120 second timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(stdout.metadata().unwrap().len() <= 64 * 1024 * 1024);
    assert!(stderr.metadata().unwrap().len() <= 64 * 1024 * 1024);
    stderr.seek(SeekFrom::Start(0)).unwrap();
    let mut error = String::new();
    stderr.read_to_string(&mut error).unwrap();
    assert_eq!(status.code(), Some(0), "{error}");
    stdout.seek(SeekFrom::Start(0)).unwrap();
    serde_json::from_reader(stdout).unwrap()
}

#[test]
fn complete_typescript_advice_matrix_matches_native_cli() {
    let file = std::fs::File::open(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/advice-parity-oracle.json"
    ))
    .expect("freeze the independent TypeScript oracle before retiring the script");
    let oracle: Value = serde_json::from_reader(file).unwrap();
    let cases = oracle["cases"].as_array().unwrap();
    let values = oracle["values"].as_array().unwrap();
    assert_eq!(cases.len(), 78);
    assert_matrix(&oracle);
    let mut verdict_count = 0;
    let mut query_count = 0;
    let mut errors = std::collections::BTreeMap::<String, usize>::new();
    for batch in cases.chunks(13) {
        let input: Vec<_> = batch.iter().map(|case| &case["input"]).collect();
        let outputs = run(&json!(input));
        assert_eq!(outputs.len(), batch.len());
        for (case, actual) in batch.iter().zip(outputs) {
            let label = case["label"].as_str().unwrap();
            for field in ["recommendation", "text", "score", "catalogText", "verdicts"] {
                let expected = &values[case["expected"][field].as_u64().unwrap() as usize];
                compare(&actual[field], expected, &format!("{label}/{field}"))
                    .unwrap_or_else(|error| panic!("{error}"));
            }
            verdict_count += actual["verdicts"].as_array().unwrap().len();
            let queries = case["input"]["queries"].as_array().unwrap();
            let checks = case["expected"]["checks"].as_array().unwrap();
            assert_eq!(checks.len(), queries.len());
            assert_eq!(actual["checks"].as_array().unwrap().len(), checks.len());
            for (index, check) in checks.iter().enumerate() {
                let path = format!("{label}/{}", queries[index]);
                let actual = &actual["checks"][index];
                for (field, reference) in check.as_object().unwrap() {
                    let expected = &values[reference.as_u64().unwrap() as usize];
                    let actual = if field == "error" {
                        let code = expected["code"].as_str().unwrap();
                        *errors.entry(code.to_owned()).or_default() += 1;
                        json!({"code":actual[field]["code"],"candidates":actual[field]["candidates"]})
                    } else {
                        actual[field].clone()
                    };
                    compare(&actual, expected, &format!("{path}/{field}"))
                        .unwrap_or_else(|error| panic!("{error}"));
                }
                query_count += 1;
            }
        }
    }
    assert_eq!(verdict_count, 5148);
    assert_eq!(query_count, 9126);
    assert_eq!(errors["MODEL_RESOLUTION_ERROR"], 918);
    assert_eq!(errors["VALIDATION_ERROR"], 162);
    assert_eq!(json!(errors), oracle["provenance"]["errorCounts"]);
    let probe = &oracle["sanitization"];
    assert_ne!(probe["raw"], probe["json"]);
    compare(
        &llmup_core::reports::sanitized(&probe["raw"]),
        &probe["json"],
        "sanitized JSON",
    )
    .unwrap();
    assert_eq!(
        llmup_core::reports::recommendation_text(&probe["raw"], &Default::default()),
        probe["text"].as_str().unwrap(),
        "sanitized plain text"
    );
    println!(
        "Rust advice parity passed: 78 hardware/mode reports, {verdict_count} verdicts, {query_count} resolver/can-run cases; errors {errors:?}; plain text exact, JSON numbers within 1e-12 relative tolerance."
    );
}

fn assert_matrix(oracle: &Value) {
    let catalog_bytes = include_bytes!("../../llmup-core/data/models.json");
    for (path, bytes) in [
        ("data/models.json", catalog_bytes.as_slice()),
        (
            "data/perf.json",
            include_bytes!("../../llmup-core/data/perf.json").as_slice(),
        ),
    ] {
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            oracle["provenance"]["sourceSha256"][path].as_str().unwrap(),
            "{path}: the frozen TS oracle requires explicit recapture when its data changes"
        );
    }
    let hashes = oracle["provenance"]["sourceSha256"].as_object().unwrap();
    for path in [
        "scripts/rust-advice-parity.ts",
        "src/commands/recommend.ts",
        "src/commands/can-run.ts",
        "src/commands/catalog.ts",
        "src/advisor/verdict.ts",
        "src/advisor/score.ts",
        "src/resolver.ts",
        "src/sanitize.ts",
        "src/output.ts",
    ] {
        let hash = hashes[path].as_str().unwrap();
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
    let catalog: Value = serde_json::from_slice(catalog_bytes).unwrap();
    let models = catalog["models"].as_array().unwrap();
    assert_eq!(models.len(), 66);
    let mut queries: Vec<Value> = models.iter().map(|model| model["id"].clone()).collect();
    queries.extend(models.iter().map(|model| {
        json!(format!(
            "{}-{}",
            model["id"].as_str().unwrap(),
            model["quantizations"][0]["name"].as_str().unwrap()
        ))
    }));
    let mut families = Vec::new();
    for model in models {
        if !families.contains(&model["family"]) {
            families.push(model["family"].clone());
        }
    }
    queries.extend(families);
    queries.extend(
        [
            "missing",
            "../escape",
            "",
            "bad;input",
            "qwen",
            " LLAMA3.1:8B ",
        ]
        .map(|query| json!(query)),
    );
    assert_eq!(queries.len(), 169);
    let modes = [
        json!({}),
        json!({"context":1}),
        json!({"context":65536}),
        json!({"maxContext":true}),
        json!({"contextPercent":25}),
        json!({"contextPercent":50}),
        json!({"contextPercent":75}),
        json!({"contextPercent":100}),
        json!({"task":"code"}),
        json!({"backend":"ollama"}),
        json!({"backend":"llamacpp"}),
        json!({"backend":"mlx"}),
        json!({"backend":"lmstudio"}),
    ];
    let gib = 1024_u64.pow(3);
    let base = json!({"arch":"x64","platform":"linux","totalRamBytes":32*gib,"freeRamBytes":24*gib,"freeDiskBytes":500*gib,"gpu":[{"vendor":"nvidia","vramBytes":8*gib}]});
    let overrides = [
        json!({}),
        json!({"gpu":[{"vendor":"nvidia","vramBytes":24*gib}]}),
        json!({"arch":"arm64","platform":"darwin","gpu":[{"vendor":"apple","vramBytes":0}]}),
        json!({"gpu":[]}),
        json!({"platform":"win32","freeDiskBytes":0}),
        json!({"gpu":[{"vendor":"amd","vramBytes":16*gib}]}),
    ];
    for (index, case) in oracle["cases"].as_array().unwrap().iter().enumerate() {
        let mut hardware = base.clone();
        hardware
            .as_object_mut()
            .unwrap()
            .extend(overrides[index / modes.len()].as_object().unwrap().clone());
        let options = &modes[index % modes.len()];
        let selected_queries = if options.get("contextPercent").is_some() {
            json!([])
        } else {
            json!(queries)
        };
        assert_eq!(
            case["input"],
            json!({"hardware":hardware,"options":options,"queries":selected_queries}),
            "matrix input {index}"
        );
    }
}

#[test]
fn comparator_preserves_tolerance_and_detects_contract_drift() {
    for expected in [0.0_f64, 0.5, 2.0, -2.0, 1e12] {
        let tolerance = 1e-12 * expected.abs().max(1.0);
        for direction in [-1.0, 1.0] {
            assert!(
                compare(
                    &json!(expected + direction * tolerance * 0.5),
                    &json!(expected),
                    "number"
                )
                .is_ok()
            );
            assert!(
                compare(
                    &json!(expected + direction * tolerance * 2.0),
                    &json!(expected),
                    "number"
                )
                .is_err()
            );
        }
    }
    assert!(compare(&json!(1e-12), &json!(0), "boundary").is_ok());
    assert!(compare(&json!(1), &json!(1.0), "integer").is_ok());
    for (actual, expected) in [
        (json!({"extra":null}), json!({})),
        (json!({}), json!({"missing":null})),
        (json!({"wrong":1}), json!({"key":1})),
        (json!([1]), json!([1, 2])),
        (json!([2, 1]), json!([1, 2])),
        (json!(null), json!(0)),
        (json!("1"), json!(1)),
        (json!("plain\n"), json!("plain")),
        (json!("\u{1b}[31mplain"), json!("plain")),
    ] {
        assert!(compare(&actual, &expected, "probe").is_err());
    }
}
