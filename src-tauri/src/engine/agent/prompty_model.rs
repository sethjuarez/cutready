use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use prompty::engine::GeneratedModelPortAdapter;
use prompty::interfaces::{Executor, InvokerError, Processor};
use prompty::model::{context::LoadContext, Prompty};
use prompty::model::{
    InvocationContextPortability, InvocationContextState, InvocationUsage,
    ModelInvocationRequest as GeneratedModelInvocationRequest,
    ModelInvocationResponse as GeneratedModelInvocationResponse, ModelToolRequest,
};
use prompty::types::{Message, Role, StreamChunk};
#[cfg(test)]
use prompty::types::{StreamFailure, Usage};
use prompty::{
    CancellationToken, ModelInvocationRequest, ModelInvocationResponse, ModelPort,
    ModelStreamChunk, ModelStreamPort, PortError,
};
use serde_json::{json, Value};

use super::llm::{context_budget, needs_responses_api, LlmConfig, LlmProvider};
use super::tools::ToolDefinition;

pub struct ProductionPromptyModel {
    pub port: Arc<PromptyExecutorModelPort>,
    pub provider_name: String,
    pub model_name: String,
    pub context_budget_chars: usize,
}

pub fn build_production_model(
    config: &LlmConfig,
    reported_context_length: Option<usize>,
    tools: Vec<ToolDefinition>,
) -> Result<ProductionPromptyModel, String> {
    let model_name = effective_model(config).to_string();
    let responses = needs_responses_api(&model_name);
    let (provider_name, connection, executor, processor): (
        String,
        Value,
        Arc<dyn Executor>,
        Arc<dyn Processor>,
    ) = match config.provider {
        LlmProvider::Openai => (
            "openai".into(),
            json!({
                "endpoint": effective_endpoint(config),
                "apiKey": config.api_key,
            }),
            Arc::new(prompty_openai::OpenAIExecutor),
            Arc::new(prompty_openai::OpenAIProcessor),
        ),
        LlmProvider::Anthropic => (
            "anthropic".into(),
            json!({
                "endpoint": "https://api.anthropic.com",
                "apiKey": config.api_key,
            }),
            Arc::new(prompty_anthropic::AnthropicExecutor),
            Arc::new(prompty_anthropic::AnthropicProcessor),
        ),
        LlmProvider::MicrosoftFoundry if responses => {
            let token = required_bearer_token(config)?;
            (
                "openai".into(),
                json!({
                    "endpoint": foundry_openai_v1_endpoint(&config.endpoint)?,
                    "apiKey": token,
                }),
                Arc::new(prompty_openai::OpenAIExecutor),
                Arc::new(prompty_openai::OpenAIProcessor),
            )
        }
        LlmProvider::MicrosoftFoundry => {
            let token = required_bearer_token(config)?;
            (
                "foundry".into(),
                json!({
                    "kind": "foundry",
                    "endpoint": config.endpoint,
                    "apiKey": token,
                }),
                Arc::new(prompty_foundry::FoundryExecutor),
                Arc::new(prompty_foundry::FoundryProcessor),
            )
        }
        LlmProvider::AzureOpenai if responses && config.bearer_token.is_none() => {
            return Err(
                "Prompty Responses API with Azure OpenAI API-key auth is not supported; use Entra bearer authentication or a chat-completions model"
                    .into(),
            );
        }
        LlmProvider::AzureOpenai if responses => (
            "openai".into(),
            json!({
                "endpoint": azure_openai_v1_endpoint(&config.endpoint)?,
                "apiKey": required_bearer_token(config)?,
            }),
            Arc::new(prompty_openai::OpenAIExecutor),
            Arc::new(prompty_openai::OpenAIProcessor),
        ),
        LlmProvider::AzureOpenai
            if config
                .bearer_token
                .as_deref()
                .is_some_and(|token| !token.is_empty()) =>
        {
            (
                "openai".into(),
                json!({
                    "endpoint": azure_openai_v1_endpoint(&config.endpoint)?,
                    "apiKey": required_bearer_token(config)?,
                }),
                Arc::new(prompty_openai::OpenAIExecutor),
                Arc::new(prompty_openai::OpenAIProcessor),
            )
        }
        LlmProvider::AzureOpenai => (
            "foundry".into(),
            json!({
                "endpoint": config.endpoint,
                "apiKey": config.api_key,
            }),
            Arc::new(prompty_foundry::FoundryExecutor),
            Arc::new(prompty_foundry::FoundryProcessor),
        ),
    };
    let api_type = if responses { "responses" } else { "chat" };
    let tool_values = tools
        .iter()
        .map(tool_definition_to_prompty_value)
        .collect::<Result<Vec<_>, _>>()?;
    let agent = Prompty::load_from_value(
        &json!({
            "name": "CutReady",
            "model": {
                "id": model_name,
                "provider": provider_name,
                "apiType": api_type,
                "connection": connection,
                "options": { "stream": true },
            },
            "tools": tool_values,
        }),
        &LoadContext::default(),
    );
    let context_budget_chars = context_budget(&model_name, reported_context_length);
    Ok(ProductionPromptyModel {
        port: Arc::new(PromptyExecutorModelPort::new(agent, executor, processor)),
        provider_name,
        model_name,
        context_budget_chars,
    })
}

