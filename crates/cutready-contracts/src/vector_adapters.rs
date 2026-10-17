// Binds the SketchDocument and StoryboardDocument @vector operations
// (contracts/edits.tsp, contracts/storyboard.tsp) to the desktop's production
// document code: serde for decode/save and engine::sketch_edits for edits. Included by the generated conformance suite
// via #[path].
#![allow(dead_code, unused_variables, clippy::all)]

use cutready_lib::document::{self, RowTextUpdate, Sketch, SketchEditError, Storyboard};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

#[derive(Clone)]
pub struct Context {
    pub contract: String,
    pub operation: String,
    pub vector: Value,
    pub provider: Option<String>,
    pub target_api: Option<String>,
    pub doubles: Value,
    pub base_dir: String,
}

pub struct VectorError {
    pub message: String,
    pub payload: Option<Value>,
}

impl VectorError {
    fn harness(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            payload: None,
        }
    }
}

impl From<SketchEditError> for VectorError {
    fn from(err: SketchEditError) -> Self {
        let mut payload = json!({ "code": err.code() });
        match &err {
            SketchEditError::LockedRow { row_index }
            | SketchEditError::RowNotFound { row_index } => {
                payload["row_index"] = json!(row_index);
            }
            SketchEditError::LockedCell { row_index, field } => {
                payload["row_index"] = json!(row_index);
                payload["field"] = json!(field);
            }
            _ => {}
        }
        Self {
            message: err.to_string(),
            payload: Some(payload),
        }
    }
}

pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, VectorError>>>>;

pub enum Invoke {
    Sync(fn(&Value, &Context) -> Result<Value, VectorError>),
    Async(Box<dyn Fn(&Value, &Context) -> BoxFuture>),
}

pub struct Adapter {
    pub invoke: Invoke,
    pub normalize: Option<fn(&Value, &Context) -> Value>,
}

impl Adapter {
    pub fn sync(invoke: fn(&Value, &Context) -> Result<Value, VectorError>) -> Self {
        Self {
            invoke: Invoke::Sync(invoke),
            normalize: None,
        }
    }
}

fn decode(input: &Value) -> Result<Sketch, VectorError> {
    serde_json::from_value(input.get("sketch").cloned().unwrap_or(Value::Null))
        .map_err(|e| VectorError::harness(format!("decode sketch: {e}")))
}

// Same serializer as project::write_sketch. Re-parse the text (not
// serde_json::to_value) so f32 fields compare in their shortest decimal form.
fn save(sketch: &Sketch) -> Result<Value, VectorError> {
    let text = serde_json::to_string_pretty(sketch)
        .map_err(|e| VectorError::harness(format!("save sketch: {e}")))?;
    serde_json::from_str(&text).map_err(|e| VectorError::harness(format!("reparse sketch: {e}")))
}

fn now(input: &Value) -> Result<chrono::DateTime<chrono::Utc>, VectorError> {
    let raw = input.get("now").and_then(Value::as_str).unwrap_or_default();
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&chrono::Utc))
        .map_err(|e| VectorError::harness(format!("parse now: {e}")))
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(String::from)
}

// Indices are non-negative by contract; anything else is a malformed vector.
fn index(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|i| usize::try_from(i).ok())
}

fn round_trip(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    save(&decode(input)?)
}

fn update_row_text(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let mut sketch = decode(input)?;
    let update = input.get("update").cloned().unwrap_or(Value::Null);
    let update = RowTextUpdate {
        row_index: index(update.get("row_index"))
            .ok_or_else(|| VectorError::harness("update.row_index must be a row index"))?,
        time: text(&update, "time"),
        narrative: text(&update, "narrative"),
        demo_actions: text(&update, "demo_actions"),
    };
    document::update_row_text(&mut sketch, &update, now(input)?)?;
    save(&sketch)
}

fn reorder_rows(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let mut sketch = decode(input)?;
    let order = input
        .get("order")
        .and_then(Value::as_array)
        .ok_or_else(|| VectorError::harness("order is required"))?
        .iter()
        .map(|v| index(Some(v)))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| VectorError::harness("order must hold row indices"))?;
    document::reorder_rows(&mut sketch, &order, now(input)?)?;
    save(&sketch)
}

