#[cfg(test)]
mod workflow_tests {
    use super::*;
    #[tokio::test]
    async fn workflow_flags_fail_before_runtime_or_storage_access() {
        for args in [
            vec!["llmup-native", "ls", "--message", "hello"],
            vec!["llmup-native", "chat", "--message", "hello", "--installed"],
            vec![
                "llmup-native",
                "migrate",
                "--from",
                "a",
                "--to",
                "b",
                "--move",
            ],
            vec![
                "llmup-native",
                "migrate",
                "--from",
                "a",
                "--to",
                "b",
                "--yes",
            ],
        ] {
            assert!(execute(Args::try_parse_from(args).unwrap()).await.is_err());
        }
    }
    #[test]
    fn workflow_arguments_parse_without_changing_advice_defaults() {
        let chat = Args::try_parse_from([
            "llmup-native",
            "chat",
            "-m",
            "test",
            "--harness",
            "openai",
            "--message",
            "hello",
        ])
        .unwrap();
        assert_eq!(chat.chat_model.as_deref(), Some("test"));
        assert_eq!(chat.harness.as_deref(), Some("openai"));
        assert_eq!(
            Args::try_parse_from(["llmup-native"]).unwrap().command,
            "recommend"
        );
    }
}
use clap::Parser;
use llmup_core::{
    advice::{hardware_score, verdict},
    catalog::{Catalog, PerfDataset, resolve},
    ranking::{AdviceOptions, recommend},
    reports::{can_run, catalog_text, recommendation_text, sanitized, strip_control},
    sizing::Hardware,
};
use llmup_runtime::{
    diagnostics,
    hardware::{detect, validate_hardware},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "llmup-native",
    version,
    about = "Experimental native advice and runtime lifecycle; production entry points remain unchanged"
)]
struct Args {
    #[arg(default_value="recommend", value_parser=["recommend","can-run","catalog","doctor","ls","up","switch","down","chat","migrate"])]
    command: String,
    model: Option<String>,
    #[arg(short = 'm', long = "model")]
    chat_model: Option<String>,
    #[arg(long)]
    harness: Option<String>,
    #[arg(long)]
    message: Option<String>,
    #[arg(long)]
    agent: Option<String>,
    #[arg(long = "skill")]
    skills: Vec<String>,
    #[arg(long)]
    no_memory: bool,
    #[arg(long)]
    from: Option<String>,
    #[arg(long)]
    to: Option<String>,
    #[arg(long = "move")]
    move_memory: bool,
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    context: Option<f64>,
    #[arg(long)]
    max_context: bool,
    #[arg(long)]
    context_percent: Option<u8>,
    #[arg(long)]
    task: Option<String>,
    #[arg(long)]
    backend: Option<String>,
    #[arg(long,value_parser=clap::value_parser!(u16).range(1..))]
    port: Option<u16>,
    #[arg(long)]
    bypass: bool,
    #[arg(long)]
    installed: bool,
    #[arg(long)]
    fits_only: bool,
    #[arg(long)]
    available_backends: bool,
    #[arg(long)]
    all: bool,
    #[arg(long)]
    refresh: bool,
    #[arg(long)]
    no_tui: bool,
    #[arg(long)]
    tui: bool,
    #[arg(long)]
    no_color: bool,
    #[arg(long, conflicts_with_all = ["no_tui", "json", "message"])]
    accessible: bool,
    #[arg(long, hide = true)]
    hardware_json: Option<String>,
    #[arg(long, hide = true)]
    parity: bool,
    #[arg(long)]
    catalog_path: Option<PathBuf>,
    #[arg(long)]
    perf_path: Option<PathBuf>,
}

fn read_file(path: &PathBuf) -> Result<String, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("dataset exceeds 16 MiB".into());
    }
    Ok(String::from_utf8(bytes)?)
}

