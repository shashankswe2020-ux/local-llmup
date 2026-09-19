use crate::{
    Host,
    routes::{ApiResult, bad, body, json_response},
};
use axum::extract::Request;
use llmup_core::{
    catalog::{Catalog, PerfDataset},
    ranking::{AdviceOptions, recommend_detailed},
};
use llmup_runtime::{
    application::{LifecycleOptions, run_native_with_config},
    state::{Config, StateStore},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
fn active(host: &Host) -> Result<Value, crate::routes::ApiError> {
    let store = StateStore::new(Config::from_home(&host.home).map_err(|_| bad())?);
    Ok(match store.read().map_err(|_| bad())?.active {
        None => Value::Null,
        Some(active) => {
            let mut value = json!({"modelId":active.model_id,"backend":active.backend,"endpoint":active.endpoint,"port":active.port,"ownership":if active.owned_by_us{"owned"}else{"attached"}});
            if let Some(id) = active.runtime_model_id {
                value["runtimeModelId"] = json!(id);
            }
            if let Some(context) = active.context {
                value["context"] = json!(context);
            }
            value
        }
    })
}
pub fn recommended(
    catalog: &Catalog,
    hardware: &llmup_core::sizing::Hardware,
    perf: &PerfDataset,
    options: &AdviceOptions,
) -> Result<Vec<Value>, llmup_core::sizing::ValidationError> {
    let report = recommend_detailed(catalog, hardware, perf, options)?;
    let entries = report["ranked"]
        .as_array()
        .ok_or_else(|| llmup_core::sizing::ValidationError("ranked models missing".into()))?;
    entries.iter().take(8).map(|entry|{
        let source=catalog.models.iter().find(|model|entry["id"]==model.id).ok_or_else(||llmup_core::sizing::ValidationError("ranked model absent".into()))?;
        let source=serde_json::to_value(source).map_err(|_|llmup_core::sizing::ValidationError("invalid model".into()))?;
        let mut model=json!({});
        for key in ["id","family","params","architecture","activeParams","license","openWeight","contextLength","capabilities","releaseDate","source","quantizations","kvBytesPerToken","benchmarkProxy"] {if let Some(value)=source.get(key){model[key]=value.clone();}}
        for key in ["verdict","requiredBytes","usableBytes","score","scores","throughput","throughputEvidence","backends"] {model[key]=entry[key].clone();}
        model["quant"]=entry["quant"].clone();
        model["diskBytes"]=source["quantizations"].as_array().and_then(|quants|quants.iter().find(|quant|quant["name"]==entry["quant"])).map(|quant|quant["diskBytes"].clone()).unwrap_or(Value::Null);
        if let Some(tokens)=entry.get("context") {model["contextTokens"]=tokens.clone();model["contextFitKnown"]=json!(!entry["kvCacheBytes"].is_null());model["contextSizing"]=json!({"tokens":tokens,"weightsBytes":entry["weightsBytes"],"kvCacheBytes":entry["kvCacheBytes"]});}
        Ok(model)
    }).collect()
}
pub async fn dispatch(host: Arc<Host>, request: Request) -> ApiResult {
    let method = request.method().as_str().to_owned();
    let url = url::Url::parse(&format!("{}{}", host.origin(), request.uri())).map_err(|_| bad())?;
    let path = url.path();
    if path == "/api/models/active" && method == "GET" {
        return Ok(json_response(json!({"active":active(&host)?})));
    }
    if path == "/api/runtimes" && method == "GET" {
        return Ok(json_response(
            json!({"runtimes":llmup_core::catalog::BACKENDS}),
        ));
    }
    if path.starts_with("/api/runtimes/") {
        let config = Config::from_home(&host.home).map_err(|_| bad())?;
        let mut runtimes = host.runtimes.lock().await;
        if path == "/api/runtimes/status" && method == "GET" {
            return Ok(json_response(
                json!({"runtimes":runtimes.list(config,&host.shutdown).await.map_err(|_|bad())?}),
            ));
        }
        let parts: Vec<_> = path.split('/').collect();
        if method == "POST" && parts.len() == 5 && ["start", "stop"].contains(&parts[4]) {
            return Ok(json_response(
                json!({"runtime":runtimes.change(config,parts[3],parts[4]=="start",&host.shutdown).await.map_err(|_|bad())?}),
            ));
        }
        return Err(bad());
    }
    let (hardware, _) = llmup_runtime::hardware::detect().await.map_err(|_| bad())?;
    if path == "/api/hardware" && method == "GET" {
        return Ok(json_response(json!({"hardware":hardware})));
    }
    let catalog = Catalog::parse(include_str!("../../../data/models.json")).map_err(|_| bad())?;
    if path == "/api/models/recommended" && method == "GET" {
        let query: BTreeMap<String, String> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let context = query
            .get("tokens")
            .map(|value| value.parse::<f64>().map_err(|_| bad()))
            .transpose()?;
        let preset = query
            .get("context")
            .map(|value| match value.as_str() {
                "low" => Ok(25),
                "mid" => Ok(50),
                "high" => Ok(75),
                "max" => Ok(100),
                _ => Err(bad()),
            })
            .transpose()?;
        let options = AdviceOptions {
            context,
            context_percent: preset,
            backend: query.get("runtime").cloned(),
            ..Default::default()
        };
        options.validate().map_err(|_| bad())?;
        let perf =
            PerfDataset::parse(include_str!("../../../data/perf.json")).map_err(|_| bad())?;
        let models = recommended(&catalog, &hardware, &perf, &options).map_err(|_| bad())?;
        return Ok(json_response(
            json!({"models":models,"runtime":query.get("runtime"),"contextPreset":query.get("context")}),
        ));
    }
    if path == "/api/models/installed" && method == "GET" {
        let query: BTreeMap<String, String> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let port = query
            .get("port")
            .map(|value| value.parse::<u16>().map_err(|_| bad()))
            .transpose()?
            .unwrap_or(11434);
        let context = query
            .get("tokens")
            .map(|value| value.parse::<u32>().map_err(|_| bad()))
            .transpose()?;
        let (report, _, _) = llmup_runtime::application::installed_inventory(
            &hardware,
            None,
            port,
            context,
            false,
            &host.shutdown,
        )
        .await
        .map_err(|_| bad())?;
        return Ok(json_response(
            json!({"models":report["models"],"source":"local-runtime-metadata"}),
        ));
    }
    if path == "/api/models/up" && method == "POST" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Up {
            model: String,
            backend: Option<String>,
            port: Option<u16>,
            context: Option<u32>,
            #[serde(default)]
            installed: bool,
            #[serde(default)]
            bypass: bool,
        }
        let input: Up = body(request, crate::MAX_REQUEST_BYTES).await?;
        let options = LifecycleOptions {
            command: "up".into(),
            model: Some(input.model),
            backend: input.backend,
            port: input.port,
            context: input.context,
            installed: input.installed,
            bypass: input.bypass,
        };
        run_native_with_config(
            &options,
            &catalog,
            Some(&hardware),
            &host.shutdown,
            Config::from_home(&host.home).map_err(|_| bad())?,
        )
        .await
        .map_err(|_| bad())?;
        let active = active(&host)?;
        host.ui.lock().await.model = active["modelId"].as_str().unwrap_or("local").into();
        return Ok(json_response(json!({"active":active})));
    }
    Err(crate::routes::missing())
}
