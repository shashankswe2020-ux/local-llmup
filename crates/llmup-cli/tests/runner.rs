use llmup_cli::{MAX_INPUT_BYTES, run};
use serde_json::{Value, json};
use std::io::Cursor;

#[test]
fn rejects_empty_malformed_and_unknown_input_without_stdout() {
    for input in ["", "{}", "[{}]", "[", "null"] {
        let mut output = Vec::new();
        assert!(run(Cursor::new(input), &mut output).is_err());
        assert!(output.is_empty());
    }
}

#[test]
fn rejects_oversized_input_and_excessive_batch_count() {
    assert!(run(Cursor::new(vec![b' '; MAX_INPUT_BYTES + 1]), Vec::new()).is_err());
    let input = format!("[{}]", vec!["{}"; 4097].join(","));
    assert!(run(Cursor::new(input), Vec::new()).is_err());
}

#[test]
fn emits_one_json_result_without_diagnostic_noise() {
    let input = json!([{
        "model": {"id":"test", "params":"1B", "architecture":"dense", "contextLength":4096, "quantizations":[]},
        "hardware":{"arch":"arm64", "platform":"darwin", "totalRamBytes":8589934592_u64,
            "freeRamBytes":4294967296_u64, "freeDiskBytes":0, "gpu":[]}
    }]);
    let mut output = Vec::new();
    run(Cursor::new(input.to_string()), &mut output).unwrap();
    let response: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(response[0]["fit"]["reason"], "ram-bound");
    assert_eq!(response.as_array().unwrap().len(), 1);
    assert!(output.ends_with(b"\n"));
}

#[test]
fn reports_output_failures() {
    struct FailedWriter;
    impl std::io::Write for FailedWriter {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("closed"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert!(run(Cursor::new("[]"), FailedWriter).is_err());
}

#[test]
fn reports_input_io_failures_as_typed_errors() {
    struct FailedReader;
    impl std::io::Read for FailedReader {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("unreadable"))
        }
    }
    assert_eq!(run(FailedReader, Vec::new()).unwrap_err().code, "IO_ERROR");
}