// Same serializer as project::write_storyboard.
fn storyboard_round_trip(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let storyboard: Storyboard =
        serde_json::from_value(input.get("storyboard").cloned().unwrap_or(Value::Null))
            .map_err(|e| VectorError::harness(format!("decode storyboard: {e}")))?;
    let text = serde_json::to_string_pretty(&storyboard)
        .map_err(|e| VectorError::harness(format!("save storyboard: {e}")))?;
    serde_json::from_str(&text)
        .map_err(|e| VectorError::harness(format!("reparse storyboard: {e}")))
}

// Same path as project::read_storyboard: upgrade raw JSON, decode, save canonically.
fn storyboard_upgrade(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let raw = input.get("storyboard").cloned().unwrap_or(Value::Null);
    let (storyboard, _) = Storyboard::from_json_upgraded(&raw.to_string())
        .map_err(|e| VectorError::harness(format!("upgrade storyboard: {e}")))?;
    let text = serde_json::to_string_pretty(&storyboard)
        .map_err(|e| VectorError::harness(format!("save storyboard: {e}")))?;
    serde_json::from_str(&text)
        .map_err(|e| VectorError::harness(format!("reparse storyboard: {e}")))
}
fn parse_duration_seconds(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let time = text(input, "time").ok_or_else(|| VectorError::harness("time is required"))?;
    Ok(document::parse_duration_seconds(&time).map_or(Value::Null, |seconds| json!(seconds)))
}