#[derive(Clone)]
pub struct PromptyExecutorModelPort {
    agent: Prompty,
    executor: Arc<dyn Executor>,
    processor: Arc<dyn Processor>,
}

fn effective_model(config: &LlmConfig) -> &str {
    if config.provider != LlmProvider::Anthropic {
        return &config.model;
    }
    match config.model.as_str() {
        "claude-sonnet-4-20250514" => "claude-sonnet-4-6",
        "claude-opus-4-20250514" => "claude-opus-4-8",
        "claude-haiku-3-5-20241022" => "claude-haiku-4-5",
        _ => &config.model,
    }
}

fn effective_endpoint(config: &LlmConfig) -> &str {
    let endpoint = config.endpoint.trim_end_matches('/');
    if endpoint.is_empty() && config.provider == LlmProvider::Openai {
        "https://api.openai.com"
    } else {
        endpoint
    }
}

fn required_bearer_token(config: &LlmConfig) -> Result<&str, String> {
    config
        .bearer_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "Prompty Foundry execution requires a refreshed Entra bearer token".into())
}

fn foundry_openai_v1_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim_end_matches('/');
    let base = endpoint
        .split_once("/api/projects")
        .map(|(base, _)| base)
        .unwrap_or(endpoint);
    let base = base.replace(".services.ai.azure.com", ".openai.azure.com");
    if base.is_empty() {
        return Err("Prompty Foundry execution requires a resource endpoint".into());
    }
    Ok(format!("{base}/openai/v1"))
}

fn azure_openai_v1_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("Prompty Azure OpenAI execution requires a resource endpoint".into());
    }
    Ok(format!("{endpoint}/openai/v1"))
}

fn tool_definition_to_prompty_value(tool: &ToolDefinition) -> Result<Value, String> {
    let required = tool
        .function
        .parameters
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<std::collections::HashSet<_>>();
    let parameters = tool
        .function
        .parameters
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, schema)| {
            property_to_prompty_value(name, schema, required.contains(name.as_str()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "kind": "function",
        "name": tool.function.name,
        "description": tool.function.description,
        "parameters": parameters,
    }))
}

