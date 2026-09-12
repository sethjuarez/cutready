use std::{
    collections::HashSet,
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};

pub const RESOLVED_DEMO_SCHEMA_VERSION: &str = "scenecast.resolved-demo.v1";

/// Scenecast-owned resolved click-through demo output consumed by CutReady export.
///
/// This is production-time playback evidence, not sketch authoring intent. Sketch
/// rows keep high-level `demo_steps`; Scenecast resolves its bundle graph into
/// ordered steps, timed segments, capture references, interactions, frames, and
/// diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemo {
    pub schema_version: String,
    pub title: String,
    pub start_scene_id: String,
    pub capture_policy: ResolvedCapturePolicy,
    #[serde(default)]
    pub steps: Vec<ResolvedDemoStep>,
    #[serde(default)]
    pub segments: Vec<ResolvedDemoSegment>,
    #[serde(default)]
    pub diagnostics: Vec<ResolvedDemoDiagnostic>,
}

impl ResolvedDemo {
    pub fn validate_for_row_count(&self, row_count: usize) -> anyhow::Result<()> {
        if self.schema_version != RESOLVED_DEMO_SCHEMA_VERSION {
            anyhow::bail!(
                "Unsupported resolved demo schemaVersion `{}`; expected `{RESOLVED_DEMO_SCHEMA_VERSION}`",
                self.schema_version
            );
        }

        let mut step_ids = HashSet::new();
        let mut step_orders = HashSet::new();
        for step in &self.steps {
            if step.order as usize >= row_count {
                anyhow::bail!(
                    "Resolved demo step `{}` order {} is outside sketch row range 0..{}",
                    step.id,
                    step.order,
                    row_count.saturating_sub(1)
                );
            }
            if !step_ids.insert(step.id.as_str()) {
                anyhow::bail!("Resolved demo contains duplicate step id `{}`", step.id);
            }
            if !step_orders.insert(step.order) {
                anyhow::bail!("Resolved demo contains duplicate step order {}", step.order);
            }
            step.validate()?;
        }

        for segment in &self.segments {
            if !step_ids.contains(segment.step_id.as_str()) {
                anyhow::bail!(
                    "Resolved demo segment `{}` references unknown stepId `{}`",
                    segment.id,
                    segment.step_id
                );
            }
            segment.validate()?;
        }

        if let Some(diagnostic) = self
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.is_error())
        {
            anyhow::bail!(
                "Resolved demo contains blocking diagnostic `{}`: {}",
                diagnostic.code,
                diagnostic.message
            );
        }

