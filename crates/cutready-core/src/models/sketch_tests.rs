use super::*;
use crate::testing::test_now;

#[test]
fn sketch_new_defaults() {
    let sketch = Sketch::new("Getting Started Guide", test_now());
    assert_eq!(sketch.title, "Getting Started Guide");
    assert_eq!(sketch.description, serde_json::Value::Null);
    assert!(sketch.rows.is_empty());
    assert_eq!(sketch.state, SketchState::Draft);
}

#[test]
fn sketch_lock_cascades_to_rows_and_cells() {
    let mut sketch = Sketch::new("Demo", test_now());
    sketch.rows.push(PlanningRow::new());

    sketch.set_locked_recursive(true);

    assert!(sketch.locked);
    assert!(sketch.rows[0].locked);
    assert!(sketch.rows[0].locks.time);
    assert!(sketch.rows[0].locks.narrative);
    assert!(sketch.rows[0].locks.demo_actions);
    assert!(sketch.rows[0].locks.screenshot);
    assert!(sketch.rows[0].locks.visual);
    assert!(sketch.rows[0].locks.design_plan);

    sketch.set_locked_recursive(false);

    assert!(!sketch.locked);
    assert!(!sketch.rows[0].locked);
    assert!(!sketch.rows[0].locks.any());
}

#[test]
fn sketch_roundtrip() {
    let mut sketch = Sketch::new("Test Sketch", test_now());
    sketch.rows.push(PlanningRow {
        id: String::new(),
        locked: false,
        locks: PlanningCellLocks::default(),
        time: "~30s".into(),
        duration_seconds: Some(30),
        narrative: "Click the button".into(),
        demo_actions: "Navigate, click CTA".into(),
        demo_steps: Vec::new(),
        screenshot: Some("screenshots/step1.png".into()),
        visual: None,
        motion_points: Vec::new(),
        typing_spots: Vec::new(),
        motion_plan: None,
        framing_beats: Vec::new(),
        design_plan: None,
        narration: None,
        narration_plan: None,
        unknown_fields: Default::default(),
    });
    sketch
        .metadata
        .fields
        .insert("owner".to_string(), "Demo team".to_string());
    sketch.description = serde_json::json!({"root": {"children": []}});

    let json = serde_json::to_string_pretty(&sketch).unwrap();
    let parsed: Sketch = serde_json::from_str(&json).unwrap();
    assert_eq!(sketch.title, parsed.title);
    assert_eq!(parsed.rows.len(), 1);
    assert_eq!(parsed.rows[0].time, "~30s");
    assert_eq!(parsed.rows[0].duration_seconds, Some(30));
    assert_eq!(
        parsed.metadata.fields.get("owner").map(String::as_str),
        Some("Demo team")
    );
    assert_eq!(
        parsed.description,
        serde_json::json!({"root": {"children": []}})
    );
}

#[test]
fn sketch_state_serde_values() {
    assert_eq!(
        serde_json::to_string(&SketchState::Draft).unwrap(),
        "\"draft\""
    );
    assert_eq!(
        serde_json::to_string(&SketchState::RecordingEnriched).unwrap(),
        "\"recording_enriched\""
    );
    assert_eq!(
        serde_json::to_string(&SketchState::Refined).unwrap(),
        "\"refined\""
    );
    assert_eq!(
        serde_json::to_string(&SketchState::Final).unwrap(),
        "\"final\""
    );
}

#[test]
fn sketch_state_legacy_alias() {
    let parsed: SketchState = serde_json::from_str("\"sketch\"").unwrap();
    assert_eq!(parsed, SketchState::Draft);
}

#[test]
fn sketch_state_all_variants_roundtrip() {
    for state in [
        SketchState::Draft,
        SketchState::RecordingEnriched,
        SketchState::Refined,
        SketchState::Final,
    ] {
        let json = serde_json::to_string(&state).unwrap();
        let parsed: SketchState = serde_json::from_str(&json).unwrap();
        assert_eq!(state, parsed);
    }
}

#[test]
fn planning_row_new_defaults() {
    let row = PlanningRow::new();
    assert!(row.time.is_empty());
    assert!(row.duration_seconds.is_none());
    assert!(row.narrative.is_empty());
    assert!(row.demo_actions.is_empty());
    assert!(row.demo_steps.is_empty());
    assert!(row.framing_beats.is_empty());
    assert!(row.screenshot.is_none());
}