fn property_to_prompty_value(name: &str, schema: &Value, required: bool) -> Result<Value, String> {
    let mut property = schema
        .as_object()
        .cloned()
        .ok_or_else(|| "Prompty tool property schema must be a JSON object".to_string())?;
    let union_key = ["oneOf", "anyOf"]
        .into_iter()
        .find(|key| property.get(*key).is_some());
    if property.get("type").is_none() {
        let key = union_key
            .ok_or_else(|| "Prompty tool property schema is missing a type".to_string())?;
        let variants = property
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| format!("Prompty tool property schema {key} must be an array"))?;
        let concrete = variants
            .iter()
            .filter(|variant| variant.get("type").and_then(Value::as_str) != Some("null"))
            .collect::<Vec<_>>();
        let nullable = concrete.len() != variants.len();
        if nullable && concrete.len() == 1 {
            let mut value = property_to_prompty_value(name, concrete[0], required)?;
            value["nullable"] = Value::Bool(true);
            if value.get("description").is_none() {
                if let Some(description) = property.get("description") {
                    value["description"] = description.clone();
                }
            }
            return Ok(value);
        }

        property.insert("kind".into(), Value::String("union".into()));
        property.insert(
            key.into(),
            Value::Array(
                variants
                    .iter()
                    .map(|variant| property_to_prompty_value("", variant, false))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        );
    }
    property.insert("name".into(), Value::String(name.into()));
    property.insert("required".into(), Value::Bool(required));
    if let Some(kind) = property.remove("type") {
        property.insert("kind".into(), kind);
    }
    if let Some(enum_values) = property.remove("enum") {
        property.insert("enumValues".into(), enum_values);
    }
    if let Some(Value::Object(properties)) = property.remove("properties") {
        let nested_required = schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<std::collections::HashSet<_>>();
        property.insert(
            "properties".into(),
            Value::Array(
                properties
                    .iter()
                    .map(|(nested_name, nested_schema)| {
                        property_to_prompty_value(
                            nested_name,
                            nested_schema,
                            nested_required.contains(nested_name.as_str()),
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        );
    }
    if let Some(items) = property.get_mut("items") {
        *items = property_to_prompty_value("", items, false)?;
    }
    Ok(Value::Object(property))
}

impl PromptyExecutorModelPort {
    pub fn new(agent: Prompty, executor: Arc<dyn Executor>, processor: Arc<dyn Processor>) -> Self {
        Self {
            agent,
            executor,
            processor,
        }
    }
}

#[async_trait]
impl ModelPort for PromptyExecutorModelPort {
    async fn invoke(
        &self,
        request: &ModelInvocationRequest,
        cancellation: &CancellationToken,
        stream: &dyn ModelStreamPort,
    ) -> Result<ModelInvocationResponse, PortError> {
        let adapter = GeneratedModelPortAdapter::new(Arc::new(self.clone()));
        ModelPort::invoke(&adapter, request, cancellation, stream).await
    }
}

#[async_trait]
impl prompty::engine::GeneratedModelPort for PromptyExecutorModelPort {
    async fn invoke(
        &self,
        request: &GeneratedModelInvocationRequest,
        cancellation: &CancellationToken,
        stream: &dyn ModelStreamPort,
    ) -> Result<GeneratedModelInvocationResponse, PortError> {
        if cancellation.is_cancelled() {
            return Err(PortError::new("Agent run cancelled"));
        }

        let raw_stream = self
            .executor
            .execute_stream_with_context(&self.agent, request, cancellation)
            .await
            .map_err(invoker_error_to_port)?;
        let completed_response = Arc::new(std::sync::Mutex::new(None));
        let observed_completion = completed_response.clone();
        let raw_stream = raw_stream.map(move |chunk| {
            if chunk.get("type").and_then(Value::as_str) == Some("response.completed") {
                if let Some(response) = chunk.get("response") {
                    if let Ok(mut completed) = observed_completion.lock() {
                        *completed = Some(response.clone());
                    }
                }
            }
            chunk
        });
        let mut processed = self
            .processor
            .process_stream(Box::pin(raw_stream))
            .map_err(invoker_error_to_port)?;

        let mut text = String::new();
        let mut tool_calls = Vec::new();
        let mut usage = None;
        loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    return Err(PortError::new("Agent run cancelled"));
                }
                chunk = processed.next() => {
                    match chunk {
                        Some(StreamChunk::Text(token)) => {
                            text.push_str(&token);
                            stream.emit(ModelStreamChunk::Text(token)).await;
                        }
                        Some(StreamChunk::Thinking(token)) => {
                            stream.emit(ModelStreamChunk::Thinking(token)).await;
                        }
                        Some(StreamChunk::Tool(tool_call)) => {
                            stream.emit(ModelStreamChunk::Provider(json!({
                                "type": "tool_call",
                                "name": tool_call.name,
                                "arguments": tool_call.arguments,
                            }))).await;
                            tool_calls.push(tool_call);
                        }
                        Some(StreamChunk::Usage(value)) => {
                            usage = Some(value);
                        }
                        Some(StreamChunk::Error(message)) => {
                            return Err(PortError::new(message));
                        }
                        Some(StreamChunk::Failure(failure)) => {
                            let message = failure.message().to_string();
                            return if failure.outcome_unknown() {
                                Err(PortError::indeterminate(message))
                            } else {
                                Err(PortError::new(message))
                            };
                        }
                        None => break,
                    }
                }
            }
        }

        let completed_response = completed_response
            .lock()
            .map_err(|error| PortError::new(format!("Stream completion tracking failed: {error}")))?
            .clone();
        if let Some(completed_response) = completed_response {
            let mut response = self
                .processor
                .process_with_context(&self.agent, completed_response.clone(), request)
                .await
                .map_err(invoker_error_to_port)?;
            if !response.tool_requests.is_empty() && response.assistant_messages.is_empty() {
                response.assistant_messages = responses_function_call_messages(&completed_response);
            }
            return Ok(response);
        }

        let mut assistant = if text.is_empty() && !tool_calls.is_empty() {
            Message {
                role: Role::Assistant,
                parts: Vec::new(),
                metadata: Value::Null,
            }
        } else {
            Message::with_text(Role::Assistant, &text)
        };
        if !tool_calls.is_empty() {
            let native_tool_calls = tool_calls
                .iter()
                .map(|tool_call| {
                    json!({
                        "id": tool_call.id,
                        "type": "function",
                        "function": {
                            "name": tool_call.name,
                            "arguments": tool_call.arguments,
                        }
                    })
                })
                .collect::<Vec<_>>();
            assistant.metadata = json!({ "tool_calls": native_tool_calls });
        }
        let tool_requests = tool_calls
            .iter()
            .map(|tool_call| ModelToolRequest {
                id: tool_call.id.clone(),
                name: tool_call.name.clone(),
                arguments: Some(
                    serde_json::from_str(&tool_call.arguments)
                        .unwrap_or_else(|_| Value::String(tool_call.arguments.clone())),
                ),
                metadata: json!({ "arguments_json": tool_call.arguments }),
            })
            .collect::<Vec<_>>();
        let output = tool_requests
            .is_empty()
            .then(|| Value::String(text.clone()));
        Ok(GeneratedModelInvocationResponse {
            output,
            assistant_messages: vec![assistant],
            tool_requests,
            next_context_state: Some(InvocationContextState {
                portability: InvocationContextPortability::Portable,
                delegated_state: Vec::new(),
            }),
            usage: usage
                .map(|usage| {
                    Ok(InvocationUsage {
                        input_tokens: i64::try_from(usage.input_tokens).map_err(|_| {
                            PortError::configuration("usage input token count exceeds Int64 range")
                        })?,
                        output_tokens: i64::try_from(usage.output_tokens).map_err(|_| {
                            PortError::configuration("usage output token count exceeds Int64 range")
                        })?,
                        total_tokens: i64::try_from(usage.total_tokens).map_err(|_| {
                            PortError::configuration("usage total token count exceeds Int64 range")
                        })?,
                    })
                })
                .transpose()?,
            metadata: Value::Null,
        })
    }
}

fn invoker_error_to_port(error: InvokerError) -> PortError {
    match error {
        InvokerError::ExecuteIndeterminate { message, metadata } => {
            PortError::indeterminate_with_metadata(message, metadata)
        }
        error => PortError::new(error.to_string()),
    }
}

fn responses_function_call_messages(response: &Value) -> Vec<Message> {
    response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(|item| {
            let id = item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            Message {
                role: Role::Assistant,
                parts: Vec::new(),
                metadata: json!({
                    "responses_function_call": item,
                    "tool_calls": [{
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        },
                    }],
                }),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    use std::task::{Context, Poll};

    use futures_util::Stream;
    use httpmock::prelude::*;
    use prompty::interfaces::InvokerError;
    use prompty::types::ToolCall;
    use prompty::{
        ContextPortability, DelegatedStateReference, ModelInvocationContextSnapshot,
        NoopModelStreamPort,
    };

    use super::*;
    use crate::engine::agent::tools::all_tools;

    struct DropObservedStream {
        chunks: std::collections::VecDeque<Value>,
        dropped: Arc<AtomicBool>,
        pending_after_chunks: bool,
    }

    impl Stream for DropObservedStream {
        type Item = Value;

        fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            if let Some(chunk) = self.chunks.pop_front() {
                Poll::Ready(Some(chunk))
            } else if self.pending_after_chunks {
                Poll::Pending
            } else {
                Poll::Ready(None)
            }
        }
    }

    impl Drop for DropObservedStream {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct ScriptedExecutor {
        chunks: Mutex<Option<Vec<Value>>>,
        dropped: Arc<AtomicBool>,
        pending_after_chunks: bool,
    }

    #[async_trait]
    impl Executor for ScriptedExecutor {
        async fn execute(
            &self,
            _agent: &Prompty,
            _messages: &[Message],
        ) -> Result<Value, InvokerError> {
            Err(InvokerError::Execute("streaming required".into()))
        }

        async fn execute_stream(
            &self,
            _agent: &Prompty,
            _messages: &[Message],
        ) -> Result<Pin<Box<dyn Stream<Item = Value> + Send>>, InvokerError> {
            Ok(Box::pin(DropObservedStream {
                chunks: self
                    .chunks
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_default()
                    .into(),
                dropped: self.dropped.clone(),
                pending_after_chunks: self.pending_after_chunks,
            }))
        }
    }

    struct ScriptedProcessor;

    #[async_trait]
    impl Processor for ScriptedProcessor {
        async fn process(&self, _agent: &Prompty, response: Value) -> Result<Value, InvokerError> {
            Ok(response)
        }

        fn process_stream(
            &self,
            inner: Pin<Box<dyn Stream<Item = Value> + Send>>,
        ) -> Result<Pin<Box<dyn Stream<Item = StreamChunk> + Send>>, InvokerError> {
            Ok(Box::pin(inner.filter_map(|chunk| async move {
                match chunk.get("kind").and_then(Value::as_str) {
                    Some("text") => Some(StreamChunk::Text(
                        chunk["value"].as_str().unwrap_or_default().to_string(),
                    )),
                    Some("thinking") => Some(StreamChunk::Thinking(
                        chunk["value"].as_str().unwrap_or_default().to_string(),
                    )),
                    Some("tool") => Some(StreamChunk::Tool(ToolCall {
                        id: chunk["id"].as_str().unwrap_or_default().to_string(),
                        name: chunk["name"].as_str().unwrap_or_default().to_string(),
                        arguments: chunk["arguments"].as_str().unwrap_or_default().to_string(),
                    })),
                    Some("usage") => Some(StreamChunk::Usage(Usage {
                        input_tokens: chunk["input_tokens"].as_u64().unwrap_or_default(),
                        output_tokens: chunk["output_tokens"].as_u64().unwrap_or_default(),
                        total_tokens: chunk["total_tokens"].as_u64().unwrap_or_default(),
                    })),
                    Some("failure") => Some(StreamChunk::Failure(
                        if chunk["outcome_unknown"].as_bool().unwrap_or(false) {
                            StreamFailure::Indeterminate(
                                chunk["message"].as_str().unwrap_or_default().to_string(),
                            )
                        } else {
                            StreamFailure::Determinate(
                                chunk["message"].as_str().unwrap_or_default().to_string(),
                            )
                        },
                    )),
                    _ => None,
                }
            })))
        }
    }

    #[derive(Default)]
    struct RecordingStreamPort {
        chunks: Mutex<Vec<ModelStreamChunk>>,
    }

    #[async_trait]
    impl ModelStreamPort for RecordingStreamPort {
        async fn emit(&self, chunk: ModelStreamChunk) {
            self.chunks.lock().unwrap().push(chunk);
        }
    }

    fn request() -> ModelInvocationRequest {
        ModelInvocationRequest {
            context: ModelInvocationContextSnapshot {
                id: "context-1".into(),
                session_id: "session-1".into(),
                turn_id: "turn-1".into(),
                invocation_id: "invocation-1".into(),
                iteration: 0,
                messages: vec![Message::with_text(Role::User, "Inspect the project.")],
                decisions: Vec::new(),
                stable_prefix_messages: 0,
                context_state: InvocationContextState {
                    portability: ContextPortability::Portable,
                    delegated_state: Vec::new(),
                },
                metadata: Value::Null,
            },
        }
    }

    fn responses_sse(id: &str, text: &str) -> String {
        format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({
                "type": "response.output_text.delta",
                "delta": text,
            }),
            json!({
                "type": "response.completed",
                "response": {
                    "object": "response",
                    "id": id,
                    "output": [],
                    "output_text": text,
                    "usage": {
                        "input_tokens": 3,
                        "output_tokens": 2,
                        "total_tokens": 5,
                    },
                },
            }),
        )
    }

    fn responses_tool_sse(id: &str) -> String {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({
                "type": "response.completed",
                "response": {
                    "object": "response",
                    "id": id,
                    "output": [{
                        "type": "function_call",
                        "call_id": "call-list",
                        "name": "list_project_files",
                        "arguments": "{}",
                    }],
                    "output_text": "",
                    "usage": {
                        "input_tokens": 3,
                        "output_tokens": 2,
                        "total_tokens": 5,
                    },
                },
            }),
        )
    }

    fn responses_continuation_request(prefix_changed: bool) -> ModelInvocationRequest {
        let boundary_prefix = vec![
            Message::with_text(Role::System, "Stable instructions"),
            Message::with_text(Role::User, "Inspect the project"),
        ];
        let mut messages = boundary_prefix.clone();
        if prefix_changed {
            messages[0] = Message::with_text(Role::System, "Changed instructions");
        }
        let mut function_call = Message::with_text(Role::Assistant, "");
        function_call.metadata = json!({
            "responses_function_call": {
                "type": "function_call",
                "call_id": "call-list",
                "name": "list_project_files",
                "arguments": "{}",
            },
        });
        messages.push(function_call);
        messages.push(Message::tool_result("call-list", "planning-notes.md"));
        ModelInvocationRequest {
            context: ModelInvocationContextSnapshot {
                id: "context-continuation".into(),
                session_id: "session-continuation".into(),
                turn_id: "turn-continuation".into(),
                invocation_id: "invocation-continuation".into(),
                iteration: 1,
                messages,
                decisions: Vec::new(),
                stable_prefix_messages: 2,
                context_state: InvocationContextState {
                    portability: ContextPortability::Delegated,
                    delegated_state: vec![DelegatedStateReference {
                        provider: "openai".into(),
                        kind: "response".into(),
                        id: "resp-prior".into(),
                        metadata: json!({
                            "prompty.openai.responses.boundary": {
                                "inputMessages": boundary_prefix,
                            },
                        }),
                    }],
                },
                metadata: Value::Null,
            },
        }
    }

    #[tokio::test]
    async fn streams_text_and_preserves_tool_identity_and_arguments_without_agentive() {
        let dropped = Arc::new(AtomicBool::new(false));
        let port = PromptyExecutorModelPort::new(
            Prompty::default(),
            Arc::new(ScriptedExecutor {
                chunks: Mutex::new(Some(vec![
                    json!({"kind": "text", "value": "Inspecting "}),
                    json!({"kind": "text", "value": "now."}),
                    json!({
                        "kind": "tool",
                        "id": "call-list",
                        "name": "list_project_files",
                        "arguments": "{\"include_images\":false}"
                    }),
                ])),
                dropped: dropped.clone(),
                pending_after_chunks: false,
            }),
            Arc::new(ScriptedProcessor),
        );
        let stream = RecordingStreamPort::default();

        let response = port
            .invoke(&request(), &CancellationToken::new(), &stream)
            .await
            .unwrap();

        assert!(dropped.load(Ordering::SeqCst));
        let chunks = stream.chunks.lock().unwrap();
        assert!(matches!(
            chunks.as_slice(),
            [
                ModelStreamChunk::Text(first),
                ModelStreamChunk::Text(second),
                ModelStreamChunk::Provider(_)
            ] if first == "Inspecting " && second == "now."
        ));
        assert_eq!(
            response.assistant_messages[0].text_content(),
            "Inspecting now."
        );
        assert_eq!(response.tool_requests.len(), 1);
        assert_eq!(response.tool_requests[0].id, "call-list");
        assert_eq!(response.tool_requests[0].name, "list_project_files");
        assert_eq!(
            response.tool_requests[0].metadata["arguments_json"],
            "{\"include_images\":false}"
        );
        let native_calls =
            serde_json::from_value::<Vec<crate::engine::agent::execution::ToolCall>>(
                response.assistant_messages[0].metadata["tool_calls"].clone(),
            )
            .unwrap();
        assert_eq!(native_calls[0].id, "call-list");
        assert_eq!(native_calls[0].function.name, "list_project_files");
        assert_eq!(
            native_calls[0].function.arguments,
            "{\"include_images\":false}"
        );
        assert_eq!(response.metadata, Value::Null);
    }

    #[tokio::test]
    async fn tool_only_assistant_message_has_null_native_content_shape() {
        let port = PromptyExecutorModelPort::new(
            Prompty::default(),
            Arc::new(ScriptedExecutor {
                chunks: Mutex::new(Some(vec![json!({
                    "kind": "tool",
                    "id": "call-list",
                    "name": "list_project_files",
                    "arguments": "{}"
                })])),
                dropped: Arc::new(AtomicBool::new(false)),
                pending_after_chunks: false,
            }),
            Arc::new(ScriptedProcessor),
        );

        let response = port
            .invoke(&request(), &CancellationToken::new(), &NoopModelStreamPort)
            .await
            .unwrap();
        assert!(response.assistant_messages[0].parts.is_empty());
    }

    #[tokio::test]
    async fn projects_terminal_usage_metadata() {
        let port = PromptyExecutorModelPort::new(
            Prompty::default(),
            Arc::new(ScriptedExecutor {
                chunks: Mutex::new(Some(vec![json!({
                    "kind": "usage",
                    "input_tokens": 11,
                    "output_tokens": 4,
                    "total_tokens": 15
                })])),
                dropped: Arc::new(AtomicBool::new(false)),
                pending_after_chunks: false,
            }),
            Arc::new(ScriptedProcessor),
        );

        let response = port
            .invoke(&request(), &CancellationToken::new(), &NoopModelStreamPort)
            .await
            .unwrap();

        assert_eq!(
            response
                .usage
                .as_ref()
                .expect("typed terminal usage should be present")
                .total_tokens,
            15
        );
        assert_eq!(response.metadata, Value::Null);
    }

    #[tokio::test]
    async fn prompty_stream_preserves_token_thinking_order_and_typed_usage() {
        let port = PromptyExecutorModelPort::new(
            Prompty::default(),
            Arc::new(ScriptedExecutor {
                chunks: Mutex::new(Some(vec![
                    json!({"kind": "text", "value": "first"}),
                    json!({"kind": "thinking", "value": "reasoning"}),
                    json!({"kind": "text", "value": "second"}),
                    json!({
                        "kind": "usage",
                        "input_tokens": 8,
                        "output_tokens": 3,
                        "total_tokens": 11,
                    }),
                ])),
                dropped: Arc::new(AtomicBool::new(false)),
                pending_after_chunks: false,
            }),
            Arc::new(ScriptedProcessor),
        );
        let stream = RecordingStreamPort::default();

        let response = port
            .invoke(&request(), &CancellationToken::new(), &stream)
            .await
            .unwrap();

        assert_eq!(
            stream.chunks.lock().unwrap().as_slice(),
            &[
                ModelStreamChunk::Text("first".into()),
                ModelStreamChunk::Thinking("reasoning".into()),
                ModelStreamChunk::Text("second".into()),
            ]
        );
        assert_eq!(response.output, Some(Value::String("firstsecond".into())));
        assert_eq!(response.usage.unwrap().total_tokens, 11);
    }

    #[tokio::test]
    async fn prompty_cancellation_before_provider_invocation_opens_no_stream() {
        let dropped = Arc::new(AtomicBool::new(false));
        let port = PromptyExecutorModelPort::new(
            Prompty::default(),
            Arc::new(ScriptedExecutor {
                chunks: Mutex::new(Some(vec![json!({"kind": "text", "value": "unused"})])),
                dropped: dropped.clone(),
                pending_after_chunks: false,
            }),
            Arc::new(ScriptedProcessor),
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = port
            .invoke(&request(), &cancellation, &NoopModelStreamPort)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert!(!dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn prompty_openai_responses_continuation_sends_only_verified_delta() {
        let server = MockServer::start();
        let expected = json!({
            "model": "gpt-5.1-codex",
            "input": [{
                "type": "function_call_output",
                "call_id": "call-list",
                "output": "planning-notes.md",
            }],
            "previous_response_id": "resp-prior",
            "stream": true,
        });
        let provider = server.mock(|when, then| {
            when.method(POST).path("/v1/responses").json_body(expected);
            then.status(200)
                .header("content-type", "text/event-stream")
                .body(responses_sse("resp-next", "continued"));
        });
        let production = build_production_model(
            &LlmConfig {
                provider: LlmProvider::Openai,
                endpoint: server.url(""),
                api_key: "test-key".into(),
                model: "gpt-5.1-codex".into(),
                bearer_token: None,
            },
            None,
            Vec::new(),
        )
        .unwrap();

        let response = production
            .port
            .invoke(
                &responses_continuation_request(false),
                &CancellationToken::new(),
                &NoopModelStreamPort,
            )
            .await
            .unwrap();

        provider.assert();
        assert_eq!(response.output, Some(Value::String("continued".into())));
        assert_eq!(
            response.next_portability,
            Some(ContextPortability::Delegated)
        );
        assert_eq!(response.delegated_state.unwrap()[0].id, "resp-next");
    }

    #[tokio::test]
    async fn prompty_openai_responses_tool_call_keeps_portable_replay_pairing() {
        let server = MockServer::start();
        let provider = server.mock(|when, then| {
            when.method(POST).path("/v1/responses").json_body(json!({
                "model": "gpt-5.1-codex",
                "input": [{"role": "user", "content": "Inspect the project"}],
                "stream": true,
            }));
            then.status(200)
                .header("content-type", "text/event-stream")
                .body(responses_tool_sse("resp-tool"));
        });
        let production = build_production_model(
            &LlmConfig {
                provider: LlmProvider::Openai,
                endpoint: server.url(""),
                api_key: "test-key".into(),
                model: "gpt-5.1-codex".into(),
                bearer_token: None,
            },
            None,
            Vec::new(),
        )
        .unwrap();
        let mut initial = request();
        initial.context.messages = vec![Message::with_text(Role::User, "Inspect the project")];

        let response = production
            .port
            .invoke(&initial, &CancellationToken::new(), &NoopModelStreamPort)
            .await
            .unwrap();

        provider.assert();
        assert_eq!(
            response.next_portability,
            Some(ContextPortability::Delegated)
        );
        assert_eq!(
            response.delegated_state.as_ref().unwrap()[0].id,
            "resp-tool"
        );
        assert_eq!(response.tool_requests[0].id, "call-list");
        assert_eq!(
            response.assistant_messages[0].metadata["responses_function_call"]["call_id"],
            "call-list"
        );
        assert_eq!(
            response.assistant_messages[0].metadata["tool_calls"][0]["id"],
            "call-list"
        );
    }

    #[tokio::test]
    async fn prompty_openai_responses_prefix_change_replays_complete_portable_exchange() {
        let server = MockServer::start();
        let expected = json!({
            "model": "gpt-5.1-codex",
            "instructions": "Changed instructions",
            "input": [
                {"role": "user", "content": "Inspect the project"},
                {
                    "type": "function_call",
                    "call_id": "call-list",
                    "name": "list_project_files",
                    "arguments": "{}",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-list",
                    "output": "planning-notes.md",
                },
            ],
            "stream": true,
        });
        let provider = server.mock(|when, then| {
            when.method(POST).path("/v1/responses").json_body(expected);
            then.status(200)
                .header("content-type", "text/event-stream")
                .body(responses_sse("resp-replayed", "portable"));
        });
        let production = build_production_model(
            &LlmConfig {
                provider: LlmProvider::Openai,
                endpoint: server.url(""),
                api_key: "test-key".into(),
                model: "gpt-5.1-codex".into(),
                bearer_token: None,
            },
            None,
            Vec::new(),
        )
        .unwrap();

        let response = production
            .port
            .invoke(
                &responses_continuation_request(true),
                &CancellationToken::new(),
                &NoopModelStreamPort,
            )
            .await
            .unwrap();

        provider.assert();
        assert_eq!(response.output, Some(Value::String("portable".into())));
    }

    #[tokio::test]
    async fn cancellation_terminates_consumption_and_drops_underlying_stream() {
        let dropped = Arc::new(AtomicBool::new(false));
        let port = Arc::new(PromptyExecutorModelPort::new(
            Prompty::default(),
            Arc::new(ScriptedExecutor {
                chunks: Mutex::new(Some(Vec::new())),
                dropped: dropped.clone(),
                pending_after_chunks: true,
            }),
            Arc::new(ScriptedProcessor),
        ));
        let cancellation = CancellationToken::new();
        let cancellation_for_task = cancellation.clone();
        let task = tokio::spawn(async move {
            port.invoke(&request(), &cancellation_for_task, &NoopModelStreamPort)
                .await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();

        let error = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("model port should stop consuming after cancellation")
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn classified_stream_failure_preserves_reconciliation_semantics() {
        for (outcome_unknown, expected_unknown) in [(false, false), (true, true)] {
            let port = PromptyExecutorModelPort::new(
                Prompty::default(),
                Arc::new(ScriptedExecutor {
                    chunks: Mutex::new(Some(vec![json!({
                        "kind": "failure",
                        "message": "stream ended after dispatch",
                        "outcome_unknown": outcome_unknown,
                    })])),
                    dropped: Arc::new(AtomicBool::new(false)),
                    pending_after_chunks: false,
                }),
                Arc::new(ScriptedProcessor),
            );

            let error = port
                .invoke(&request(), &CancellationToken::new(), &NoopModelStreamPort)
                .await
                .unwrap_err();

            assert_eq!(error.outcome_unknown, expected_unknown);
            assert_eq!(error.message, "stream ended after dispatch");
        }
    }

    #[test]
    fn converts_cutready_json_schema_to_prompty_function_properties() {
        let tool = ToolDefinition::function(
            "inspect",
            "Inspect a nested target.",
            json!({
                "type": "object",
                "properties": {
                    "target": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "enum": ["sketch", "storyboard"]
                            },
                            "paths": {
                                "type": "array",
                                "items": { "type": "string" }
                            }
                        },
                        "required": ["kind"]
                    }
                },
                "required": ["target"]
            }),
        );

        let value = tool_definition_to_prompty_value(&tool).unwrap();

        assert_eq!(value["kind"], "function");
        assert_eq!(value["parameters"][0]["name"], "target");
        assert_eq!(value["parameters"][0]["kind"], "object");
        assert_eq!(value["parameters"][0]["required"], true);
        assert_eq!(
            value["parameters"][0]["properties"][0]["enumValues"],
            json!(["sketch", "storyboard"])
        );
        assert_eq!(
            value["parameters"][0]["properties"][1]["items"]["kind"],
            "string"
        );
    }

    #[test]
    fn production_tool_wire_preserves_cutready_nullable_union_schemas() {
        let config = LlmConfig {
            provider: LlmProvider::Openai,
            endpoint: String::new(),
            api_key: "test-key".into(),
            model: "gpt-4o".into(),
            bearer_token: None,
        };
        let production =
            build_production_model(&config, Some(10_000), all_tools(true, true, true)).unwrap();
        let tools = prompty_openai::tools_to_wire(&production.port.agent).unwrap();

        let set_row_visual = tools
            .iter()
            .find(|tool| tool["function"]["name"] == "set_row_visual")
            .unwrap();
        assert_eq!(
            set_row_visual["function"]["parameters"]["properties"]["visual"]["type"],
            json!(["object", "null"])
        );

        let write_storyboard = tools
            .iter()
            .find(|tool| tool["function"]["name"] == "write_storyboard")
            .unwrap();
        let storyboard_items =
            &write_storyboard["function"]["parameters"]["properties"]["items"]["items"];
        assert_eq!(storyboard_items["anyOf"][0]["type"], "object");
        assert_eq!(storyboard_items["anyOf"][1]["type"], "object");
        assert_eq!(
            storyboard_items["anyOf"][1]["required"],
            json!(["sketches", "title", "type"])
        );
    }

    #[test]
    fn production_factory_selects_openai_responses_without_agentive_transport() {
        let config = LlmConfig {
            provider: LlmProvider::Openai,
            endpoint: String::new(),
            api_key: "test-key".into(),
            model: "gpt-5.1-codex".into(),
            bearer_token: None,
        };

        let production = build_production_model(&config, Some(10_000), Vec::new()).unwrap();

        assert_eq!(production.provider_name, "openai");
        assert_eq!(production.model_name, "gpt-5.1-codex");
        assert_eq!(production.context_budget_chars, 30_000);
        assert_eq!(
            production.port.agent.model.provider.as_deref(),
            Some("openai")
        );
        assert_eq!(production.port.agent.model.id, "gpt-5.1-codex");
    }

    #[test]
    fn prompty_production_dependencies_remain_pinned_to_a_single_revision() {
        const REVISION: &str = "4e0e54a2ba3fcea316f5bfc2132f9610ba858558";
        let manifest = include_str!("../../../Cargo.toml");
        let lockfile = include_str!("../../../Cargo.lock");

        assert_eq!(
            manifest.matches(&format!("rev = \"{REVISION}\"")).count(),
            4,
            "all production Prompty crates must use the audited revision"
        );
        assert!(lockfile.contains(REVISION));
    }

    #[test]
    fn production_factory_requires_host_injected_foundry_token() {
        let config = LlmConfig {
            provider: LlmProvider::MicrosoftFoundry,
            endpoint: "https://example.services.ai.azure.com/api/projects/demo".into(),
            api_key: String::new(),
            model: "gpt-4o".into(),
            bearer_token: None,
        };

        let error = build_production_model(&config, None, Vec::new())
            .err()
            .expect("Foundry must not silently fall back without a host token");

        assert!(error.contains("refreshed Entra bearer token"));
    }

    #[test]
    fn azure_chat_completions_routes_bearer_auth_to_openai_v1_transport() {
        let config = LlmConfig {
            provider: LlmProvider::AzureOpenai,
            endpoint: "https://example.openai.azure.com".into(),
            api_key: "legacy-key".into(),
            model: "gpt-4o".into(),
            bearer_token: Some("entra-token".into()),
        };

        let production = build_production_model(&config, None, Vec::new()).unwrap();
        assert_eq!(production.provider_name, "openai");
    }
}
