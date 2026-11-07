use super::tests::write_test_sketch;
use super::*;
use cutready_core::models::sketch::{
    DemoStep, FramingBeat, FramingEasing, FramingRect, InteractionCapturePolicy, WaitEditPolicy,
};
use serde_json::json;
use tempfile::TempDir;

#[test]
fn write_sketch_tool_preserves_missing_compiled_row_intent() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let rel = "demo.sk";
    let mut row = PlanningRow::new();
    row.narrative = "Old narration".into();
    row.demo_actions = "Click Generate".into();
    row.demo_steps = vec![
        DemoStep::Click {
            target: "Generate storyboard".into(),
            target_bounds: None,
            capture: Some(InteractionCapturePolicy::BeforeAfterAndMotion),
        },
        DemoStep::WaitFor {
            condition: "rows appear".into(),
            timeout_ms: Some(30_000),
            edit_policy: Some(WaitEditPolicy::CompressWait),
        },
    ];
    row.framing_beats = vec![FramingBeat::ZoomTo {
        at_ms: 500,
        target: Some("generated outline".into()),
        rect: Some(FramingRect {
            x: 0.1,
            y: 0.2,
            width: 0.7,
            height: 0.4,
        }),
        duration_ms: Some(800),
        easing: Some(FramingEasing::EaseOut),
    }];
    write_test_sketch(root, rel, row.clone());

    let result = exec_write_sketch(
        root,
        &json!({
            "path": rel,
            "rows": [{
                "source_row": 1,
                "time": "",
                "narrative": "New narration",
                "demo_actions": "Click Generate"
            }]
        }),
    );

    assert!(
        !result.text().starts_with("Error:"),
        "write_sketch should preserve omitted compiled intent: {}",
        result.text()
    );
    let saved = project::read_sketch(&root.join(rel)).unwrap();
    assert_eq!(saved.rows[0].narrative, "New narration");
    assert_eq!(saved.rows[0].demo_steps, row.demo_steps);
    assert_eq!(saved.rows[0].framing_beats, row.framing_beats);
}