#[test]
fn planning_row_tolerates_null_motion_points() {
    let row: PlanningRow = serde_json::from_value(serde_json::json!({
        "time": "~30s",
        "duration_seconds": 30,
        "narrative": "Click the sign-up button",
        "demo_actions": "Navigate to /signup, click CTA",
        "screenshot": "screenshots/step1.png",
        "visual": null,
        "motion_points": null,
        "motion_plan": null
    }))
    .unwrap();

    assert!(row.motion_points.is_empty());
    assert!(row.demo_steps.is_empty());
    assert!(row.framing_beats.is_empty());
    assert!(row.motion_plan.is_none());
    assert!(row.narration_plan.is_none());
}

#[test]
fn planning_cell_locks_treat_null_as_absent() {
    let locks: PlanningCellLocks = serde_json::from_value(serde_json::json!({
        "time": null,
        "narrative": null,
        "demo_actions": null,
        "screenshot": null,
        "visual": null,
        "design_plan": null
    }))
    .unwrap();

    assert_eq!(locks, PlanningCellLocks::default());
}

#[test]
fn optional_null_defaults_do_not_accept_malformed_values() {
    let valid = serde_json::json!({
        "title": "Strict optional fields",
        "locked": true,
        "rows": [{
            "time": "0:05",
            "narrative": "Keep valid values.",
            "demo_actions": "Wait.",
            "locked": true,
            "locks": {
                "time": true, "narrative": false, "demo_actions": false,
                "screenshot": false, "visual": false, "design_plan": false
            },
            "motion_points": [],
            "typing_spots": [],
            "motion_plan": { "kind": "subtle_push", "keyframes": [] },
            "narration_plan": {
                "source_text": "Keep valid values.",
                "voice": "en-US-AvaMultilingualNeural",
                "locale": "en-US",
                "ssml": "<speak>Keep valid values.</speak>",
                "pronunciation_overrides": { "CutReady": "cut ready" },
                "beats": [],
                "generated_at": "2026-06-28T20:00:00Z"
            }
        }],
        "metadata": { "fields": { "owner": "Demo team" } },
        "state": "draft",
        "created_at": "2026-06-28T20:00:00Z",
        "updated_at": "2026-06-28T20:00:00Z"
    });
    let sketch: Sketch = serde_json::from_value(valid.clone()).unwrap();
    assert!(sketch.locked);
    assert!(sketch.rows[0].locked);
    assert!(sketch.rows[0].locks.time);
    assert!(!sketch.rows[0].locks.narrative);
    assert_eq!(sketch.metadata.fields["owner"], "Demo team");
    assert_eq!(
        sketch.rows[0]
            .narration_plan
            .as_ref()
            .unwrap()
            .pronunciation_overrides["CutReady"],
        "cut ready"
    );

    for pointer in [
        "/locked",
        "/metadata",
        "/metadata/fields",
        "/rows/0/locked",
        "/rows/0/locks",
        "/rows/0/locks/time",
        "/rows/0/locks/narrative",
        "/rows/0/locks/demo_actions",
        "/rows/0/locks/screenshot",
        "/rows/0/locks/visual",
        "/rows/0/locks/design_plan",
        "/rows/0/motion_points",
        "/rows/0/typing_spots",
        "/rows/0/motion_plan/keyframes",
        "/rows/0/narration_plan/pronunciation_overrides",
        "/rows/0/narration_plan/beats",
    ] {
        let mut malformed = valid.clone();
        *malformed.pointer_mut(pointer).unwrap() = serde_json::json!("invalid");
        assert!(
            serde_json::from_value::<Sketch>(malformed).is_err(),
            "must reject an invalid value at {pointer}"
        );
    }

    for (pointer, value) in [
        ("/metadata/fields", serde_json::json!({ "owner": null })),
        (
            "/rows/0/narration_plan/pronunciation_overrides",
            serde_json::json!({ "CutReady": null }),
        ),
        ("/rows/0/narration_plan/beats", serde_json::json!([null])),
        ("/rows/0/motion_plan/keyframes", serde_json::json!([null])),
        ("/rows/0/motion_points", serde_json::json!([null])),
        ("/rows/0/typing_spots", serde_json::json!([null])),
    ] {
        let mut malformed = valid.clone();
        *malformed.pointer_mut(pointer).unwrap() = value;
        assert!(
            serde_json::from_value::<Sketch>(malformed).is_err(),
            "null entries must not be discarded at {pointer}"
        );
    }
}

