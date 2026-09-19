use llmup_cli::performance::{Limits, Sample, evaluate, peak_rss};

fn samples() -> Vec<Sample> {
    (1..=20)
        .map(|value| Sample {
            elapsed_ms: f64::from(value),
            peak_rss_bytes: Some(1024),
        })
        .collect()
}

#[test]
fn reports_nearest_rank_quantiles_and_enforces_all_limits() {
    let limits = Limits {
        p90_ms: 18.0,
        peak_rss_bytes: 1024,
        executable_bytes: 4096,
    };
    let report = evaluate(&samples(), 4096, &limits).unwrap();
    assert_eq!(report.median_ms, 10.0);
    assert_eq!(report.p90_ms, 18.0);
    assert!(report.failures.is_empty());
    let exceeded = Limits {
        p90_ms: 17.0,
        peak_rss_bytes: 1023,
        executable_bytes: 4095,
    };
    assert_eq!(
        evaluate(&samples(), 4096, &exceeded)
            .unwrap()
            .failures
            .len(),
        3
    );
}

#[test]
fn incomplete_or_invalid_measurements_never_pass() {
    let limits = Limits {
        p90_ms: 100.0,
        peak_rss_bytes: 1024,
        executable_bytes: 4096,
    };
    assert!(evaluate(&samples()[..19], 4096, &limits).is_err());
    for duration in [f64::NAN, f64::INFINITY, -1.0, 0.0] {
        let mut invalid = samples();
        invalid[0].elapsed_ms = duration;
        assert!(evaluate(&invalid, 4096, &limits).is_err());
    }
    let mut unknown = samples();
    unknown[0].peak_rss_bytes = None;
    let report = evaluate(&unknown, 4096, &limits).unwrap();
    assert_eq!(report.peak_rss_bytes, None);
    assert!(!report.failures.is_empty());
    unknown[0].peak_rss_bytes = Some(0);
    assert!(evaluate(&unknown, 4096, &limits).is_err());
    assert!(evaluate(&samples(), 0, &limits).is_err());
}

#[test]
fn decodes_platform_peak_rss_units_without_guessing() {
    assert_eq!(
        peak_rss("macos", "  12345678  maximum resident set size\n"),
        Some(12345678)
    );
    assert_eq!(
        peak_rss("linux", "LLMUP_PEAK_RSS_KIB=1234\n"),
        Some(1234 * 1024)
    );
    for (platform, text) in [
        ("windows", "LLMUP_PEAK_RSS_KIB=1234"),
        ("linux", "LLMUP_PEAK_RSS_KIB=18446744073709551615"),
        ("linux", "LLMUP_PEAK_RSS_KIB=0"),
        ("linux", "LLMUP_PEAK_RSS_KIB=10\nLLMUP_PEAK_RSS_KIB=20"),
        ("macos", "unknown maximum resident set size"),
    ] {
        assert_eq!(peak_rss(platform, text), None);
    }
}
