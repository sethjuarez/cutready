// Binds the SketchDocument @vector operations to the desktop's production
// document code. Included by the generated conformance suite via #[path].
#![allow(dead_code, unused_variables, clippy::all)]

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
        Self { invoke: Invoke::Sync(invoke), normalize: None }
    }
}

pub fn doubles() -> Value {
    json!({})
}

pub fn waivers() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("SketchDocument.roundTrip", "desktop adapter lands in the next slice commit"),
        ("SketchDocument.updateRowText", "desktop adapter lands in the next slice commit"),
        ("SketchDocument.reorderRows", "desktop adapter lands in the next slice commit"),
    ])
}

pub fn adapters() -> HashMap<&'static str, Adapter> {
    HashMap::new()
}