fn compact_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn clean_participant(value: Option<&Value>) -> Value {
    let mut out = Map::new();
    let source = value.and_then(Value::as_object);
    out.insert(
        "name".to_string(),
        Value::String(
            source
                .and_then(|source| source.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    if let Some(email) = optional_string(source.and_then(|source| source.get("email"))) {
        out.insert("email".to_string(), Value::String(email));
    }
    Value::Object(out)
}

fn clean_source(value: Option<&Value>) -> Value {
    let mut out = Map::new();
    let source = value.and_then(Value::as_object);
    out.insert(
        "session_id".to_string(),
        Value::String(
            source
                .and_then(|source| source.get("session_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    if let Some(started_at) = optional_string(source.and_then(|source| source.get("started_at"))) {
        out.insert("started_at".to_string(), Value::String(started_at));
    }
    Value::Object(out)
}

fn clean_tool_use(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let name = compact_string(source.get("name"))?;
    let mut out = Map::new();
    out.insert("name".to_string(), Value::String(name));
    if let Some(target) = compact_string(source.get("target")) {
        out.insert("target".to_string(), Value::String(target));
    }
    Some(Value::Object(out))
}

fn clean_turn(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let mut out = Map::new();
    let role = match source.get("role").and_then(Value::as_str) {
        Some("assistant") => "assistant",
        _ => "user",
    };
    out.insert("role".to_string(), Value::String(role.to_string()));
    out.insert(
        "text".to_string(),
        Value::String(
            source
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    let tools: Vec<Value> = source
        .get("tool_uses")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(clean_tool_use).collect())
        .unwrap_or_default();
    if !tools.is_empty() {
        out.insert("tool_uses".to_string(), Value::Array(tools));
    }
    if let Some(agent) = optional_string(source.get("agent")) {
        out.insert("agent".to_string(), Value::String(agent));
    }
    if let Some(model) = optional_string(source.get("model")) {
        out.insert("model".to_string(), Value::String(model));
    }
    for (key, extra) in source {
        if !matches!(
            key.as_str(),
            "role" | "text" | "tool_uses" | "agent" | "model"
        ) {
            out.insert(key.clone(), extra.clone());
        }
    }
    Some(Value::Object(out))
}

fn chat_round_trip(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    Ok(clean_chat_artifact(
        input.get("artifact").unwrap_or(&Value::Null),
    ))
}

fn clean_chat_artifact(value: &Value) -> Value {
    let source = value.as_object();
    let mut out = Map::new();
    out.insert(
        "title".to_string(),
        Value::String(
            source
                .and_then(|source| source.get("title"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    out.insert(
        "author".to_string(),
        clean_participant(source.and_then(|source| source.get("author"))),
    );
    out.insert(
        "promoted_by".to_string(),
        clean_participant(source.and_then(|source| source.get("promoted_by"))),
    );
    out.insert(
        "promoted_at".to_string(),
        Value::String(
            source
                .and_then(|source| source.get("promoted_at"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    out.insert(
        "source".to_string(),
        clean_source(source.and_then(|source| source.get("source"))),
    );
    let turns: Vec<Value> = source
        .and_then(|source| source.get("turns"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(clean_turn).collect())
        .unwrap_or_default();
    out.insert("turns".to_string(), Value::Array(turns));
    out.insert(
        "updated_at".to_string(),
        Value::String(
            source
                .and_then(|source| source.get("updated_at"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    if let Some(summary) = compact_string(source.and_then(|source| source.get("summary"))) {
        out.insert("summary".to_string(), Value::String(summary));
    }
    if let Some(source) = source {
        for (key, extra) in source {
            if !matches!(
                key.as_str(),
                "title"
                    | "summary"
                    | "author"
                    | "promoted_by"
                    | "promoted_at"
                    | "source"
                    | "turns"
                    | "updated_at"
            ) {
                out.insert(key.clone(), extra.clone());
            }
        }
    }
    Value::Object(out)
}

fn message_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(text)) => compact_string(Some(&Value::String(text.clone()))),
        Some(Value::Array(parts)) => {
            let text_parts: Vec<String> = parts
                .iter()
                .filter_map(|part| {
                    let part = part.as_object()?;
                    if part.get("type").and_then(Value::as_str) != Some("text") {
                        return None;
                    }
                    compact_string(part.get("text"))
                })
                .collect();
            if text_parts.is_empty() {
                None
            } else {
                Some(text_parts.join("\n"))
            }
        }
        _ => None,
    }
}

fn tool_target(raw_arguments: Option<&Value>) -> Option<String> {
    let raw = raw_arguments.and_then(Value::as_str)?;
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let parsed = parsed.as_object()?;
    compact_string(parsed.get("path")).or_else(|| compact_string(parsed.get("url")))
}

fn message_tool_uses(message: &Map<String, Value>) -> Vec<Value> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| {
                    let function = call.as_object()?.get("function")?.as_object()?;
                    let name = compact_string(function.get("name"))?;
                    let mut out = Map::new();
                    out.insert("name".to_string(), Value::String(name));
                    if let Some(target) = tool_target(function.get("arguments")) {
                        out.insert("target".to_string(), Value::String(target));
                    }
                    Some(Value::Object(out))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn run_details(message: &Map<String, Value>) -> Option<&Map<String, Value>> {
    message
        .get("cutready")?
        .as_object()?
        .get("runDetails")?
        .as_object()
}

fn push_assistant(
    turns: &mut Vec<Value>,
    text: Option<String>,
    tools: Vec<Value>,
    details: Option<&Map<String, Value>>,
) {
    if let Some(Value::Object(previous)) = turns.last_mut() {
        if previous.get("role").and_then(Value::as_str) == Some("assistant") {
            if let Some(text) = text {
                let joined = previous
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|existing| !existing.is_empty())
                    .map(|existing| format!("{existing}\n\n{text}"))
                    .unwrap_or(text);
                previous.insert("text".to_string(), Value::String(joined));
            }
            if !tools.is_empty() {
                let mut merged = previous
                    .get("tool_uses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                merged.extend(tools);
                previous.insert("tool_uses".to_string(), Value::Array(merged));
            }
            if let Some(details) = details {
                if let Some(agent) = compact_string(details.get("agent_id")) {
                    previous.insert("agent".to_string(), Value::String(agent));
                }
                if let Some(model) = compact_string(details.get("model")) {
                    previous.insert("model".to_string(), Value::String(model));
                }
            }
            return;
        }
    }
    if text.is_none() && tools.is_empty() {
        return;
    }
    let mut turn = Map::new();
    turn.insert("role".to_string(), Value::String("assistant".to_string()));
    turn.insert(
        "text".to_string(),
        Value::String(text.unwrap_or_default()),
    );
    if !tools.is_empty() {
        turn.insert("tool_uses".to_string(), Value::Array(tools));
    }
    if let Some(details) = details {
        if let Some(agent) = compact_string(details.get("agent_id")) {
            turn.insert("agent".to_string(), Value::String(agent));
        }
        if let Some(model) = compact_string(details.get("model")) {
            turn.insert("model".to_string(), Value::String(model));
        }
    }
    turns.push(Value::Object(turn));
}

fn curated_turns(session: &Map<String, Value>) -> Vec<Value> {
    let mut turns = Vec::new();
    let messages = session
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for raw in messages {
        let Some(message) = raw.as_object() else {
            continue;
        };
        if message.get("pending").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                if let Some(text) = message_text(message.get("content")) {
                    turns.push(json!({ "role": "user", "text": text }));
                }
            }
            Some("assistant") => push_assistant(
                &mut turns,
                message_text(message.get("content")),
                message_tool_uses(message),
                run_details(message),
            ),
            _ => {}
        }
    }
    turns
}

fn apply_selection(turns: Vec<Value>, selected: Option<&Value>) -> Vec<Value> {
    let Some(selected) = selected.and_then(Value::as_array) else {
        return turns;
    };
    let keep: std::collections::HashSet<usize> = selected
        .iter()
        .filter_map(Value::as_u64)
        .filter_map(|index| usize::try_from(index).ok())
        .filter(|index| *index < turns.len())
        .collect();
    turns
        .into_iter()
        .enumerate()
        .filter_map(|(index, turn)| keep.contains(&index).then_some(turn))
        .collect()
}

fn chat_promote(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let session = input
        .get("session")
        .and_then(Value::as_object)
        .ok_or_else(|| VectorError::harness("session is required"))?;
    let request = input
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| VectorError::harness("request is required"))?;
    let mut source = Map::new();
    source.insert(
        "session_id".to_string(),
        Value::String(
            session
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    if let Some(started_at) = optional_string(session.get("created_at")) {
        source.insert("started_at".to_string(), Value::String(started_at));
    }
    Ok(clean_chat_artifact(&json!({
        "title": compact_string(request.get("title")).unwrap_or_default(),
        "summary": request.get("summary").cloned().unwrap_or(Value::Null),
        "author": request.get("author").cloned().unwrap_or(Value::Null),
        "promoted_by": request.get("promoted_by").cloned().unwrap_or(Value::Null),
        "promoted_at": request.get("promoted_at").and_then(Value::as_str).unwrap_or_default(),
        "source": Value::Object(source),
        "turns": apply_selection(curated_turns(session), request.get("selected_turns")),
        "updated_at": request.get("promoted_at").and_then(Value::as_str).unwrap_or_default(),
    })))
}

pub fn doubles() -> Value {
    json!({})
}

pub fn waivers() -> HashMap<&'static str, &'static str> {
    HashMap::new()
}

pub fn adapters() -> HashMap<&'static str, Adapter> {
    HashMap::from([
        (
            "ChatArtifactDocument.promote",
            Adapter::sync(chat_promote),
        ),
        (
            "ChatArtifactDocument.roundTrip",
            Adapter::sync(chat_round_trip),
        ),
        ("SketchDocument.roundTrip", Adapter::sync(round_trip)),
        (
            "SketchDocument.updateRowText",
            Adapter::sync(update_row_text),
        ),
        ("SketchDocument.reorderRows", Adapter::sync(reorder_rows)),
        (
            "PlanningTiming.parseDurationSeconds",
            Adapter::sync(parse_duration_seconds),
        ),
        (
            "StoryboardDocument.roundTrip",
            Adapter::sync(storyboard_round_trip),
        ),
        (
            "StoryboardDocument.upgrade",
            Adapter::sync(storyboard_upgrade),
        ),
    ])
}
