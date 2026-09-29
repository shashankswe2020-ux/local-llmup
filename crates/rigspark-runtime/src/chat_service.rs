use crate::{
    context::{ContextBundle, ContextRef, DisclosureStore},
    harness::{ChatHarness, DeltaSink, HarnessError, HarnessMessage, HarnessRequest},
    library::Library,
    memory::{CaptureOptions, MemoryStore},
    sessions::{SessionDoc, SessionError, SessionRepository, StoredMessage},
    workspace::{WorkspaceError, WorkspaceService},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("invalid chat request")]
    Invalid,
    #[error("context disclosure requires approval")]
    Disclosure,
    #[error(transparent)]
    Harness(#[from] HarnessError),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error("library composition failed")]
    Library,
}
pub struct ChatOptions<'request> {
    pub session_id: &'request str,
    pub revision: u64,
    pub provider: &'request str,
    pub model: &'request str,
    pub message: &'request str,
    pub context: &'request [ContextRef],
    pub agent: Option<&'request str>,
    pub skills: &'request [String],
    pub temperature: Option<f64>,
}
pub struct PreparedChat {
    session_id: String,
    revision: u64,
    provider: String,
    message: String,
    request: HarnessRequest,
    context: ContextBundle,
}
impl PreparedChat {
    pub fn context(&self) -> &ContextBundle {
        &self.context
    }
    pub fn provider(&self) -> &str {
        &self.provider
    }
}
pub struct ChatOutcome {
    pub text: String,
    pub session: SessionDoc,
    pub memory_captured: Option<bool>,
}
pub struct AgentRuntime<'runtime> {
    pub chat: &'runtime dyn crate::agent::AgentChat,
    pub manager: &'runtime mut crate::mcp::Manager,
    pub grants: &'runtime mut crate::tool_policy::SessionGrants,
    pub approver: Option<&'runtime dyn crate::agent::ToolApprover>,
    pub workspace_id: Option<&'runtime str>,
    pub max_steps: usize,
}
pub struct ChatService<'service> {
    pub sessions: &'service SessionRepository,
    pub library: &'service Library,
    pub workspace: &'service WorkspaceService,
    pub disclosures: &'service mut DisclosureStore,
}
impl ChatService<'_> {
    pub fn prepare(&self, options: ChatOptions<'_>) -> Result<PreparedChat, ChatError> {
        self.prepare_with_prompt(options, None)
    }
    pub fn prepare_with_prompt(
        &self,
        options: ChatOptions<'_>,
        system_prompt: Option<&str>,
    ) -> Result<PreparedChat, ChatError> {
        if system_prompt.is_some_and(|text| text.encode_utf16().count() > 48 * 1024) {
            return Err(ChatError::Invalid);
        }
        if options.message.trim().is_empty()
            || options.message.encode_utf16().count() > 32768
            || !["local", "claude", "openai", "openai-compatible", "opencode"]
                .contains(&options.provider)
        {
            return Err(ChatError::Invalid);
        }
        let session = self
            .sessions
            .get(options.session_id)?
            .ok_or(ChatError::Invalid)?;
        if session.archived || session.revision != options.revision {
            return Err(SessionError::Conflict.into());
        }
        let context = ContextBundle::resolve(self.workspace, options.context)?;
        let mut messages = Vec::new();
        if let Some(prompt) = system_prompt.filter(|text| !text.trim().is_empty()) {
            messages.push(HarnessMessage {
                role: "system".into(),
                content: crate::sessions::gui_text(prompt),
            });
        }
        if let Some(instructions) = self
            .library
            .compose(options.agent, options.skills)
            .map_err(|_| ChatError::Library)?
        {
            messages.push(HarnessMessage {
                role: "system".into(),
                content: instructions,
            });
        }
        if !context.text.is_empty() {
            messages.push(HarnessMessage {
                role: "system".into(),
                content: context.text.clone(),
            });
        }
        messages.extend(
            session
                .messages
                .iter()
                .skip(session.messages.len().saturating_sub(20))
                .map(|message| HarnessMessage {
                    role: message.role.clone(),
                    content: message.content.clone(),
                }),
        );
        let message = crate::sessions::gui_text(options.message);
        messages.push(HarnessMessage {
            role: "user".into(),
            content: message.clone(),
        });
        let request = HarnessRequest {
            model: options.model.into(),
            messages,
            temperature: options.temperature,
        };
        request.validate()?;
        Ok(PreparedChat {
            session_id: session.id,
            revision: session.revision,
            provider: options.provider.into(),
            message,
            request,
            context,
        })
    }
    pub fn approve_disclosure(&mut self, prepared: &PreparedChat) {
        self.disclosures
            .approve(&prepared.session_id, &prepared.provider, &prepared.context);
    }
    pub async fn run(
        &self,
        prepared: PreparedChat,
        harness: &dyn ChatHarness,
        timestamp: &str,
        memory: Option<(&MemoryStore, CaptureOptions<'_>)>,
        cancel: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> Result<ChatOutcome, ChatError> {
        if harness.name() != prepared.provider || timestamp.is_empty() || timestamp.len() > 40 {
            return Err(ChatError::Invalid);
        }
        self.authorize(&prepared, timestamp, cancel)?;
        let run = self.sessions.runs.begin(&prepared.session_id, cancel)?;
        let text = tokio::select! { biased; _ = run.token().cancelled() => return Err(HarnessError::Cancelled.into()), result = harness.chat(&prepared.request, run.token(), sink) => result? };
        self.finish(prepared, text, timestamp, memory, &run).await
    }
    pub async fn run_agent(
        &self,
        prepared: PreparedChat,
        runtime: AgentRuntime<'_>,
        timestamp: &str,
        memory: Option<(&MemoryStore, CaptureOptions<'_>)>,
        cancel: &CancellationToken,
        sink: &mut crate::agent::EventSink<'_>,
    ) -> Result<ChatOutcome, ChatError> {
        if prepared.provider != "local" {
            return Err(ChatError::Invalid);
        }
        self.authorize(&prepared, timestamp, cancel)?;
        let run = self.sessions.runs.begin(&prepared.session_id, cancel)?;
        let options = crate::agent::AgentOptions {
            session_id: &prepared.session_id,
            workspace_id: runtime.workspace_id,
            model: &prepared.request.model,
            temperature: prepared.request.temperature,
            max_steps: runtime.max_steps,
            messages: prepared
                .request
                .messages
                .iter()
                .map(|message| crate::ollama_inference::ChatMessage {
                    role: message.role.clone(),
                    content: message.content.clone(),
                    tool_calls: Vec::new(),
                    tool_name: None,
                })
                .collect(),
        };
        let text = crate::agent::run_turn(
            runtime.chat,
            runtime.manager,
            runtime.grants,
            runtime.approver,
            options,
            run.token(),
            sink,
        )
        .await?;
        self.finish(prepared, text, timestamp, memory, &run).await
    }
    fn authorize(
        &self,
        prepared: &PreparedChat,
        timestamp: &str,
        cancel: &CancellationToken,
    ) -> Result<(), ChatError> {
        if timestamp.is_empty() || timestamp.len() > 40 {
            return Err(ChatError::Invalid);
        }
        if !self
            .disclosures
            .allowed(&prepared.session_id, &prepared.provider, &prepared.context)
        {
            return Err(ChatError::Disclosure);
        }
        let current = self
            .sessions
            .get(&prepared.session_id)?
            .ok_or(ChatError::Invalid)?;
        if current.archived || current.revision != prepared.revision {
            return Err(SessionError::Conflict.into());
        }
        if cancel.is_cancelled() {
            return Err(HarnessError::Cancelled.into());
        }
        Ok(())
    }
    async fn finish(
        &self,
        prepared: PreparedChat,
        text: String,
        timestamp: &str,
        memory: Option<(&MemoryStore, CaptureOptions<'_>)>,
        run: &crate::runs::RunLease,
    ) -> Result<ChatOutcome, ChatError> {
        let cancel = run.token();
        if cancel.is_cancelled() {
            return Err(HarnessError::Cancelled.into());
        }
        let session = run.commit(|| {
            self.sessions.append_exchange(
                &prepared.session_id,
                StoredMessage {
                    role: "user".into(),
                    content: prepared.message.clone(),
                    at: timestamp.into(),
                    attachments: (!prepared.context.manifest.is_empty())
                        .then_some(prepared.context.manifest),
                },
                StoredMessage {
                    role: "assistant".into(),
                    content: text.clone(),
                    at: timestamp.into(),
                    attachments: None,
                },
                prepared.revision,
            )
        })?;
        let memory_captured = match memory {
            Some((store, options)) => Some(
                store
                    .capture(&prepared.message, &text, options, cancel)
                    .await
                    .is_ok(),
            ),
            None => None,
        };
        Ok(ChatOutcome {
            text,
            session,
            memory_captured,
        })
    }
}