#[test]
fn planning_row_roundtrips_narration_plan() {
    let mut row = PlanningRow::new();
    row.narration_plan = Some(NarrationPlan {
        source_text: "CutReady keeps the story moving.".into(),
        voice: "en-US-AvaMultilingualNeural".into(),
        locale: "en-US".into(),
        ssml: "<speak><voice name=\"en-US-AvaMultilingualNeural\">CutReady keeps the story moving.</voice></speak>".into(),
        baseline_style: Some("narration-professional".into()),
        pronunciation_overrides: [("CutReady".into(), "cut ready".into())].into_iter().collect(),
        beats: vec![NarrationBeat {
            text: "story moving".into(),
            purpose: Some("payoff".into()),
            style: Some("excited".into()),
            style_degree: Some(1.1),
            emphasis: Some("moderate".into()),
            pause_after_ms: Some(250),
        }],
        generated_at: test_now(),
    });

    let serialized = serde_json::to_value(&row).unwrap();
    let parsed: PlanningRow = serde_json::from_value(serialized).unwrap();
    let plan = parsed.narration_plan.unwrap();
    assert_eq!(
        plan.baseline_style.as_deref(),
        Some("narration-professional")
    );
    assert_eq!(
        plan.pronunciation_overrides
            .get("CutReady")
            .map(String::as_str),
        Some("cut ready")
    );
    assert_eq!(plan.beats[0].pause_after_ms, Some(250));
}

#[test]
fn planning_row_roundtrip() {
    let row = PlanningRow {
        id: String::new(),
        locked: false,
        locks: PlanningCellLocks::default(),
        time: "~30s".into(),
        duration_seconds: Some(30),
        narrative: "Click the sign-up button".into(),
        demo_actions: "Navigate to /signup, click CTA".into(),
        demo_steps: Vec::new(),
        screenshot: Some("screenshots/step1.png".into()),
        visual: None,
        motion_points: vec![MotionPoint {
            rank: 1,
            x: 0.62,
            y: 0.41,
            label: Some("Primary CTA".into()),
        }],
        typing_spots: vec![TypingSpot {
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.1,
            text: "Create a workspace".into(),
            start_offset_ms: Some(200),
            duration_ms: Some(1_500),
            characters_per_second: Some(18.0),
            show_cursor: Some(true),
            text_color: Some("#ffffff".into()),
            font_family: Some("sans".into()),
            font_scale: Some(1.0),
        }],
        motion_plan: Some(MotionPlan {
            kind: MotionPlanKind::SubtlePush,
            keyframes: vec![
                MotionPlanKeyframe {
                    time_ms: 0,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::EaseOut),
                },
                MotionPlanKeyframe {
                    time_ms: 2_000,
                    scale: 1.16,
                    x: 0.62,
                    y: 0.41,
                    easing: Some(MotionPlanEasing::EaseOut),
                },
            ],
            rationale: Some("Push toward the primary CTA.".into()),
        }),
        framing_beats: Vec::new(),
        design_plan: None,
        narration: None,
        narration_plan: None,
        unknown_fields: Default::default(),
    };
    let json = serde_json::to_string(&row).unwrap();
    let parsed: PlanningRow = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.time, "~30s");
    assert_eq!(parsed.duration_seconds, Some(30));
    assert_eq!(parsed.screenshot, Some("screenshots/step1.png".into()));
    assert_eq!(parsed.motion_points.len(), 1);
    assert_eq!(parsed.typing_spots.len(), 1);
    assert_eq!(parsed.typing_spots[0].text, "Create a workspace");
    assert_eq!(
        parsed.motion_points[0].label.as_deref(),
        Some("Primary CTA")
    );
    assert_eq!(
        parsed.motion_plan.as_ref().map(|plan| &plan.kind),
        Some(&MotionPlanKind::SubtlePush)
    );
}

