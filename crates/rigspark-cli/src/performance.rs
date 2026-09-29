use serde::Serialize;
use std::io;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub elapsed_ms: f64,
    pub peak_rss_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub p90_ms: f64,
    pub peak_rss_bytes: u64,
    pub executable_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            p90_ms: 100.0,
            peak_rss_bytes: 64 * 1024 * 1024,
            executable_bytes: 32 * 1024 * 1024,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub median_ms: f64,
    pub p90_ms: f64,
    pub peak_rss_bytes: Option<u64>,
    pub executable_bytes: u64,
    pub samples: Vec<Sample>,
    pub failures: Vec<String>,
}

pub fn evaluate(samples: &[Sample], executable_bytes: u64, limits: &Limits) -> io::Result<Report> {
    if samples.len() < 20
        || samples.len() > 1000
        || executable_bytes == 0
        || !limits.p90_ms.is_finite()
        || limits.p90_ms <= 0.0
        || limits.peak_rss_bytes == 0
        || limits.executable_bytes == 0
        || samples.iter().any(|sample| {
            !sample.elapsed_ms.is_finite()
                || sample.elapsed_ms <= 0.0
                || sample.peak_rss_bytes == Some(0)
        })
    {
        return Err(io::Error::other("invalid performance samples or limits"));
    }
    let mut durations: Vec<_> = samples.iter().map(|sample| sample.elapsed_ms).collect();
    durations.sort_by(f64::total_cmp);
    let median_ms = durations[durations.len().div_ceil(2) - 1];
    let p90_ms = durations[(durations.len() * 9).div_ceil(10) - 1];
    let peak_rss_bytes = samples.iter().try_fold(0, |maximum, sample| {
        sample.peak_rss_bytes.map(|value| maximum.max(value))
    });
    let mut failures = Vec::new();
    if p90_ms > limits.p90_ms {
        failures.push(format!("p90 {p90_ms:.3}ms exceeds {}ms", limits.p90_ms));
    }
    match peak_rss_bytes {
        None => failures.push("peak RSS unknown; memory budget is not verified".into()),
        Some(bytes) if bytes > limits.peak_rss_bytes => failures.push(format!(
            "peak RSS {bytes} exceeds {} bytes",
            limits.peak_rss_bytes
        )),
        _ => (),
    }
    if executable_bytes > limits.executable_bytes {
        failures.push(format!(
            "executable {executable_bytes} exceeds {} bytes",
            limits.executable_bytes
        ));
    }
    Ok(Report {
        median_ms,
        p90_ms,
        peak_rss_bytes,
        executable_bytes,
        samples: samples.to_vec(),
        failures,
    })
}

pub fn peak_rss(platform: &str, stderr: &str) -> Option<u64> {
    let values: Vec<_> = stderr
        .lines()
        .filter_map(|line| {
            let raw = match platform {
                "linux" => line.strip_prefix("LLMUP_PEAK_RSS_KIB="),
                "macos" => line.trim().strip_suffix("maximum resident set size"),
                _ => None,
            }?;
            Some(raw.trim().parse::<u64>().ok())
        })
        .collect();
    if values.len() != 1 {
        return None;
    }
    let value = values[0]?;
    let bytes = if platform == "linux" {
        value.checked_mul(1024)?
    } else {
        value
    };
    (bytes > 0).then_some(bytes)
}
