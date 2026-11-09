use std::{
    collections::HashSet,
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};

pub const RESOLVED_DEMO_SCHEMA_VERSION: &str = "scenecast.resolved-demo.v1";
pub const CUTREADY_ROW_SCENE_PREFIX: &str = "cutready-row-";

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

    pub fn validate_for_source_rows(&self, source_row_ids: &[String]) -> anyhow::Result<()> {
        self.validate_for_row_count(source_row_ids.len())?;

        for step in &self.steps {
            let expected_row_id = source_row_ids
                .get(step.order as usize)
                .map(String::as_str)
                .unwrap_or_default();
            if expected_row_id.is_empty() {
                continue;
            }

            if let Some(source_row_id) = step.source_row_id.as_deref() {
                if source_row_id != expected_row_id {
                    anyhow::bail!(
                        "Resolved demo step `{}` was compiled for row `{}` but row {} is now `{}`; regenerate the resolved demo",
                        step.id,
                        source_row_id,
                        step.order + 1,
                        expected_row_id
                    );
                }
                continue;
            }

            if step.scene_id.starts_with(CUTREADY_ROW_SCENE_PREFIX) {
                let expected_scene_id = cutready_row_scene_id(expected_row_id);
                if step.scene_id != expected_scene_id {
                    anyhow::bail!(
                        "Resolved demo step `{}` points at scene `{}` but row {} now maps to `{}`; regenerate the resolved demo",
                        step.id,
                        step.scene_id,
                        step.order + 1,
                        expected_scene_id
                    );
                }
            }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_row_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_row_order: Option<u32>,
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

pub fn cutready_row_scene_id(row_id: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in row_id.trim().chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            previous_dash = false;
            Some(ch.to_ascii_lowercase())
        } else if ch == '-' || ch == '_' {
            if previous_dash {
                None
            } else {
                previous_dash = true;
                Some('-')
            }
        } else if previous_dash {
            None
        } else {
            previous_dash = true;
            Some('-')
        };
        if let Some(ch) = normalized {
            slug.push(ch);
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        format!("{CUTREADY_ROW_SCENE_PREFIX}unknown")
    } else {
        format!("{CUTREADY_ROW_SCENE_PREFIX}{slug}")
    }
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

    fn scenecast_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../fixtures/scenecast/resolved-demo.json")).unwrap()
    }

    fn value_with_id_mut<'a>(
        value: &'a mut serde_json::Value,
        collection: &str,
        id: &str,
    ) -> &'a mut serde_json::Value {
        value[collection]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|entry| entry["id"] == id)
            .unwrap_or_else(|| panic!("fixture missing {collection} entry `{id}`"))
    }

    #[test]
    fn resolved_demo_matches_scenecast_wire_shape() {
        let fixture = scenecast_fixture();
        let demo: ResolvedDemo = serde_json::from_value(fixture.clone()).unwrap();

        demo.validate_for_row_count(2).unwrap();
        assert_eq!(demo.schema_version, RESOLVED_DEMO_SCHEMA_VERSION);
        assert_eq!(demo.steps[0].scene_id, "start");
        assert_eq!(
            demo.steps[0]
                .screenshot
                .as_ref()
                .map(|asset| asset.path.as_str()),
            Some("captures/start.png")
        );
        assert_eq!(demo.steps[0].guide_marks[0].style, "highlight");
        assert_eq!(demo.steps[0].targets[0].id, "pricing-link");
        assert_eq!(demo.segments[1].step_id, "step-start");
        assert_eq!(
            demo.segments[1]
                .interaction
                .as_ref()
                .map(|interaction| interaction.id.as_str()),
            Some("pricing-link")
        );
        assert_eq!(demo.row_playback_duration_seconds(1), Some(1.25));
        assert_eq!(demo.row_playback_duration_seconds(2), Some(1.0));
        assert_eq!(serde_json::to_value(&demo).unwrap(), fixture);
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
    fn resolved_demo_validates_cutready_source_row_mapping_when_present() {
        let mut value = scenecast_fixture();
        value_with_id_mut(&mut value, "steps", "step-start")["sceneId"] =
            serde_json::json!(cutready_row_scene_id("row-a"));
        value_with_id_mut(&mut value, "steps", "step-pricing")["sourceRowId"] =
            serde_json::json!("row-b");
        let demo: ResolvedDemo = serde_json::from_value(value).unwrap();

        demo.validate_for_source_rows(&["row-a".to_string(), "row-b".to_string()])
            .unwrap();

        assert!(demo
            .validate_for_source_rows(&["row-b".to_string(), "row-a".to_string()])
            .unwrap_err()
            .to_string()
            .contains("regenerate the resolved demo"));
    }

    #[test]
    fn cutready_row_scene_ids_are_portable_identifiers() {
        assert_eq!(cutready_row_scene_id("A Row_ID!!"), "cutready-row-a-row-id");
        assert_eq!(cutready_row_scene_id("   "), "cutready-row-unknown");
    }

    #[test]
    fn resolved_demo_rejects_blocking_diagnostics() {
        let mut value = scenecast_fixture();
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
        let mut value = scenecast_fixture();
        value_with_id_mut(&mut value, "segments", "segment-start-scene")["durationMs"] =
            serde_json::json!(999);
        let demo: ResolvedDemo = serde_json::from_value(value).unwrap();

        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("startMs/endMs span"));
    }

    #[test]
    fn resolved_demo_rejects_duplicate_or_out_of_range_steps() {
        let mut duplicate = scenecast_fixture();
        value_with_id_mut(&mut duplicate, "steps", "step-pricing")["order"] = serde_json::json!(0);
        let demo: ResolvedDemo = serde_json::from_value(duplicate).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("duplicate step order"));

        let mut out_of_range = scenecast_fixture();
        value_with_id_mut(&mut out_of_range, "steps", "step-pricing")["order"] =
            serde_json::json!(2);
        let demo: ResolvedDemo = serde_json::from_value(out_of_range).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("outside sketch row range"));
    }

    #[test]
    fn resolved_demo_rejects_unknown_step_segments_and_unsafe_paths() {
        let mut unknown_step = scenecast_fixture();
        value_with_id_mut(&mut unknown_step, "segments", "segment-start-scene")["stepId"] =
            serde_json::json!("missing-step");
        let demo: ResolvedDemo = serde_json::from_value(unknown_step).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("references unknown stepId"));

        let mut unsafe_path = scenecast_fixture();
        value_with_id_mut(&mut unsafe_path, "steps", "step-start")["screenshot"]["path"] =
            serde_json::json!("../leak.png");
        let demo: ResolvedDemo = serde_json::from_value(unsafe_path).unwrap();
        assert!(demo
            .validate_for_row_count(2)
            .unwrap_err()
            .to_string()
            .contains("asset path must be project-relative and safe"));
    }
}