#[test]
fn planning_row_default_matches_new() {
    let from_new = PlanningRow::new();
    let from_default = PlanningRow::default();
    assert_eq!(from_new.time, from_default.time);
    assert_eq!(from_new.locked, from_default.locked);
    assert_eq!(from_new.locks, from_default.locks);
    assert_eq!(from_new.narrative, from_default.narrative);
    assert_eq!(from_new.demo_actions, from_default.demo_actions);
    assert_eq!(from_new.screenshot, from_default.screenshot);
}

#[test]
fn sketch_summary_from_sketch() {
    let mut sketch = Sketch::new("Summary Test", test_now());
    sketch.rows.push(PlanningRow::new());
    sketch.rows.push(PlanningRow::new());
    let summary = SketchSummary::from_sketch(&sketch, "test.sk");
    assert_eq!(summary.path, "test.sk");
    assert_eq!(summary.title, sketch.title);
    assert_eq!(summary.state, SketchState::Draft);
    assert_eq!(summary.row_count, 2);
}

#[test]
fn sketch_summary_roundtrip() {
    let sketch = Sketch::new("Roundtrip", test_now());
    let summary = SketchSummary::from_sketch(&sketch, "roundtrip.sk");
    let json = serde_json::to_string(&summary).unwrap();
    let parsed: SketchSummary = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.path, "roundtrip.sk");
    assert_eq!(parsed.title, summary.title);
}

#[test]
fn storyboard_new_defaults() {
    let sb = Storyboard::new("Product Demo", test_now());
    assert_eq!(sb.title, "Product Demo");
    assert!(sb.description.is_empty());
    assert!(!sb.locked);
    assert!(sb.items.is_empty());
}

#[test]
fn storyboard_with_items_roundtrip() {
    let sb = Storyboard {
        title: "Full Demo".into(),
        description: "End-to-end product demo".into(),
        locked: false,
        metadata: DocumentMetadata::default(),
        items: vec![
            StoryboardItem::SketchRef {
                path: "intro.sk".into(),
            },
            StoryboardItem::Section {
                title: "Getting Started".into(),
                description: "Connect the first flow.".into(),
                sketches: vec!["setup.sk".into(), "first-run.sk".into()],
            },
        ],
        created_at: test_now(),
        updated_at: test_now(),
        unknown_fields: Default::default(),
    };

    let json = serde_json::to_string_pretty(&sb).unwrap();
    let parsed: Storyboard = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.title, "Full Demo");
    assert_eq!(parsed.items.len(), 2);

    match &parsed.items[0] {
        StoryboardItem::SketchRef { path } => assert_eq!(path, "intro.sk"),
        _ => panic!("Expected SketchRef"),
    }
    match &parsed.items[1] {
        StoryboardItem::Section {
            title,
            description,
            sketches,
        } => {
            assert_eq!(title, "Getting Started");
            assert_eq!(description, "Connect the first flow.");
            assert_eq!(sketches.len(), 2);
            assert_eq!(sketches[0], "setup.sk");
        }
        _ => panic!("Expected Section"),
    }
}

#[test]
fn storyboard_item_tagged_serde() {
    let item = StoryboardItem::SketchRef {
        path: "test.sk".into(),
    };
    let json = serde_json::to_string(&item).unwrap();
    assert!(json.contains("\"type\":\"sketch_ref\""));
    assert!(json.contains("\"path\":\"test.sk\""));

    let item = StoryboardItem::Section {
        title: "Intro".into(),
        description: String::new(),
        sketches: vec![],
    };
    let json = serde_json::to_string(&item).unwrap();
    assert!(json.contains("\"type\":\"section\""));
}

#[test]
fn storyboard_summary_from_storyboard() {
    let mut sb = Storyboard::new("Test", test_now());
    sb.items.push(StoryboardItem::SketchRef {
        path: "a.sk".into(),
    });
    sb.items.push(StoryboardItem::Section {
        title: "Core".into(),
        description: String::new(),
        sketches: vec!["b.sk".into(), "c.sk".into()],
    });

    let summary = StoryboardSummary::from_storyboard(&sb, "test.sb");
    assert_eq!(summary.path, "test.sb");
    assert_eq!(summary.title, "Test");
    assert!(!summary.locked);
    assert_eq!(summary.sketch_count, 3);
}

