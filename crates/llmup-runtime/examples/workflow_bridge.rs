use llmup_runtime::{
    library::{Kind, Library},
    memory::{
        CaptureOptions, MemoryStore, MigrationOptions, SourceMemory, extract_facts, memory_slug,
        plan_migration,
    },
    workspace::{EditOperation, EditProposal, WorkspaceService},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Slug {
        id: String,
    },
    Facts {
        text: String,
    },
    Document {
        raw: String,
    },
    Migration {
        source: SourceMemory,
        context: u32,
    },
    Capture {
        home: PathBuf,
        model: String,
        user: String,
        assistant: String,
    },
    Memory {
        home: PathBuf,
        model: String,
    },
    Connectors {
        home: PathBuf,
    },
    Library {
        home: PathBuf,
        agent: Option<String>,
        skills: Vec<String>,
    },
    Session {
        home: PathBuf,
        id: String,
    },
    Review {
        root: PathBuf,
        operations: Vec<EditOperation>,
    },
    Search {
        root: PathBuf,
        query: String,
        limit: usize,
        cursor: Option<String>,
    },
    Read {
        root: PathBuf,
        path: String,
        range: Option<llmup_runtime::workspace::LineRange>,
    },
    SessionSearch {
        home: PathBuf,
        query: String,
    },
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut raw = String::new();
    std::io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)?;
    if raw.len() > 8 * 1024 * 1024 {
        return Err("bridge input limit".into());
    }
    let requests: Vec<Request> = serde_json::from_str(&raw)?;
    if requests.len() > 4096 {
        return Err("bridge request limit".into());
    }
    let mut results = Vec::new();
    let cancel = CancellationToken::new();
    for request in requests {
        results.push(match request {
            Request::Slug { id } => json!(memory_slug(&id, cfg!(windows))?),
            Request::Facts { text } => json!(extract_facts(&text)?),
            Request::Document { raw } => { let (fields, body) = llmup_runtime::library::parse_document(&raw); json!({"fields":fields,"body":body}) },
            Request::Migration { source, context } => {
                let plan = plan_migration(&source, MigrationOptions { context, embedder: None, target_dimension: None, summarizer: None, embedding_unsupported: false }, &cancel).await?;
                let mut result = serde_json::to_value(plan.source)?;
                result["summary"] = serde_json::to_value(plan.summary)?;
                result
            }
            Request::Capture { home, model, user, assistant } => {
                let store = MemoryStore::open(&home, &model, "2026-09-17T00:00:00.000Z")?;
                serde_json::to_value(store.capture(&user, &assistant, CaptureOptions { timestamp: "2026-09-17T00:00:00.000Z", embedder: None, embedding_unsupported: false }, &cancel).await?)?
            }
            Request::Memory { home, model } => serde_json::to_value(MemoryStore::existing(&home, &model)?.load()?)?,
            Request::Connectors { home } => { let store = llmup_runtime::mcp::ConnectorStore::new(&home); let file = store.load()?; store.save(&file)?; serde_json::to_value(file)? },
            Request::Library { home, agent, skills } => { let library = Library::new(&home); json!({"agents":library.list(Kind::Agent)?,"skills":library.list(Kind::Skill)?,"prompt":library.compose(agent.as_deref(),&skills)?}) },
            Request::Session { home, id } => serde_json::to_value(llmup_runtime::sessions::SessionRepository::new(&home).get(&id)?)?,
            Request::Review { root, operations } => {
                let mut workspace = WorkspaceService::new();
                let capability = workspace.register(&root)?;
                let mut result = serde_json::to_value(workspace.review(&EditProposal { workspace_id: capability.id, operations })?)?;
                result.as_object_mut().ok_or("invalid review")?.remove("proposalId");
                result
            }
            Request::Search { root, query, limit, cursor } => {
                let mut workspace = WorkspaceService::new();
                let capability = workspace.register(&root)?;
                serde_json::to_value(workspace.search(&capability.id, &query, limit, cursor.as_deref())?)?
            }
            Request::Read { root, path, range } => {
                let mut workspace = WorkspaceService::new();
                let capability = workspace.register(&root)?;
                serde_json::to_value(workspace.read(&capability.id, &path, range)?)?
            }
            Request::SessionSearch { home, query } => {
                json!(llmup_runtime::sessions::SessionRepository::new(&home).search(&query, false)?.into_iter().map(|(summary, snippet)| json!({"summary":summary,"snippet":snippet})).collect::<Vec<_>>())
            }
        });
    }
    serde_json::to_writer(std::io::stdout().lock(), &Value::Array(results))?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