struct TerminalEngine {
    provider: String,
    model: Option<String>,
    agent: Option<String>,
    skills: Vec<String>,
    capture: bool,
    expected: std::sync::Mutex<Option<llmup_runtime::state::RuntimeState>>,
}
impl llmup_cli::terminal::ChatEngine for TerminalEngine {
    async fn reply(
        &self,
        messages: &[llmup_runtime::harness::HarnessMessage],
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<llmup_cli::terminal::ChatReply, String> {
        let (message, history) = messages.split_last().ok_or("empty conversation")?;
        let expected = if self.provider == "local" {
            let config = llmup_runtime::state::Config::load().map_err(|error| error.to_string())?;
            let current = llmup_runtime::state::StateStore::new(config)
                .read()
                .map_err(|error| error.to_string())?;
            let mut expected = self
                .expected
                .lock()
                .map_err(|_| "session state unavailable")?;
            Some(expected.get_or_insert(current).clone())
        } else {
            None
        };
        let options = llmup_runtime::native_chat::NativeChatOptions {
            provider: self.provider.clone(),
            model: self.model.clone(),
            message: message.content.clone(),
            agent: self.agent.clone(),
            skills: self.skills.clone(),
            capture: self.capture,
        };
        let result = llmup_runtime::native_chat::run_with_history(
            &options,
            Some(history),
            expected.as_ref(),
            cancel,
            &mut |_| Ok(()),
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(llmup_cli::terminal::ChatReply {
            content: result["content"].as_str().ok_or("missing response")?.into(),
            memory_warning: result["memoryCaptured"] == false,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParityRequest {
    hardware: Hardware,
    #[serde(default)]
    options: AdviceOptions,
    queries: Option<Vec<String>>,
}

async fn execute(mut args: Args) -> Result<u8, Box<dyn std::error::Error>> {
    let presentation_title = args.command.clone();
    let visual_supported = ([
        "recommend",
        "can-run",
        "catalog",
        "doctor",
        "ls",
        "up",
        "switch",
        "down",
    ]
    .contains(&args.command.as_str())
        || (args.command == "chat" && args.message.is_none() && !args.json && !args.accessible))
        && !args.parity;
    if args.tui && !visual_supported {
        return Err("--tui requires a native read-only command or interactive chat without --accessible, --json, or --message".into());
    }
    let presentation = if visual_supported {
        Some(
            llmup_cli::tui_mode::resolve(
                &llmup_cli::tui_mode::Options {
                    json: args.json,
                    tui: args.tui,
                    no_tui: args.no_tui,
                    no_color: args.no_color,
                    environment_no_color: std::env::var_os("NO_COLOR").is_some(),
                    ..Default::default()
                },
                &llmup_cli::tui_mode::capture(),
            )
            .map_err(|reason| {
                format!("interactive UI is incompatible with this invocation ({reason})")
            })?,
        )
    } else {
        None
    };
    if args.refresh && (args.command != "catalog" || args.parity) {
        return Err("--refresh is only supported by catalog".into());
    }
    if args.accessible && args.command != "chat" {
        return Err("--accessible currently requires chat".into());
    }
    if args.command != "chat"
        && (args.chat_model.is_some()
            || args.harness.is_some()
            || args.message.is_some()
            || args.agent.is_some()
            || !args.skills.is_empty()
            || args.no_memory)
    {
        return Err("chat options require chat".into());
    }
    if args.command != "migrate"
        && (args.from.is_some()
            || args.to.is_some()
            || args.move_memory
            || args.dry_run
            || args.yes)
    {
        return Err("migration options require migrate".into());
    }
    if ["chat", "migrate"].contains(&args.command.as_str()) {
        if args.model.is_some()
            || args.backend.is_some()
            || args.port.is_some()
            || args.bypass
            || args.installed
            || args.fits_only
            || args.all
            || args.max_context
            || args.context_percent.is_some()
            || args.available_backends
            || args.task.is_some()
            || args.parity
            || args.hardware_json.is_some()
        {
            return Err("advice and lifecycle options cannot be used with chat or migrate".into());
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        if args.command == "chat" {
            if args.context.is_some() {
                return Err("--context is not a chat option".into());
            }
            if args.message.is_none() && !args.json {
                use llmup_cli::terminal::{Mode, run_chat, stdin_turns};
                let engine = TerminalEngine {
                    provider: args.harness.unwrap_or_else(|| "local".into()),
                    model: args.chat_model,
                    agent: args.agent,
                    skills: args.skills,
                    capture: !args.no_memory,
                    expected: Default::default(),
                };
                if !["local", "claude", "openai", "openai-compatible", "opencode"]
                    .contains(&engine.provider.as_str())
                {
                    return Err("unknown chat harness".into());
                }
                if engine.provider != "local"
                    && engine
                        .model
                        .as_ref()
                        .is_none_or(|model| model.trim().is_empty())
                {
                    return Err("--model is required for remote chat".into());
                }
                if let Some(selection) = &presentation
                    && selection.mode == llmup_cli::tui_mode::Mode::Tui
                {
                    let title = format!(
                        "{} / {}",
                        engine.provider,
                        engine.model.as_deref().unwrap_or("active model")
                    );
                    let (summary, code) =
                        llmup_cli::tui_chat::run_chat(&title, &engine, selection.color, &cancel)
                            .await?;
                    println!(
                        "Chat session ended: {} turn{}, {} memory warning{}.",
                        summary.turns,
                        if summary.turns == 1 { "" } else { "s" },
                        summary.memory_warnings,
                        if summary.memory_warnings == 1 {
                            ""
                        } else {
                            "s"
                        }
                    );
                    return Ok(code);
                }
                let signal_cancel = cancel.clone();
                let signal = tokio::spawn(async move {
                    if tokio::signal::ctrl_c().await.is_ok() {
                        signal_cancel.cancel();
                    }
                });
                let mode = if args.accessible {
                    Mode::Accessible
                } else {
                    Mode::Plain
                };
                use std::io::IsTerminal;
                if std::io::stdin().is_terminal() {
                    eprintln!("Chatting using {}. End input to exit.", engine.provider);
                }
                let result = run_chat(
                    stdin_turns(),
                    &engine,
                    mode,
                    &cancel,
                    &mut std::io::stdout(),
                    &mut std::io::stderr(),
                )
                .await;
                signal.abort();
                let summary = result?;
                return Ok(if summary.cancelled {
                    130
                } else {
                    u8::from(summary.failed_turns > 0)
                });
            }
            let message = match args.message {
                Some(message) => message,
                None => {
                    use std::io::IsTerminal;
                    if std::io::stdin().is_terminal() {
                        return Err("JSON chat requires --message or piped stdin".into());
                    }
                    let mut message = String::new();
                    std::io::stdin()
                        .take(1024 * 1024 + 1)
                        .read_to_string(&mut message)?;
                    if message.len() > 1024 * 1024 {
                        return Err("chat input exceeds 1 MiB".into());
                    }
                    message
                }
            };
            let options = llmup_runtime::native_chat::NativeChatOptions {
                provider: args.harness.unwrap_or_else(|| "local".into()),
                model: args.chat_model,
                message,
                agent: args.agent,
                skills: args.skills,
                capture: !args.no_memory,
            };
            let mut sink = |text: &str| {
                if !args.json {
                    std::io::stdout()
                        .write_all(strip_control(text).as_bytes())
                        .and_then(|_| std::io::stdout().flush())
                        .map_err(|_| llmup_runtime::harness::HarnessError::Transport)?;
                }
                Ok(())
            };
            let operation = llmup_runtime::native_chat::run(&options, &cancel, &mut sink);
            tokio::pin!(operation);
            let result = tokio::select! { result=&mut operation=>result?,_=tokio::signal::ctrl_c()=>{cancel.cancel();operation.await?} };
            if args.json {
                println!("{}", serde_json::to_string_pretty(&sanitized(&result))?);
            } else {
                println!();
                if result["memoryCaptured"] == false {
                    eprintln!("Memory capture failed; the reply was not recorded.");
                }
            }
            return Ok(0);
        }
        let from = args.from.as_deref().ok_or("--from is required")?;
        let to = args.to.as_deref().ok_or("--to is required")?;
        if args.yes && !args.move_memory {
            return Err("--yes requires --move".into());
        }
        if args.move_memory && !args.yes && !args.dry_run {
            return Err("--move requires explicit --yes".into());
        }
        let catalog_raw = args
            .catalog_path
            .as_ref()
            .map(read_file)
            .transpose()?
            .unwrap_or_else(|| include_str!("../../../data/models.json").into());
        let catalog = Catalog::parse(&catalog_raw)?;
        let context = match args.context {
            Some(context)
                if context.is_finite()
                    && context.fract() == 0.0
                    && (1.0..=10000000.0).contains(&context) =>
            {
                context as u32
            }
            Some(_) => return Err("invalid migration context".into()),
            None => {
                resolve(&catalog, to)
                    .map_err(|_| "target model is ambiguous or unknown; specify --context")?
                    .model
                    .context_length as u32
            }
        };
        let from = resolve(&catalog, from)
            .map(|resolved| resolved.model.id.as_str())
            .unwrap_or(from);
        let to = resolve(&catalog, to)
            .map(|resolved| resolved.model.id.as_str())
            .unwrap_or(to);
        let stamp = llmup_runtime::native_chat::timestamp()?;
        let request = llmup_runtime::migration_service::MigrationRequest {
            source: from,
            target: to,
            context,
            dry_run: args.dry_run,
            move_source: args.move_memory,
            timestamp: &stamp,
            embedder: None,
            target_dimension: None,
        };
        let operation = llmup_runtime::migration_service::run_native(request, &cancel);
        tokio::pin!(operation);
        let summary = tokio::select! { result=&mut operation=>result?,_=tokio::signal::ctrl_c()=>{cancel.cancel();operation.await?} };
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"from":from,"to":to,"dryRun":args.dry_run,"move":args.move_memory,"summary":summary})
            )?
        );
        return Ok(0);
    }
    if !args.parity {
        if !["can-run", "up", "switch"].contains(&args.command.as_str()) && args.model.is_some() {
            return Err("this command does not accept a model argument".into());
        }
        if args.command != "catalog" && args.all {
            return Err("--all is only supported by catalog".into());
        }
        if args.command != "recommend"
            && (args.task.is_some()
                || args.context_percent.is_some()
                || args.max_context
                || args.available_backends)
        {
            return Err("recommendation options are not supported by this command".into());
        }
        if !["recommend", "can-run", "up", "switch"].contains(&args.command.as_str())
            && (args.context.is_some() || args.backend.is_some())
        {
            return Err("--context and --backend require recommend or can-run".into());
        }
        if ["can-run", "up", "switch"].contains(&args.command.as_str())
            && args.model.is_none()
            && (args.installed
                || !presentation
                    .as_ref()
                    .is_some_and(|selection| selection.mode == llmup_cli::tui_mode::Mode::Tui))
        {
            return Err("model is required".into());
        }
        if !["up", "switch"].contains(&args.command.as_str())
            && (args.bypass
                || ((args.port.is_some() || args.installed)
                    && !(args.installed
                        && ["recommend", "can-run"].contains(&args.command.as_str()))))
        {
            return Err("runtime selection flags require up or switch".into());
        }
        if args.fits_only && !(args.command == "recommend" && args.installed) {
            return Err("--fits-only requires recommend --installed".into());
        }
        if args.installed
            && ["recommend", "can-run"].contains(&args.command.as_str())
            && (args.task.is_some()
                || args.context_percent.is_some()
                || args.max_context
                || args.available_backends
                || args
                    .backend
                    .as_ref()
                    .is_some_and(|backend| backend != "ollama"))
        {
            return Err("installed comparison only supports Ollama context options".into());
        }
        AdviceOptions {
            task: args.task.clone(),
            context: args.context,
            context_percent: args.context_percent,
            max_context: args.max_context,
            backend: args.backend.clone(),
            available_backends: None,
        }
        .validate()?;
    }
    if args.command == "ls" && !args.parity {
        let store = llmup_runtime::state::StateStore::new(llmup_runtime::state::Config::load()?);
        let (report, text) = match store.read()?.active {
            None => (json!({"type":"empty"}), "No active model.\n".to_owned()),
            Some(active) => {
                let mut report = json!({"type":"active","modelId":active.model_id,"backend":active.backend,"endpoint":active.endpoint,"port":active.port,"ownedByUs":active.owned_by_us});
                if let Some(id) = &active.runtime_model_id {
                    report["runtimeModelId"] = json!(id);
                }
                if let Some(context) = active.context {
                    report["context"] = json!(context);
                }
                let mut text = format!(
                    "{}\n",
                    llmup_core::reports::table(
                        &[
                            ("Model", false),
                            ("Backend", false),
                            ("Endpoint", false),
                            ("Port", true),
                            ("Status", false)
                        ],
                        vec![vec![
                            active.model_id,
                            active.backend,
                            active.endpoint,
                            active.port.to_string(),
                            if active.owned_by_us {
                                "owned".into()
                            } else {
                                "attached".into()
                            }
                        ]]
                    )
                );
                if let Some(id) = active.runtime_model_id {
                    text.push_str(&format!("Runtime model: {}\n", strip_control(&id)));
                }
                if let Some(context) = active.context {
                    text.push_str(&format!("Context: {context} tokens\n"));
                }
                (report, text)
            }
        };
        if args.json {
            println!("{}", serde_json::to_string_pretty(&sanitized(&report))?);
        } else {
            let presentation_exit =
                present_read_only(presentation.as_ref(), &presentation_title, &text).await?;
            if presentation_exit != 0 {
                return Ok(presentation_exit);
            }
        }
        return Ok(0);
    }
    let catalog_raw = args
        .catalog_path
        .as_ref()
        .map(read_file)
        .transpose()?
        .unwrap_or_else(|| include_str!("../../../data/models.json").into());
    let perf_raw = args
        .perf_path
        .as_ref()
        .map(read_file)
        .transpose()?
        .unwrap_or_else(|| include_str!("../../../data/perf.json").into());
    let catalog = Catalog::parse(&catalog_raw)?;
    let perf = PerfDataset::parse(&perf_raw)?;
    if args.model.is_none()
        && ["can-run", "up", "switch"].contains(&args.command.as_str())
        && let Some(selection) = &presentation
        && selection.mode == llmup_cli::tui_mode::Mode::Tui
    {
        let choices: Vec<_> = catalog
            .models
            .iter()
            .map(|model| format!("{}  {}  {}", model.id, model.params, model.family))
            .collect();
        let (selected, code) = llmup_cli::tui_view::pick(
            &format!("{} / choose model", args.command),
            &choices,
            selection.color,
        )
        .await?;
        let Some(selected) = selected else {
            return Ok(code);
        };
        args.model = Some(catalog.models[selected].id.clone());
    }
    if ["up", "switch", "down"].contains(&args.command.as_str()) && !args.parity {
        let options = llmup_runtime::application::LifecycleOptions {
            command: args.command,
            model: args.model,
            backend: args.backend,
            port: args.port,
            context: args.context.map(|value| value as u32),
            installed: args.installed,
            bypass: args.bypass,
        };
        options.validate()?;
        if let Some(selection) = &presentation
            && selection.mode == llmup_cli::tui_mode::Mode::Tui
        {
            let description = format!(
                "Proceed: {} {} / backend {} / port {} / context {}{}",
                options.command,
                options.model.as_deref().unwrap_or("owned servers"),
                options.backend.as_deref().unwrap_or("default"),
                options
                    .port
                    .map_or_else(|| "default".into(), |port| port.to_string()),
                options
                    .context
                    .map_or_else(|| "default".into(), |context| context.to_string()),
                if options.bypass {
                    " / hardware fit bypass enabled"
                } else {
                    ""
                }
            );
            let (selected, code) = llmup_cli::tui_view::pick(
                &format!("{} / confirm", options.command),
                &["Cancel".into(), description],
                selection.color,
            )
            .await?;
            if selected != Some(1) {
                return Ok(code);
            }
        }
        let hardware = if options.command == "down" || options.installed {
            None
        } else if let Some(raw) = args.hardware_json {
            if raw.len() > 65536 {
                return Err("hardware input exceeds 64 KiB".into());
            }
            let hardware: Hardware = serde_json::from_str(&raw)?;
            validate_hardware(&hardware)?;
            Some(hardware)
        } else {
            let (hardware, warnings) = detect().await?;
            for warning in warnings {
                eprintln!("{}", strip_control(&warning));
            }
            Some(hardware)
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        let operation =
            llmup_runtime::application::run_native(&options, &catalog, hardware.as_ref(), &cancel);
        tokio::pin!(operation);
        let (report, text) = tokio::select! {result=&mut operation=>result?,_=tokio::signal::ctrl_c()=>{cancel.cancel();operation.await?}};
        if args.json {
            println!("{}", serde_json::to_string_pretty(&sanitized(&report))?);
        } else {
            print!("{text}");
        }
        return Ok(0);
    }
    if args.parity {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("parity input exceeds 8 MiB".into());
        }
        let requests: Vec<ParityRequest> = serde_json::from_slice(&bytes)?;
        if requests.len() > 1024 {
            return Err("too many parity requests".into());
        }
        let mut outputs = Vec::new();
        for request in requests {
            validate_hardware(&request.hardware)?;
            let recommendation = recommend(&catalog, &request.hardware, &perf, &request.options)?;
            let mut checks = Vec::new();
            for query in request.queries.unwrap_or_default() {
                checks.push(match resolve(&catalog, &query) {
                    Ok(resolved) => {
                        let (report, text) =
                            can_run(&catalog, &request.hardware, &perf, &query, &request.options)?;
                        json!({"resolved":resolved,"report":report,"text":text})
                    }
                    Err(error) => json!({"error":error}),
                });
            }
            let verdicts: Vec<_> = catalog
                .models
                .iter()
                .map(|model| {
                    verdict(
                        model,
                        &request.hardware,
                        &perf,
                        request.options.tokens(model),
                        request.options.backend.as_deref().unwrap_or("ollama"),
                    )
                })
                .collect::<Result<_, _>>()?;
            outputs.push(json!({"recommendation":sanitized(&recommendation),"text":recommendation_text(&recommendation,&request.options),"score":hardware_score(&request.hardware),"catalogText":catalog_text(&catalog,&request.hardware,true)?,"checks":checks,"verdicts":verdicts}));
        }
        serde_json::to_writer(std::io::stdout().lock(), &outputs)?;
        println!();
        return Ok(0);
    }
    let hardware = if let Some(raw) = args.hardware_json {
        if raw.len() > 65536 {
            return Err("hardware input exceeds 64 KiB".into());
        }
        let hardware: Hardware = serde_json::from_str(&raw)?;
        validate_hardware(&hardware)?;
        hardware
    } else {
        let (hardware, warnings) = detect().await?;
        for warning in warnings {
            eprintln!("{}", strip_control(&warning));
        }
        hardware
    };
    if args.installed && ["recommend", "can-run"].contains(&args.command.as_str()) {
        let cancel = tokio_util::sync::CancellationToken::new();
        let operation = llmup_runtime::application::installed_inventory(
            &hardware,
            args.model.as_deref(),
            args.port.unwrap_or(11434),
            args.context.map(|context| context as u32),
            args.fits_only,
            &cancel,
        );
        tokio::pin!(operation);
        let (report, text, exit) = tokio::select! {result=&mut operation=>result?,_=tokio::signal::ctrl_c()=>{cancel.cancel();operation.await?}};
        if args.json {
            println!("{}", serde_json::to_string_pretty(&sanitized(&report))?);
        } else {
            let presentation_exit =
                present_read_only(presentation.as_ref(), &presentation_title, &text).await?;
            if presentation_exit != 0 {
                return Ok(presentation_exit);
            }
        }
        return Ok(exit);
    }
    let mut options = AdviceOptions {
        task: args.task,
        context: args.context,
        context_percent: args.context_percent,
        max_context: args.max_context,
        backend: args.backend,
        available_backends: None,
    };
    options.validate()?;
    if args.available_backends {
        options.available_backends = Some(
            diagnostics::probe_backends(&hardware)
                .await
                .into_iter()
                .filter(|entry| entry.installed)
                .map(|entry| entry.name)
                .collect(),
        );
    }
    let (report, text, exit) = match args.command.as_str() {
        "recommend" => {
            let report = recommend(&catalog, &hardware, &perf, &options)?;
            let text = recommendation_text(&report, &options);
            (report, format!("{text}\n"), 0)
        }
        "can-run" => {
            let query = args.model.as_deref().ok_or("model is required")?;
            let (report, text) = can_run(&catalog, &hardware, &perf, query, &options)?;
            let exit = u8::from(report["verdict"] == "no");
            (report, format!("{text}\n"), exit)
        }
        "catalog" => {
            if args.json {
                return Err("catalog --json is not part of the existing CLI contract".into());
            }
            let text = if args.refresh {
                use llmup_core::enrich::{Mode, enrich, format_diff, parse_candidates};
                let candidates = parse_candidates(include_str!(
                    "../../llmup-core/fixtures/registry-snapshot.json"
                ))?;
                let result = enrich(
                    &catalog,
                    &candidates,
                    Mode::Incremental,
                    &llmup_runtime::native_chat::timestamp()?,
                    None,
                )?;
                format!(
                    "{}{}",
                    format_diff(&result.diff),
                    catalog_text(&result.catalog, &hardware, args.all)?
                )
            } else {
                catalog_text(&catalog, &hardware, args.all)?
            };
            (Value::Null, text, 0)
        }
        "doctor" => {
            let backends = diagnostics::probe_backends(&hardware).await;
            let home = std::env::var_os("LOCAL_LLMUP_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .or_else(|| std::env::var_os("USERPROFILE"))
                        .map(|home| PathBuf::from(home).join(".local-llmup"))
                })
                .ok_or("cannot determine state directory")?;
            let exists = home.join("state.json").try_exists().unwrap_or(true);
            let mut report = diagnostics::report(&catalog, &hardware, &backends, exists);
            let check_options = llmup_runtime::application::LifecycleOptions {
                command: "doctor".into(),
                model: None,
                backend: None,
                port: None,
                context: None,
                installed: false,
                bypass: false,
            };
            let state_check = match llmup_runtime::application::run_native(
                &check_options,
                &catalog,
                None,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            {
                Ok((check, _)) => check,
                Err(error) => {
                    json!({"name":"state","status":"fail","detail":format!("runtime state/readiness failed: {}",strip_control(&error.to_string()))})
                }
            };
            if let Some(checks) = report["checks"].as_array_mut() {
                if let Some(check) = checks.iter_mut().find(|check| check["name"] == "state") {
                    *check = state_check;
                }
                let ok = checks.iter().all(|check| check["status"] != "fail");
                report["ok"] = json!(ok);
            }
            let text = diagnostics::format_report(&report);
            let exit = u8::from(report["ok"] == false);
            (report, text, exit)
        }
        _ => return Err("unsupported command".into()),
    };
    let output = if args.json {
        format!("{}\n", serde_json::to_string_pretty(&sanitized(&report))?)
    } else {
        text
    };
    let presentation_exit =
        present_read_only(presentation.as_ref(), &presentation_title, &output).await?;
    if presentation_exit != 0 {
        return Ok(presentation_exit);
    }
    Ok(exit)
}

async fn present_read_only(
    selection: Option<&llmup_cli::tui_mode::Selection>,
    title: &str,
    text: &str,
) -> Result<u8, Box<dyn std::error::Error>> {
    if let Some(selection) = selection
        && selection.mode == llmup_cli::tui_mode::Mode::Tui
    {
        let exit = llmup_cli::tui_view::show_report(title, text, selection.color).await?;
        if exit != 0 {
            return Ok(exit);
        }
    }
    std::io::stdout().lock().write_all(text.as_bytes())?;
    Ok(0)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    let command = args.command.clone();
    match execute(args).await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("{command}: {}", strip_control(&error.to_string()));
            ExitCode::from(1)
        }
    }
}
