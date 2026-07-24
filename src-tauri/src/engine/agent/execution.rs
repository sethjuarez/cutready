//! CutReady-owned execution boundary shared by host commands and agent engines.

use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};

/// Events emitted during an agent run. This is the stable frontend event shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    #[serde(rename = "delta")]
    Delta { content: String },
    #[serde(rename = "delta_reset")]
    DeltaReset,
    #[serde(rename = "thinking")]
    Thinking { content: String },
    #[serde(rename = "status")]
    Status { message: String },
    #[serde(rename = "tool_call")]
    ToolCall { name: String, arguments: String },
    #[serde(rename = "tool_result")]
    ToolResult { name: String, result: String },
    #[serde(rename = "context_prepared")]
    ContextPrepared {
        selected_count: usize,
        dropped_count: usize,
        total_bytes: usize,
        budget_bytes: usize,
    },
    #[serde(rename = "context_sent")]
    ContextSent { iteration: usize, attempt: usize },
    #[serde(rename = "agent_start")]
    AgentStart { agent_id: String, task: String },
    #[serde(rename = "agent_done")]
    AgentDone { agent_id: String },
    #[serde(rename = "done")]
    Done { response: String },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone)]
pub struct VisionConfig {
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct WebAccessConfig {
    pub search_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Parts(parts) => parts.iter().find_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                ContentPart::ImageUrl { .. } => None,
            }),
        }
    }

    pub fn char_len(&self) -> usize {
        match self {
            Self::Text(text) => text.chars().count(),
            Self::Parts(parts) => parts
                .iter()
                .map(|part| match part {
                    ContentPart::Text { text } => text.chars().count(),
                    ContentPart::ImageUrl { .. } => 200,
                })
                .sum(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<MessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn user(content: &str) -> Self {
        Self::text_message("user", content)
    }

    pub fn assistant(content: &str) -> Self {
        Self::text_message("assistant", content)
    }

    pub fn system(content: &str) -> Self {
        Self::text_message("system", content)
    }

    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self {
            role: "tool".into(),
            content: Some(MessageContent::Text(content.into())),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
        }
    }

    pub fn assistant_with_tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(tool_calls),
            tool_call_id: None,
        }
    }

    pub fn text(&self) -> Option<&str> {
        self.content.as_ref().and_then(MessageContent::text)
    }

    fn text_message(role: &str, content: &str) -> Self {
        Self {
            role: role.into(),
            content: Some(MessageContent::Text(content.into())),
            tool_calls: None,
            tool_call_id: None,
        }
    }
}

pub fn estimate_message_chars(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .map(|message| {
            let content_chars = message
                .content
                .as_ref()
                .map(MessageContent::char_len)
                .unwrap_or_default();
            let tool_chars = message
                .tool_calls
                .iter()
                .flatten()
                .map(|call| {
                    call.function.name.chars().count() + call.function.arguments.chars().count()
                })
                .sum::<usize>();
            let tool_call_id_chars = message
                .tool_call_id
                .as_ref()
                .map(|id| id.chars().count())
                .unwrap_or_default();
            content_chars + tool_chars + tool_call_id_chars + 20
        })
        .sum()
}

/// Parse model-supplied tool arguments while tolerating common JSON wrappers.
pub fn parse_tool_arguments(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }
    let stripped = strip_code_fences(trimmed);
    if let Ok(value) = serde_json::from_str(&stripped) {
        return Ok(value);
    }
    if let Some(block) = extract_json_object(&stripped) {
        if let Ok(value) = serde_json::from_str(&block) {
            return Ok(value);
        }
        if let Ok(value) = serde_json::from_str(&strip_trailing_commas(&block)) {
            return Ok(value);
        }
    }
    if let Ok(value) = serde_json::from_str(&strip_trailing_commas(&stripped)) {
        return Ok(value);
    }
    let mut end = trimmed.len().min(200);
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    Err(format!(
        "Failed to parse tool arguments: {}",
        &trimmed[..end]
    ))
}

