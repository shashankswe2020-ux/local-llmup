use serde::Deserialize;
use std::io::Read;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    hardware: llmup_core::sizing::Hardware,
    options: llmup_core::ranking::AdviceOptions,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("input limit".into());
    }
    let requests: Vec<Input> = serde_json::from_slice(&bytes)?;
    if requests.len() > 1024 {
        return Err("request limit".into());
    }
    let catalog = llmup_core::catalog::Catalog::parse(include_str!("../../../data/models.json"))?;
    let perf = llmup_core::catalog::PerfDataset::parse(include_str!("../../../data/perf.json"))?;
    let results = requests
        .iter()
        .map(|request| {
            llmup_gui::models::recommended(&catalog, &request.hardware, &perf, &request.options)
        })
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_writer(std::io::stdout(), &results)?;
    Ok(())
}
