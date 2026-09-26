use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct Oracle {
    provenance: Value,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    label: String,
    input: Value,
    output: Value,
}

fn oracle() -> Oracle {
    serde_json::from_str(include_str!("fit-parity-oracle.json")).unwrap()
}

fn run(input: &str, args: &[&str]) -> (i32, String, String) {
    let mut stdin = tempfile::tempfile().unwrap();
    stdin.write_all(input.as_bytes()).unwrap();
    stdin.seek(SeekFrom::Start(0)).unwrap();
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_llmup-fit-parity"))
        .args(args)
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
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("fit parity runner exceeded 30 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(stdout.metadata().unwrap().len() <= 8 * 1024 * 1024);
    assert!(stderr.metadata().unwrap().len() <= 8 * 1024 * 1024);
    let mut output = String::new();
    let mut error = String::new();
    stdout.seek(SeekFrom::Start(0)).unwrap();
    stderr.seek(SeekFrom::Start(0)).unwrap();
    stdout.read_to_string(&mut output).unwrap();
    stderr.read_to_string(&mut error).unwrap();
    (
        status.code().expect("runner terminated by signal"),
        output,
        error,
    )
}

fn assert_js_equal(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(actual), Value::Number(expected)) => {
            assert_eq!(actual.as_f64(), expected.as_f64(), "{path}");
        }
        (Value::Array(actual), Value::Array(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{path}");
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                assert_js_equal(actual, expected, &format!("{path}[{index}]"));
            }
        }
        (Value::Object(actual), Value::Object(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{path}");
            for (key, expected) in expected {
                let actual = actual
                    .get(key)
                    .unwrap_or_else(|| panic!("{path}.{key} missing"));
                assert_js_equal(actual, expected, &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn matches_complete_frozen_typescript_matrix_in_original_batches() {
    let oracle = oracle();
    assert_eq!(oracle.cases.len(), 2849);
    assert_eq!(oracle.provenance["caseCount"], 2849);
    assert_eq!(oracle.provenance["catalogModels"], 66);
    assert_eq!(oracle.provenance["syntheticModels"], 3);
    assert_eq!(oracle.provenance["hardwareProfiles"], 7);
    assert_eq!(oracle.provenance["batchSize"], 128);
    assert_eq!(oracle.provenance["numericTolerance"], 0);
    let models: BTreeSet<_> = oracle
        .cases
        .iter()
        .map(|case| case.input["model"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(models.len(), 69);
    for batch in oracle.cases.chunks(128) {
        let inputs: Vec<_> = batch.iter().map(|case| &case.input).collect();
        let (status, stdout, stderr) = run(&serde_json::to_string(&inputs).unwrap(), &[]);
        assert_eq!(status, 0, "{stderr}");
        assert_eq!(stderr, "");
        let outputs: Vec<Value> = serde_json::from_str(&stdout).unwrap();
        assert_eq!(outputs.len(), batch.len());
        for (case, actual) in batch.iter().zip(outputs) {
            assert_js_equal(&actual, &case.output, &case.label);
        }
    }
}

#[test]
fn preserves_validation_errors_and_argument_exit_contract() {
    let oracle = oracle();
    let mut zero_context = oracle
        .cases
        .iter()
        .find(|case| case.input["model"]["id"] == "parity:ties")
        .unwrap()
        .input
        .clone();
    zero_context["context"] = json!(0);
    let zero_context = serde_json::to_string(&json!([zero_context])).unwrap();
    for input in ["", "{}", "[{}]", "null", "[", &zero_context] {
        let (status, stdout, stderr) = run(input, &[]);
        assert_eq!(status, 1, "{input}: {stderr}");
        assert_eq!(stdout, "", "{input}");
        let error: Value = serde_json::from_str(&stderr).unwrap();
        assert_eq!(error["code"], "VALIDATION_ERROR", "{input}");
        assert!(error["message"].is_string(), "{input}");
    }
    assert_eq!(run("", &["--unknown"]).0, 2);
}

#[test]
fn exact_comparator_accepts_javascript_numbers_but_detects_contract_drift() {
    assert_js_equal(&json!({"number": 1.0}), &json!({"number": 1}), "number");
    for (actual, expected) in [
        (json!([2, 1]), json!([1, 2])),
        (json!(1.0000000000000002), json!(1.0)),
        (json!({"extra": null}), json!({})),
        (json!({"missing": null}), json!({"other": null})),
        (json!(null), json!(0)),
    ] {
        assert!(std::panic::catch_unwind(|| assert_js_equal(&actual, &expected, "probe")).is_err());
    }
}
