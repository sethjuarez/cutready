use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// An animation asset — ManimCE source + optional render output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Animation {
    pub id: Uuid,
    pub name: String,
    /// Natural language description of the animation.
    pub description: String,
    /// ManimCE Python source code.
    pub source_code: String,
    /// Path to rendered video (populated after render).
    pub rendered_path: Option<PathBuf>,
    /// Duration in milliseconds (populated after render).
    pub duration_ms: Option<u64>,
}

impl Animation {
    /// Create a new animation with a description (no code yet).
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            description: description.into(),
            source_code: String::new(),
            rendered_path: None,
            duration_ms: None,
        }
    }
}

/// Render quality for ManimCE.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RenderQuality {
    Low,
    Medium,
    High,
    UltraHigh,
}

impl RenderQuality {
    /// ManimCE CLI flag for this quality level.
    pub fn flag(&self) -> &str {
        match self {
            Self::Low => "-ql",
            Self::Medium => "-qm",
            Self::High => "-qh",
            Self::UltraHigh => "-qk",
        }
    }
}

/// Progress update during animation rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderProgress {
    pub percent: f32,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn animation_roundtrip() {
        let anim = Animation {
            id: Uuid::new_v4(),
            name: "Data Flow".into(),
            description: "Show data flowing from API to database".into(),
            source_code: "from manim import *\nclass DataFlow(Scene): ...".into(),
            rendered_path: Some("animations/data_flow.mp4".into()),
            duration_ms: Some(8000),
        };
        let json = serde_json::to_string(&anim).unwrap();
        let parsed: Animation = serde_json::from_str(&json).unwrap();
        assert_eq!(anim.id, parsed.id);
        assert_eq!(anim.name, parsed.name);
        assert_eq!(anim.duration_ms, parsed.duration_ms);
    }

    #[test]
    fn render_quality_flags() {
        assert_eq!(RenderQuality::Low.flag(), "-ql");
        assert_eq!(RenderQuality::Medium.flag(), "-qm");
        assert_eq!(RenderQuality::High.flag(), "-qh");
        assert_eq!(RenderQuality::UltraHigh.flag(), "-qk");
    }

    #[test]
    fn animation_new_defaults() {
        let anim = Animation::new("Intro", "A welcome animation");
        assert_eq!(anim.name, "Intro");
        assert_eq!(anim.description, "A welcome animation");
        assert!(anim.source_code.is_empty());
        assert!(anim.rendered_path.is_none());
        assert!(anim.duration_ms.is_none());
    }

    #[test]
    fn render_progress_roundtrip() {
        let progress = RenderProgress {
            percent: 75.5,
            message: "Rendering frame 150/200".into(),
        };
        let json = serde_json::to_string(&progress).unwrap();
        let parsed: RenderProgress = serde_json::from_str(&json).unwrap();
        assert!((parsed.percent - 75.5).abs() < f32::EPSILON);
        assert_eq!(parsed.message, "Rendering frame 150/200");
    }

    #[test]
    fn render_quality_serde_values() {
        let json = serde_json::to_string(&RenderQuality::Low).unwrap();
        assert_eq!(json, "\"low\"");
        let json = serde_json::to_string(&RenderQuality::UltraHigh).unwrap();
        assert_eq!(json, "\"ultra_high\"");
    }

    #[test]
    fn render_quality_all_variants_roundtrip() {
        for quality in [
            RenderQuality::Low,
            RenderQuality::Medium,
            RenderQuality::High,
            RenderQuality::UltraHigh,
        ] {
            let json = serde_json::to_string(&quality).unwrap();
            let parsed: RenderQuality = serde_json::from_str(&json).unwrap();
            assert_eq!(quality, parsed);
        }
    }

    #[test]
    fn animation_with_no_render_roundtrip() {
        let anim = Animation::new("Test", "Test description");
        let json = serde_json::to_string(&anim).unwrap();
        let parsed: Animation = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, anim.id);
        assert!(parsed.rendered_path.is_none());
        assert!(parsed.duration_ms.is_none());
    }
}