fn strip_code_fences(value: &str) -> String {
    let mut lines = value.lines().collect::<Vec<_>>();
    if lines
        .first()
        .is_some_and(|line| line.trim().starts_with("```"))
    {
        lines.remove(0);
    }
    if lines.last().is_some_and(|line| line.trim() == "```") {
        lines.pop();
    }
    lines.join("\n")
}

fn extract_json_object(value: &str) -> Option<String> {
    let start = value.find('{')?;
    let bytes = value.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for index in start..bytes.len() {
        let character = bytes[index] as char;
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && in_string {
            escaped = true;
            continue;
        }
        if character == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(value[start..=index].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn strip_trailing_commas(value: &str) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    let mut result = String::with_capacity(value.len());
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == ',' {
            let mut next = index + 1;
            while next < characters.len() && characters[next].is_whitespace() {
                next += 1;
            }
            if next < characters.len() && matches!(characters[next], '}' | ']') {
                index += 1;
                continue;
            }
        }
        result.push(characters[index]);
        index += 1;
    }
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    pub call_type: String,
    pub function: FunctionCall,
}

fn default_tool_type() -> String {
    "function".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug)]
pub struct RunResult {
    pub messages: Vec<ChatMessage>,
    pub response: String,
    pub new_messages: Vec<ChatMessage>,
    pub total_usage: Usage,
    pub run_id: String,
    pub parent_run_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RunCancellation {
    cancelled: Arc<AtomicBool>,
}

impl RunCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_shared(cancelled: Arc<AtomicBool>) -> Self {
        Self { cancelled }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn shared_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextSource {
    User,
    System,
    ToolResult,
    File,
    Search,
    Checkpoint,
    Memory,
    Host,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    RecentTurn,
    MemoryFact,
    ReferenceDoc,
    ToolObservation,
    FileExcerpt,
    WebExcerpt,
    ErrorTrace,
    MediaSummary,
    #[default]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextScope {
    #[default]
    Session,
    Project,
    User,
    Global,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LargeContextRef {
    pub id: String,
    pub expand_tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl LargeContextRef {
    pub fn new(id: impl Into<String>, expand_tool: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            expand_tool: expand_tool.into(),
            bytes: None,
            hash: None,
        }
    }

    pub fn with_bytes(mut self, bytes: usize) -> Self {
        self.bytes = Some(bytes);
        self
    }

    pub fn with_hash(mut self, hash: impl Into<String>) -> Self {
        self.hash = Some(hash.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextItem {
    pub id: String,
    pub source: ContextSource,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub kind: ContextKind,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub scope: ContextScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_ref: Option<LargeContextRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_tokens: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_bytes: Option<usize>,
    #[serde(default)]
    pub read_count: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}

impl ContextItem {
    pub fn new(
        id: impl Into<String>,
        source: ContextSource,
        name: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            source,
            name: name.into(),
            description: description.into(),
            kind: ContextKind::Other,
            priority: 0,
            scope: ContextScope::Session,
            content: None,
            content_type: None,
            large_ref: None,
            estimated_tokens: None,
            estimated_bytes: None,
            read_count: 0,
            metadata: BTreeMap::new(),
        }
    }

    pub fn with_content(
        mut self,
        content: impl Into<String>,
        content_type: impl Into<String>,
    ) -> Self {
        self.content = Some(content.into());
        self.content_type = Some(content_type.into());
        self
    }

    pub fn with_kind(mut self, kind: ContextKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn with_priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    pub fn with_scope(mut self, scope: ContextScope) -> Self {
        self.scope = scope;
        self
    }

    pub fn with_large_ref(mut self, large_ref: LargeContextRef) -> Self {
        self.large_ref = Some(large_ref);
        self
    }

    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone)]
pub enum ToolOutput {
    Text(String),
    WithImages {
        text: String,
        images: Vec<ContentPart>,
    },
    WithMetadata {
        output: Box<ToolOutput>,
        touched_resources: Vec<TouchedResource>,
        verification_results: Vec<VerificationResult>,
        memory_promotions: Vec<MemoryPromotionCandidate>,
    },
}

impl ToolOutput {
    pub fn with_images(text: impl Into<String>, images: Vec<ContentPart>) -> Self {
        Self::WithImages {
            text: text.into(),
            images,
        }
    }

    pub fn with_metadata(
        self,
        touched_resources: Vec<TouchedResource>,
        verification_results: Vec<VerificationResult>,
        memory_promotions: Vec<MemoryPromotionCandidate>,
    ) -> Self {
        match self {
            Self::WithMetadata {
                output,
                touched_resources: mut existing_resources,
                verification_results: mut existing_verifications,
                memory_promotions: mut existing_promotions,
            } => {
                existing_resources.extend(touched_resources);
                existing_verifications.extend(verification_results);
                existing_promotions.extend(memory_promotions);
                Self::WithMetadata {
                    output,
                    touched_resources: existing_resources,
                    verification_results: existing_verifications,
                    memory_promotions: existing_promotions,
                }
            }
            output => Self::WithMetadata {
                output: Box::new(output),
                touched_resources,
                verification_results,
                memory_promotions,
            },
        }
    }

    pub fn text(&self) -> &str {
        match self {
            Self::Text(text) | Self::WithImages { text, .. } => text,
            Self::WithMetadata { output, .. } => output.text(),
        }
    }

    pub fn images(&self) -> Option<&[ContentPart]> {
        match self {
            Self::WithImages { images, .. } => Some(images),
            Self::WithMetadata { output, .. } => output.images(),
            Self::Text(_) => None,
        }
    }

    pub fn touched_resources(&self) -> &[TouchedResource] {
        match self {
            Self::WithMetadata {
                touched_resources, ..
            } => touched_resources,
            _ => &[],
        }
    }

    pub fn verification_results(&self) -> &[VerificationResult] {
        match self {
            Self::WithMetadata {
                verification_results,
                ..
            } => verification_results,
            _ => &[],
        }
    }

    pub fn memory_promotions(&self) -> &[MemoryPromotionCandidate] {
        match self {
            Self::WithMetadata {
                memory_promotions, ..
            } => memory_promotions,
            _ => &[],
        }
    }
}

impl From<String> for ToolOutput {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&str> for ToolOutput {
    fn from(value: &str) -> Self {
        Self::Text(value.into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceOperation {
    Read,
    Write,
    Create,
    Update,
    Delete,
    Execute,
    Search,
    Inspect,
    Reference,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TouchedResource {
    pub kind: String,
    pub id: String,
    pub operation: ResourceOperation,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}

impl TouchedResource {
    pub fn new(
        kind: impl Into<String>,
        id: impl Into<String>,
        operation: ResourceOperation,
    ) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
            operation,
            metadata: BTreeMap::new(),
        }
    }

    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Passed,
    Failed,
    Skipped,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerificationResult {
    pub criterion: String,
    pub status: VerificationStatus,
    pub evidence_summary: String,
}

impl VerificationResult {
    pub fn new(
        criterion: impl Into<String>,
        status: VerificationStatus,
        evidence_summary: impl Into<String>,
    ) -> Self {
        Self {
            criterion: criterion.into(),
            status,
            evidence_summary: evidence_summary.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryPromotionCandidate {
    pub content_summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence_basis_points: Option<u16>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompty_boundary_preserves_tauri_message_serialization_shape() {
        let message = ChatMessage::assistant_with_tool_calls(vec![ToolCall {
            id: "call-1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "read_sketch".into(),
                arguments: r#"{"path":"intro.sk"}"#.into(),
            },
        }]);

        assert_eq!(
            serde_json::to_value(message).unwrap(),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "read_sketch",
                        "arguments": r#"{"path":"intro.sk"}"#,
                    }
                }]
            })
        );
    }

    #[test]
    fn prompty_tool_argument_parser_recovers_fences_and_trailing_commas() {
        let parsed = parse_tool_arguments("```json\n{\"path\":\"intro.sk\",}\n```").unwrap();
        assert_eq!(parsed, json!({"path": "intro.sk"}));
    }
}
