//! Sidecar calls for a live take: cached narration synthesis and the
//! recorded browser take, with typed views of their results.

use super::analysis::ViewBox;
use super::narration::SynthesisResult;
use crate::util::sidecar::SidecarManager;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggedMarker {
    pub label: String,
    pub on_requested_ms: f64,
    pub on_ack_ms: f64,
    pub off_requested_ms: f64,
    pub off_ack_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggedStep {
    pub index: usize,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    pub status: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub target_box: Option<ViewBox>,
    #[serde(default)]
    pub dispatched_ms: Option<f64>,
    #[serde(default)]
    pub input_effect_ms: Option<f64>,
    #[serde(default)]
    pub postcondition: Option<String>,
    #[serde(default)]
    pub postcondition_ms: Option<f64>,
    #[serde(default)]
    pub observe_box: Option<ViewBox>,
    /// Page-side semantic witness (absent in takes recorded before it).
    #[serde(default)]
    pub witness: Option<StepWitness>,
    #[serde(default)]
    pub error: Option<String>,
}

/// One host↔page clock probe (minimum roundtrip of a few evaluations).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ClockProbe {
    pub host_ms: f64,
    pub page_ms: f64,
    pub rtt_ms: f64,
    /// Add to a page epoch time to get host ms after t0.
    pub offset_ms: f64,
}

/// A page event reported by the witness init script, in page epoch ms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WitnessEvent {
    pub doc: String,
    /// `input:pointerdown|keydown|wheel`, `effect:mutation|input|scroll`
    /// or `document` (a new document's first frame).
    pub kind: String,
    pub at: f64,
    /// Next animation frame after the event (frame-begin time).
    pub frame: f64,
    #[serde(default, rename = "box")]
    pub bbox: Option<ViewBox>,
    /// The document URL when the event was sent.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub received_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepWitness {
    pub clock_pre: ClockProbe,
    pub clock_post: ClockProbe,
    #[serde(default)]
    pub events: Vec<WitnessEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeLog {
    #[serde(rename = "recordViewport")]
    pub record_viewport: super::script::Viewport,
    pub markers: Vec<LoggedMarker>,
    pub steps: Vec<LoggedStep>,
    #[serde(default)]
    pub playwright: Option<String>,
    #[serde(default, rename = "browserVersion")]
    pub browser_version: Option<String>,
}

pub struct RecordedTake {
    pub video: PathBuf,
    pub log: TakeLog,
    /// The sidecar's full log (kept verbatim in take.json).
    pub raw_log: Value,
}

/// Cache key for one narration + voice.
pub fn tts_cache_key(text: &str, voice: &str) -> String {
    let mut h = Sha256::new();
    h.update(voice.as_bytes());
    h.update([0]);
    h.update(text.as_bytes());
    h.finalize()[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Clone)]
pub struct SpeechAuth {
    pub endpoint: String,
    pub token: Option<String>,
}

/// Synthesizes (or loads from `cache_dir`) the narration WAV and boundaries.
/// Returns the result and whether it came from the cache.
pub async fn synthesize_cached(
    sidecar: &SidecarManager,
    cache_dir: &Path,
    text: &str,
    voice: &str,
    auth: &SpeechAuth,
) -> Result<(SynthesisResult, bool)> {
    std::fs::create_dir_all(cache_dir)?;
    let key = tts_cache_key(text, voice);
    let wav = cache_dir.join(format!("{key}.wav"));
    let meta = cache_dir.join(format!("{key}.json"));
    if wav.is_file() && meta.is_file() {
        let mut cached: SynthesisResult = serde_json::from_slice(&std::fs::read(&meta)?)?;
        cached.audio_path = wav.to_string_lossy().into_owned();
        return Ok((cached, true));
    }
    let token = auth.token.as_deref().ok_or_else(|| {
        anyhow!("narration is not cached; set SPEECH_TOKEN (see docs/video/live-take-learnings.md)")
    })?;
    let value = sidecar
        .request_with_timeout(
            "tts.synthesize",
            json!({
                "text": text,
                "voice": voice,
                "endpoint": auth.endpoint,
                "auth": { "type": "bearer", "token": token },
                "format": "wav",
                "outPath": wav,
            }),
            Duration::from_secs(120),
        )
        .await
        .map_err(|e| anyhow!("tts.synthesize: {e}"))?;
    let mut result: SynthesisResult =
        serde_json::from_value(value).context("tts.synthesize result")?;
    result.audio_path = wav.to_string_lossy().into_owned();
    std::fs::write(&meta, serde_json::to_vec_pretty(&result)?)?;
    Ok((result, false))
}

pub async fn record_take(
    sidecar: &SidecarManager,
    out_dir: &Path,
    viewport: super::script::Viewport,
    steps: Vec<Value>,
    headless: bool,
) -> Result<RecordedTake> {
    let value = sidecar
        .request_with_timeout(
            "browser.take",
            json!({
                "viewport": viewport,
                "steps": steps,
                "outDir": out_dir,
                "headless": headless,
                "stepTimeoutMs": 20_000,
            }),
            Duration::from_secs(300),
        )
        .await
        .map_err(|e| anyhow!("browser.take: {e}"))?;
    let video = value
        .get("videoPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("browser.take returned no video"))?;
    let raw_log = value.get("log").cloned().unwrap_or(Value::Null);
    let log: TakeLog = serde_json::from_value(raw_log.clone()).context("browser.take log")?;
    Ok(RecordedTake {
        video,
        log,
        raw_log,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_depends_on_voice_and_text() {
        let a = tts_cache_key("hello", "v1");
        assert_eq!(a.len(), 24);
        assert_eq!(a, tts_cache_key("hello", "v1"));
        assert_ne!(a, tts_cache_key("hello", "v2"));
        assert_ne!(a, tts_cache_key("hello!", "v1"));
    }

    #[test]
    fn parses_a_sidecar_take_log() {
        let log: TakeLog = serde_json::from_value(json!({
            "viewport": {"width": 1280, "height": 720},
            "recordViewport": {"width": 1280, "height": 720},
            "markers": [{"label": "start", "on_requested_ms": 1.0, "on_ack_ms": 2.5,
                         "off_requested_ms": 160.0, "off_ack_ms": 161.0}],
            "steps": [{"index": 0, "type": "click", "label": "open", "status": "ok",
                       "target_box": {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0},
                       "dispatched_ms": 900.5, "input_effect_ms": 901.0,
                       "postcondition": null, "postcondition_ms": 950.0}]
        }))
        .unwrap();
        assert_eq!(log.steps[0].kind, "click");
        assert_eq!(log.steps[0].target_box.unwrap().height, 4.0);
        assert_eq!(log.markers[0].on_ack_ms, 2.5);
    }
}