#[test]
fn storyboard_summary_roundtrip() {
    let sb = Storyboard::new("Roundtrip", test_now());
    let summary = StoryboardSummary::from_storyboard(&sb, "roundtrip.sb");
    let json = serde_json::to_string(&summary).unwrap();
    let parsed: StoryboardSummary = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.path, "roundtrip.sb");
    assert_eq!(parsed.sketch_count, 0);
}

#[test]
fn storyboard_legacy_sketches_field_converts_to_items() {
    let json = r#"{
        "title": "Legacy Board",
        "description": "Old shape",
        "sketches": ["intro.sk", "demo.sk"],
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z"
    }"#;

    let (storyboard, upgraded) = Storyboard::from_json_upgraded(json).unwrap();

    assert!(upgraded);
    assert_eq!(storyboard.title, "Legacy Board");
    assert_eq!(storyboard.sketch_paths(), vec!["intro.sk", "demo.sk"]);
    assert_eq!(storyboard.sketch_count(), 2);
    assert!(storyboard.references_sketch("demo.sk"));
}

#[test]
fn storyboard_section_description_defaults_for_existing_sections() {
    let json = r#"{
        "type": "section",
        "title": "Observe",
        "sketches": ["performance.sk"]
    }"#;

    let item: StoryboardItem = serde_json::from_str(json).unwrap();

    match item {
        StoryboardItem::Section {
            title,
            description,
            sketches,
        } => {
            assert_eq!(title, "Observe");
            assert!(description.is_empty());
            assert_eq!(sketches, vec!["performance.sk"]);
        }
        _ => panic!("Expected Section"),
    }
}

#[test]
fn storyboard_removes_sketch_references_from_items_and_sections() {
    let now = test_now();
    let mut storyboard = Storyboard {
        title: "Demo".into(),
        description: String::new(),
        locked: false,
        metadata: DocumentMetadata::default(),
        items: vec![
            StoryboardItem::SketchRef {
                path: "intro.sk".into(),
            },
            StoryboardItem::SketchRef {
                path: "delete-me.sk".into(),
            },
            StoryboardItem::Section {
                title: "Build".into(),
                description: String::new(),
                sketches: vec![
                    "delete-me.sk".into(),
                    "keep-me.sk".into(),
                    "delete-me.sk".into(),
                ],
            },
        ],
        created_at: now,
        updated_at: now,
        unknown_fields: Default::default(),
    };

    let removed = storyboard.remove_sketch_references("delete-me.sk");

    assert_eq!(removed, 3);
    assert_eq!(storyboard.sketch_paths(), vec!["intro.sk", "keep-me.sk"]);
    assert!(!storyboard.references_sketch("delete-me.sk"));
}

#[test]
fn version_entry_roundtrip() {
    let entry = VersionEntry {
        id: "abc123".into(),
        message: "Add introduction section".into(),
        timestamp: test_now(),
        summary: "1 section added".into(),
    };
    let json = serde_json::to_string(&entry).unwrap();
    let parsed: VersionEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.id, "abc123");
    assert_eq!(parsed.message, "Add introduction section");
}

#[test]
fn sketch_backward_compat_missing_fields() {
    // Sketch JSON with missing rows/description should deserialize
    let json = r#"{
        "title": "Legacy Doc",
        "state": "sketch",
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z"
    }"#;
    let sketch: Sketch = serde_json::from_str(json).unwrap();
    assert_eq!(sketch.title, "Legacy Doc");
    assert_eq!(sketch.state, SketchState::Draft);
    assert!(sketch.rows.is_empty());
    assert_eq!(sketch.description, serde_json::Value::Null);
    assert!(!sketch.locked);
}

#[test]
fn planning_row_backward_compat_missing_locks() {
    let json = r#"{
        "time": "~30s",
        "narrative": "Say hello",
        "demo_actions": "Open the app",
        "screenshot": null
    }"#;
    let row: PlanningRow = serde_json::from_str(json).unwrap();
    assert!(!row.locked);
    assert!(!row.locks.any());
}

#[test]
fn planning_cell_locks_roundtrip() {
    let mut locks = PlanningCellLocks::default();
    assert!(locks.set("narrative", true));
    assert!(locks.is_locked("narrative"));
    assert!(!locks.is_locked("demo_actions"));
    assert!(!locks.set("unknown", true));

    let json = serde_json::to_string(&locks).unwrap();
    let parsed: PlanningCellLocks = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, locks);
}
