// Binds the SketchDocument @vector operations (contracts/edits.tsp) to the
// desktop's production document code: serde for decode/save and
// engine::sketch_edits for edits. Included by the generated conformance suite
// via #[path].
#![allow(dead_code, unused_variables, clippy::all)]

use cutready_lib::document::{self, RowTextUpdate, Sketch, SketchEditError};
use serde_json::{json, Value};
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

pub fn doubles() -> Value {
    json!({})
}

pub fn waivers() -> HashMap<&'static str, &'static str> {
    HashMap::new()
}

pub fn adapters() -> HashMap<&'static str, Adapter> {
    HashMap::from([
        ("SketchDocument.roundTrip", Adapter::sync(round_trip)),
        (
            "SketchDocument.updateRowText",
            Adapter::sync(update_row_text),
        ),
        ("SketchDocument.reorderRows", Adapter::sync(reorder_rows)),
    ])
}