        Ok(())
    }

    pub fn row_playback_duration_seconds(&self, row_number: usize) -> Option<f64> {
        let row_order = row_number.checked_sub(1)? as u32;
        let row_step_ids = self
            .steps
            .iter()
            .filter(|step| step.order == row_order)
            .map(|step| step.id.as_str())
            .collect::<HashSet<_>>();
        let mut start_ms = None::<u64>;
        let mut end_ms = None::<u64>;
        for segment in self
            .segments
            .iter()
            .filter(|segment| row_step_ids.contains(segment.step_id.as_str()))
        {
            start_ms = Some(start_ms.map_or(segment.start_ms, |value| value.min(segment.start_ms)));
            end_ms = Some(end_ms.map_or(segment.end_ms, |value| value.max(segment.end_ms)));
        }
        start_ms
            .zip(end_ms)
            .and_then(|(start, end)| (end > start).then_some((end - start) as f64 / 1000.0))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCapturePolicy {
    pub kind: String,
    pub asset_base: String,
    pub missing_capture_behavior: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoStep {
    pub id: String,
    pub order: u32,
    pub scene_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub screenshot: Option<ResolvedAssetReference>,
    #[serde(default)]
    pub video: Option<ResolvedAssetReference>,
    #[serde(default)]
    pub guide_marks: Vec<ResolvedGuideMark>,
    #[serde(default)]
    pub targets: Vec<ResolvedInteractionTarget>,
}

impl ResolvedDemoStep {
    fn validate(&self) -> anyhow::Result<()> {
        if let Some(screenshot) = &self.screenshot {
            screenshot.validate()?;
        }
        if let Some(video) = &self.video {
            video.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAssetReference {
    pub path: String,
}

impl ResolvedAssetReference {
    fn validate(&self) -> anyhow::Result<()> {
        if !is_safe_relative_path(&self.path) {
            anyhow::bail!("Resolved demo asset path must be project-relative and safe");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedGuideMark {
    pub id: String,
    pub label: String,
    pub bounds: ResolvedRect,
    pub style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedInteractionTarget {
    pub id: String,
    pub label: String,
    pub target_scene_id: String,
    pub trigger: String,
    pub scroll_direction: String,
    pub bounds: ResolvedRect,
    #[serde(default)]
    pub selectors: Vec<ResolvedSelector>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSelector {
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoSegment {
    pub id: String,
    pub kind: String,
    pub step_id: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub end_ms: u64,
    #[serde(default)]
    pub capture: Option<ResolvedAssetReference>,
    #[serde(default)]
    pub interaction: Option<ResolvedInteractionTarget>,
    #[serde(default)]
    pub frames: Vec<ResolvedDemoFrame>,
    pub wait_ms: u64,
}

impl ResolvedDemoSegment {
    fn validate(&self) -> anyhow::Result<()> {
        if self.end_ms < self.start_ms {
            anyhow::bail!(
                "Resolved demo segment `{}` has endMs before startMs",
                self.id
            );
        }
        let span_ms = self.end_ms - self.start_ms;
        if self.duration_ms != span_ms {
            anyhow::bail!(
                "Resolved demo segment `{}` has durationMs {} but startMs/endMs span {}",
                self.id,
                self.duration_ms,
                span_ms
            );
        }
        if let Some(capture) = &self.capture {
            capture.validate()?;
        }
        for frame in &self.frames {
            frame.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoFrame {
    pub path: String,
    pub duration_ms: u32,
}

impl ResolvedDemoFrame {
    fn validate(&self) -> anyhow::Result<()> {
        if !is_safe_relative_path(&self.path) {
            anyhow::bail!("Resolved demo frame path must be project-relative and safe");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub scene_id: Option<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

impl ResolvedDemoDiagnostic {
    fn is_error(&self) -> bool {
        self.severity.eq_ignore_ascii_case("error")
    }
}

fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.trim().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| !is_forbidden_path_component(component))
}

fn is_forbidden_path_component(component: Component<'_>) -> bool {
    matches!(component, Component::ParentDir | Component::RootDir) || is_path_prefix(component)
}

#[cfg(target_os = "windows")]
fn is_path_prefix(component: Component<'_>) -> bool {
    matches!(component, Component::Prefix(_))
}

#[cfg(not(target_os = "windows"))]
fn is_path_prefix(_component: Component<'_>) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_resolved_demo() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [
                {
                    "id": "step-start",
                    "order": 0,
                    "sceneId": "start",
                    "title": "Start",
                    "description": "Opening screen.",
                    "notes": "Starter scene for Demo",
                    "screenshot": { "path": "captures/start.png" },
                    "video": null,
                    "guideMarks": [
                        {
                            "id": "cta-guide",
                            "label": "Primary call to action",
                            "bounds": { "x": 8.0, "y": 9.0, "width": 10.0, "height": 11.0 },
                            "style": "highlight"
                        }
                    ],
                    "targets": [
                        {
                            "id": "pricing-link",
                            "label": "View pricing",
                            "targetSceneId": "pricing",
                            "trigger": "click",
                            "scrollDirection": "any",
                            "bounds": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 },
                            "selectors": []
                        }
                    ]
                },
                {
                    "id": "step-pricing",
                    "order": 1,
                    "sceneId": "pricing",
                    "title": "Pricing",
                    "description": null,
                    "notes": null,
                    "screenshot": { "path": "captures/pricing.png" },
                    "video": null,
                    "guideMarks": [],
                    "targets": []
                }
            ],
            "segments": [
                {
                    "id": "segment-start-scene",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 0,
                    "durationMs": 1000,
                    "endMs": 1000,
                    "capture": { "path": "captures/start.png" },
                    "interaction": null,
                    "frames": [],
                    "waitMs": 0
                },
                {
                    "id": "segment-start-pricing-link",
                    "kind": "wait",
                    "stepId": "step-start",
                    "startMs": 1000,
                    "durationMs": 250,
                    "endMs": 1250,
                    "capture": null,
                    "interaction": {
                        "id": "pricing-link",
                        "label": "View pricing",
                        "targetSceneId": "pricing",
                        "trigger": "click",
                        "scrollDirection": "any",
                        "bounds": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 },
                        "selectors": []
                    },
                    "frames": [],
                    "waitMs": 250
                },
                {
                    "id": "segment-pricing-scene",
                    "kind": "scene",
                    "stepId": "step-pricing",
                    "startMs": 1250,
                    "durationMs": 1000,
                    "endMs": 2250,
                    "capture": { "path": "captures/pricing.png" },
                    "interaction": null,
                    "frames": [],
                    "waitMs": 0
                }
            ],
            "diagnostics": []
        })
    }

    #[test]
    fn resolved_demo_matches_scenecast_wire_shape() {
        let demo: ResolvedDemo = serde_json::from_value(minimal_resolved_demo()).unwrap();

        demo.validate_for_row_count(2).unwrap();
        assert_eq!(demo.schema_version, RESOLVED_DEMO_SCHEMA_VERSION);
        assert_eq!(demo.steps[0].scene_id, "start");
        assert_eq!(demo.segments[1].step_id, "step-start");
        assert_eq!(demo.row_playback_duration_seconds(1), Some(1.25));
        assert_eq!(demo.row_playback_duration_seconds(2), Some(1.0));
    }

    #[test]
    fn resolved_demo_tolerates_omitted_optional_fields_and_new_non_consumed_values() {
        let value = serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "future-reference-mode",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [{
                "id": "step-start",
                "order": 0,
                "sceneId": "start",
                "title": "Start",
                "guideMarks": [{
                    "id": "guide",
                    "label": "Guide",
                    "bounds": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
                    "style": "future-style"
                }],
                "targets": [{
                    "id": "target",
                    "label": "Target",
                    "targetSceneId": "start",
                    "trigger": "future-trigger",
                    "scrollDirection": "sideways",
                    "bounds": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
                    "selectors": [{ "kind": "css", "value": "#target" }]
                }]
            }],
            "segments": [{
                "id": "segment-start-scene",
                "kind": "future-segment-kind",
                "stepId": "step-start",
                "startMs": 0,
                "durationMs": 1000,
                "endMs": 1000,
                "frames": [],
                "waitMs": 0
            }],
            "diagnostics": [{
                "severity": "info",
                "code": "future-info",
                "message": "A non-blocking future diagnostic"
            }]
        });

        let demo: ResolvedDemo = serde_json::from_value(value).unwrap();

        demo.validate_for_row_count(1).unwrap();
        assert_eq!(demo.steps[0].description, None);
        assert_eq!(demo.steps[0].targets[0].selectors[0].confidence, None);
        assert_eq!(demo.row_playback_duration_seconds(1), Some(1.0));
    }

    #[test]
    fn resolved_demo_rejects_blocking_diagnostics() {
        let mut value = minimal_resolved_demo();
        value["diagnostics"] = serde_json::json!([{
            "severity": "error",
            "code": "missing-referenced-file",
            "message": "referenced asset `captures/missing.png` does not exist",
            "sceneId": null,
            "targetId": null,
            "path": "captures/missing.png"
        }]);
        let demo: ResolvedDemo = serde_json::from_value(value).unwrap();

        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("blocking diagnostic"));
    }

    #[test]
    fn resolved_demo_rejects_inconsistent_segment_duration() {
        let mut value = minimal_resolved_demo();
        value["segments"][0]["durationMs"] = serde_json::json!(999);
        let demo: ResolvedDemo = serde_json::from_value(value).unwrap();

        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("startMs/endMs span"));
    }

    #[test]
    fn resolved_demo_rejects_duplicate_or_out_of_range_steps() {
        let mut duplicate = minimal_resolved_demo();
        duplicate["steps"][1]["order"] = serde_json::json!(0);
        let demo: ResolvedDemo = serde_json::from_value(duplicate).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("duplicate step order"));

        let mut out_of_range = minimal_resolved_demo();
        out_of_range["steps"][1]["order"] = serde_json::json!(2);
        let demo: ResolvedDemo = serde_json::from_value(out_of_range).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("outside sketch row range"));
    }

    #[test]
    fn resolved_demo_rejects_unknown_step_segments_and_unsafe_paths() {
        let mut unknown_step = minimal_resolved_demo();
        unknown_step["segments"][0]["stepId"] = serde_json::json!("missing-step");
        let demo: ResolvedDemo = serde_json::from_value(unknown_step).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("references unknown stepId"));

        let mut unsafe_path = minimal_resolved_demo();
        unsafe_path["steps"][0]["screenshot"]["path"] = serde_json::json!("../leak.png");
        let demo: ResolvedDemo = serde_json::from_value(unsafe_path).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("asset path must be project-relative and safe"));
    }
}
