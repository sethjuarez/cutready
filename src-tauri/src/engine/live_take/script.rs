//! The demo script for a live take (`cutready.live-take-script.v1`).
//!
//! A deliberately small, standalone input: narration text, a voice, a setup
//! page and steps that each name a cue phrase in the narration. It is not
//! coupled to the sketch row model or the recorder's `Action` /
//! `SelectorStrategy` types yet; see `docs/video/live-take-learnings.md` for
//! the adapter this slice suggests.

use crate::engine::demo_timing::{Cue, CueAnchor, Micros};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

pub const LIVE_TAKE_SCRIPT_SCHEMA_V1: &str = "cutready.live-take-script.v1";
pub const SETUP_LABEL: &str = "setup";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTakeScript {
    #[serde(default = "default_schema")]
    pub schema: String,
    pub name: String,
    /// Plain narration text, spoken in one synthesis call.
    pub narration: String,
    pub voice: String,
    /// Setup page loaded before the first step and trimmed from the output.
    /// A relative path resolves against the script's folder.
    pub url: String,
    /// What must hold before the take starts (e.g. a landmark is visible).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready: Option<Postcondition>,
    #[serde(default)]
    pub viewport: Viewport,
    pub steps: Vec<ScriptStep>,
}

fn default_schema() -> String {
    LIVE_TAKE_SCRIPT_SCHEMA_V1.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

impl Default for Viewport {
    fn default() -> Self {
        Viewport {
            width: 1280,
            height: 720,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Navigate,
    Click,
    Type,
    Scroll,
}

impl StepKind {
    /// The sidecar step type and the latency-table key.
    pub fn as_str(self) -> &'static str {
        match self {
            StepKind::Navigate => "navigate",
            StepKind::Click => "click",
            StepKind::Type => "type",
            StepKind::Scroll => "scroll",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptStep {
    pub id: String,
    pub kind: StepKind,
    /// Fallback selectors in priority order (click, type; for scroll, the
    /// element to wheel over, else the viewport centre).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selectors: Vec<String>,
    /// Text to type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Destination (navigate).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dx: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dy: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue: Option<ScriptCue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postcondition: Option<Postcondition>,
    /// Element whose region shows the action's effect; defaults to the
    /// postcondition selector, then the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observe: Option<String>,
}

/// One phrase, or the words of one phrase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CueTokens {
    Phrase(String),
    Words(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptCue {
    pub tokens: CueTokens,
    /// 0-based match after the previous cue; omitted means "exactly one".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<u32>,
    #[serde(default)]
    pub anchor: CueAnchor,
    #[serde(default)]
    pub offset_ms: i64,
}

impl ScriptCue {
    pub fn to_cue(&self) -> Cue {
        let text = match &self.tokens {
            CueTokens::Phrase(p) => p.clone(),
            CueTokens::Words(w) => w.join(" "),
        };
        Cue {
            text,
            occurrence: self.occurrence,
            anchor: self.anchor,
            offset_us: Micros::from_millis(self.offset_ms),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Postcondition {
    Selector {
        selector: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    Url {
        url: String,
    },
    ScrollY {
        #[serde(rename = "scrollYAtLeast")]
        scroll_y_at_least: i64,
    },
}

impl LiveTakeScript {
    pub fn parse(text: &str) -> Result<Self, String> {
        let script: LiveTakeScript =
            serde_json::from_str(text).map_err(|e| format!("invalid live take script: {e}"))?;
        script.validate()?;
        Ok(script)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema != LIVE_TAKE_SCRIPT_SCHEMA_V1 {
            return Err(format!("unsupported script schema {:?}", self.schema));
        }
        if self.narration.trim().is_empty() {
            return Err("narration is empty".into());
        }
        if self.steps.is_empty() {
            return Err("script has no steps".into());
        }
        let Viewport { width, height } = self.viewport;
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err(format!(
                "viewport {width}x{height} must be non-zero and even (yuv420p)"
            ));
        }
        let mut ids = HashSet::new();
        for step in &self.steps {
            if step.id == SETUP_LABEL || !ids.insert(step.id.as_str()) {
                return Err(format!("duplicate or reserved step id {:?}", step.id));
            }
            let missing = match step.kind {
                StepKind::Click | StepKind::Type if step.selectors.is_empty() => Some("selectors"),
                StepKind::Type if step.text.is_none() => Some("text"),
                StepKind::Navigate if step.url.is_none() => Some("url"),
                _ => None,
            };
            if let Some(field) = missing {
                return Err(format!(
                    "step {:?} ({}) needs {field}",
                    step.id,
                    step.kind.as_str()
                ));
            }
        }
        Ok(())
    }

    /// Sidecar `browser.take` steps: the setup navigation (labelled
    /// [`SETUP_LABEL`]) followed by the script's steps, labelled by id.
    pub fn sidecar_steps(&self, script_dir: &Path) -> Vec<Value> {
        let mut steps = vec![json!({
            "type": "navigate",
            "label": SETUP_LABEL,
            "url": resolve_url(&self.url, script_dir),
            "expect": self.ready,
        })];
        steps.extend(self.steps.iter().map(|step| {
            let mut v = json!({ "type": step.kind.as_str(), "label": step.id });
            let o = v.as_object_mut().expect("object");
            if !step.selectors.is_empty() {
                o.insert("selectors".into(), json!(step.selectors));
            }
            if let Some(text) = &step.text {
                o.insert("text".into(), json!(text));
            }
            if let Some(url) = &step.url {
                o.insert("url".into(), json!(resolve_url(url, script_dir)));
            }
            if let Some(dx) = step.dx {
                o.insert("dx".into(), json!(dx));
            }
            if let Some(dy) = step.dy {
                o.insert("dy".into(), json!(dy));
            }
            if let Some(post) = &step.postcondition {
                o.insert("expect".into(), json!(post));
            }
            if let Some(observe) = &step.observe {
                o.insert("observe".into(), json!(observe));
            }
            v
        }));
        steps
    }
}

/// Absolute http(s)/file URLs pass through; anything else is a path
/// relative to the script folder, turned into a `file://` URL.
pub fn resolve_url(url: &str, script_dir: &Path) -> String {
    let lower = url.to_ascii_lowercase();
    if ["http://", "https://", "file://", "about:", "data:"]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        return url.to_string();
    }
    let path = script_dir.join(url);
    let path = path.canonicalize().unwrap_or(path);
    file_url(&path)
}

fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s);
    let mut encoded = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => encoded.push_str("%20"),
            '#' => encoded.push_str("%23"),
            '?' => encoded.push_str("%3F"),
            '%' => encoded.push_str("%25"),
            c => encoded.push(c),
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r##"{
      "name": "fixture",
      "narration": "First we open the panel.",
      "voice": "en-US-AvaMultilingualNeural",
      "url": "page.html",
      "ready": {"selector": "#open"},
      "steps": [
        {"id": "open", "kind": "click", "selectors": ["#open"],
         "cue": {"tokens": ["open", "the"], "occurrence": 0, "anchor": "wordEnd", "offsetMs": -40},
         "postcondition": {"selector": "#panel", "state": "visible"}},
        {"id": "down", "kind": "scroll", "dy": 900, "cue": {"tokens": "panel"},
         "postcondition": {"scrollYAtLeast": 400}}
      ]
    }"##;

    #[test]
    fn parses_and_maps_cues() {
        let s = LiveTakeScript::parse(FIXTURE).unwrap();
        assert_eq!(s.viewport, Viewport::default());
        let cue = s.steps[0].cue.as_ref().unwrap().to_cue();
        assert_eq!(cue.text, "open the");
        assert_eq!(cue.occurrence, Some(0));
        assert_eq!(cue.anchor, CueAnchor::WordEnd);
        assert_eq!(cue.offset_us, Micros(-40_000));
        let cue = s.steps[1].cue.as_ref().unwrap().to_cue();
        assert_eq!(cue, Cue::new("panel"));
        assert_eq!(
            s.steps[1].postcondition,
            Some(Postcondition::ScrollY {
                scroll_y_at_least: 400
            })
        );
    }

    #[test]
    fn rejects_bad_scripts() {
        let mut s = LiveTakeScript::parse(FIXTURE).unwrap();
        s.steps[1].id = "open".into();
        assert!(s.validate().unwrap_err().contains("duplicate"));
        let mut s = LiveTakeScript::parse(FIXTURE).unwrap();
        s.steps[1].id = SETUP_LABEL.into();
        assert!(s.validate().unwrap_err().contains("reserved"));
        let mut s = LiveTakeScript::parse(FIXTURE).unwrap();
        s.steps[0].selectors.clear();
        assert!(s.validate().unwrap_err().contains("selectors"));
        let mut s = LiveTakeScript::parse(FIXTURE).unwrap();
        s.viewport.height = 721;
        assert!(s.validate().unwrap_err().contains("even"));
        let mut s = LiveTakeScript::parse(FIXTURE).unwrap();
        s.schema = "nope".into();
        assert!(s.validate().is_err());
    }

    #[test]
    fn sidecar_steps_prepend_setup_and_resolve_urls() {
        let s = LiveTakeScript::parse(FIXTURE).unwrap();
        let steps = s.sidecar_steps(Path::new("/no/such dir"));
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0]["label"], "setup");
        assert_eq!(steps[0]["expect"]["selector"], "#open");
        assert!(steps[0]["url"]
            .as_str()
            .unwrap()
            .ends_with("/no/such%20dir/page.html"));
        assert_eq!(steps[1]["type"], "click");
        assert_eq!(steps[1]["expect"]["state"], "visible");
        assert_eq!(steps[2]["dy"], 900);
        assert_eq!(steps[2]["expect"]["scrollYAtLeast"], 400);
    }

    #[test]
    fn resolve_url_passes_absolute_urls() {
        assert_eq!(
            resolve_url("https://playwright.dev/", Path::new(".")),
            "https://playwright.dev/"
        );
        assert_eq!(
            file_url(Path::new(r"C:\a b\x.html")),
            "file:///C:/a%20b/x.html"
        );
    }
}
