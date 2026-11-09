use super::*;
use cutready_core::models::sketch::{
    MotionPlan, MotionPlanEasing, MotionPlanKeyframe, MotionPlanKind, NarrationAsset, PlanningRow,
    Sketch, TypingSpot,
};
use image::{Rgb, RgbImage};
use tempfile::TempDir;

#[test]
fn slugify_returns_stable_file_safe_name() {
    assert_eq!(slugify("Demo: Login Flow!"), "demo-login-flow");
    assert_eq!(slugify("   "), "sketch");
}

#[test]
fn ffmpeg_failure_message_prefers_the_actionable_encoder_error() {
    let lines = [
        "Error opening output file C:\\demo\\row-001.mp4.",
        "Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0",
    ];

    assert_eq!(
        ffmpeg_failure_message(&lines),
        "Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0"
    );
}

#[test]
fn ffmpeg_filter_argument_finds_each_filter_form() {
    let args = vec![
        "-vf".to_string(),
        "scale=1920:1080".to_string(),
        "-af".to_string(),
        "aresample=48000".to_string(),
        "-filter_complex".to_string(),
        "[0:a]anull[a]".to_string(),
    ];

    assert_eq!(
        ffmpeg_filter_argument(&args, "-vf"),
        Some("scale=1920:1080")
    );
    assert_eq!(
        ffmpeg_filter_argument(&args, "-af"),
        Some("aresample=48000")
    );
    assert_eq!(
        ffmpeg_filter_argument(&args, "-filter_complex"),
        Some("[0:a]anull[a]")
    );
    assert_eq!(ffmpeg_filter_argument(&args, "-filter_script"), None);
}

#[test]
fn large_filter_arguments_are_written_to_temporary_scripts() {
    let filter = "null,".repeat(FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES / 4 + 1);
    let mut args = vec!["-vf".to_string(), filter.clone()];

    let scripts = offload_large_filter_arguments(&mut args, FilterFileSyntax::Legacy).unwrap();

    assert_eq!(args[0], "-filter_script:v");
    assert_eq!(scripts.len(), 1);
    assert_eq!(fs::read_to_string(&scripts[0]).unwrap(), filter);
}

#[test]
fn large_filter_arguments_use_generic_syntax_on_modern_ffmpeg() {
    let filter = "null,".repeat(FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES / 4 + 1);
    let mut args = vec!["-vf".to_string(), filter.clone()];

    let scripts = offload_large_filter_arguments(&mut args, FilterFileSyntax::Generic).unwrap();

    // FFmpeg 9.0 removed `-filter_script`, so modern builds must receive the
    // generic read-option-from-file flag instead.
    assert_eq!(args[0], "-/vf");
    assert_eq!(scripts.len(), 1);
    assert_eq!(fs::read_to_string(&scripts[0]).unwrap(), filter);
}

#[test]
fn ffmpeg_major_version_parses_release_and_distro_forms() {
    assert_eq!(
        parse_ffmpeg_major_version("ffmpeg version 9.0.1-full_build-www.gyan.dev\n"),
        Some(9)
    );
    assert_eq!(
        parse_ffmpeg_major_version("ffmpeg version 6.1.1 Copyright (c) 2000-2023\n"),
        Some(6)
    );
    assert_eq!(parse_ffmpeg_major_version("ffmpeg version n7.0\n"), Some(7));
    // Non-dotted git builds are unparseable and fall back to legacy.
    assert_eq!(
        parse_ffmpeg_major_version("ffmpeg version N-119000-gabc123\n"),
        None
    );
    assert_eq!(parse_ffmpeg_major_version("not ffmpeg output"), None);
}

#[test]
fn large_video_filter_script_runs_with_ffmpeg() {
    if ensure_ffmpeg_available().is_err() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let output_path = directory.path().join("filter-script.mkv");
    let filter = std::iter::repeat_n("null", FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES / 4 + 1)
        .collect::<Vec<_>>()
        .join(",");

    run_ffmpeg(vec![
        "-y".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "color=black:s=16x16:r=1".to_string(),
        "-vf".to_string(),
        filter,
        "-frames:v".to_string(),
        "1".to_string(),
        "-c:v".to_string(),
        DEFAULT_VIDEO_ENCODER.to_string(),
        "-crf".to_string(),
        DEFAULT_VIDEO_CRF.to_string(),
        "-pix_fmt".to_string(),
        DEFAULT_VIDEO_PIXEL_FORMAT.to_string(),
        output_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    assert!(output_path.is_file());
}

#[test]
fn typing_reveal_is_compressed_to_finish_within_the_row() {
    let (start, characters_per_second, end) =
        constrained_typing_timing(160, 7.0, None, 18.0, 3.0, 30);

    assert!(start < 3.0);
    assert!(characters_per_second > 18.0);
    assert!((start + 160.0 / characters_per_second - end).abs() < 0.000_001);
    assert_eq!(end, 3.0);
}

#[test]
fn typing_filters_reject_text_beyond_the_animation_limit() {
    let spot = TypingSpot {
        x: 0.2,
        y: 0.3,
        width: 0.4,
        height: 0.1,
        text: "x".repeat(MAX_TYPING_ANIMATION_CHARACTERS + 1),
        start_offset_ms: None,
        duration_ms: None,
        characters_per_second: None,
        show_cursor: None,
        text_color: None,
        font_family: None,
        font_scale: None,
    };

    let error = typing_spot_filters(&[spot], 3.0, false, &SketchVideoExportSettings::default())
        .err()
        .expect("typing text over the limit must be rejected");

    assert!(error.to_string().contains("up to 160 characters"));
}

#[test]
fn ffmpeg_expression_escapes_function_argument_delimiters() {
    let expression = FfmpegExpression::call(
        "if",
        [
            FfmpegExpression::call(
                "lte",
                [FfmpegExpression::raw("on"), FfmpegExpression::raw("60")],
            ),
            FfmpegExpression::call(
                "min",
                [
                    FfmpegExpression::call(
                        "max",
                        [FfmpegExpression::raw("on-0"), FfmpegExpression::raw("0")],
                    ),
                    FfmpegExpression::raw("1"),
                ],
            ),
            FfmpegExpression::raw("0.862069"),
        ],
    );

    assert_eq!(
        expression.to_string(),
        r"if(lte(on\,60)\,min(max(on-0\,0)\,1)\,0.862069)"
    );
}

#[test]
fn ffmpeg_filter_builder_serializes_labels_values_and_chains() {
    let text_path = ["font root", "demo's:font.txt"].iter().collect::<PathBuf>();
    let mut graph = FfmpegFilterGraph::new();
    graph.push_chain(FfmpegFilterChain::new([FfmpegFilter::new("drawtext")
        .input("0:v")
        .named("textfile", FfmpegValue::file_path(&text_path))
        .named(
            "enable",
            FfmpegExpression::call(
                "between",
                [
                    FfmpegExpression::raw("t"),
                    FfmpegExpression::raw("0"),
                    FfmpegExpression::call(
                        "min",
                        [FfmpegExpression::raw("3"), FfmpegExpression::raw("5")],
                    ),
                ],
            ),
        )
        .output("caption")]));
    graph.push_chain(FfmpegFilterChain::new([FfmpegFilter::new("anullsrc")
        .named("r", "48000")
        .named("cl", "stereo")
        .output("audio")]));

    assert_eq!(
        graph.render(),
        r"[0:v]drawtext=textfile='font root/demo\\'s\:font.txt':enable='between(t\,0\,min(3\,5))'[caption];anullsrc=r=48000:cl=stereo[audio]"
    );
}

#[test]
fn ffmpeg_filter_builder_escapes_apostrophes_through_the_filter_parser() {
    let filter = FfmpegFilterGraph::chain([
        FfmpegFilter::new("drawtext")
            .named("text", FfmpegValue::text("What's next?"))
            .named(
                "enable",
                FfmpegExpression::call(
                    "between",
                    [
                        FfmpegExpression::raw("t"),
                        FfmpegExpression::raw("0"),
                        FfmpegExpression::raw("1"),
                    ],
                ),
            ),
        FfmpegFilter::new("null"),
    ])
    .render();

    assert!(filter.contains(r"text='What\\'s next?'"));
    assert!(filter.contains(r"enable='between(t\,0\,1)',null"));
}

#[test]
fn typing_text_uses_a_safe_apostrophe_glyph() {
    assert_eq!(safe_drawtext_text("What's next?"), "What\u{2019}s next?");
}

#[test]
fn duration_is_clamped_and_formatted_for_ffmpeg() {
    assert_eq!(format_duration(2.5), "2.500");
    assert_eq!(format_duration(0.0), "0.100");
    assert_eq!(format_seconds(0.0), "0.000");
}

#[test]
fn video_export_settings_default_to_including_title_card() {
    let settings: SketchVideoExportSettings = serde_json::from_str("{}").unwrap();
    assert!(settings.include_title_card);

    let settings: SketchVideoExportSettings =
        serde_json::from_str(r#"{"includeTitleCard":false}"#).unwrap();
    assert!(!settings.normalized().include_title_card);
}

#[test]
fn background_music_filter_loops_ducks_and_fades_music() {
    let settings = SketchVideoExportSettings {
        background_music_volume_db: -18.0,
        background_music_duck_narration: true,
        background_music_fade_seconds: 0.75,
        ..SketchVideoExportSettings::default()
    }
    .normalized();
    let filter = background_music_filter("12.000".to_string(), 0.75, 11.25, &settings);

    assert!(filter.contains("atrim=0:12.000"));
    assert!(filter.contains("volume=-18dB"));
    assert!(filter.contains("afade=t=in:st=0:d=0.750"));
    assert!(filter.contains("afade=t=out:st=11.250:d=0.750"));
    assert!(filter.contains("sidechaincompress"));
    assert!(filter.contains("amix=inputs=2:duration=first"));
}

#[test]
fn background_music_preview_duration_is_at_least_ten_seconds() {
    assert_eq!(background_music_preview_duration(Some(3.5), None), 10.0);
    assert_eq!(background_music_preview_duration(None, Some(8.0)), 10.0);
    assert_eq!(
        background_music_preview_duration(Some(12.25), Some(4.0)),
        12.25
    );
    assert_eq!(background_music_preview_duration(Some(90.0), None), 20.0);
}

#[test]
fn background_music_preview_uses_the_selected_cached_voice_sample() {
    let directory = tempfile::tempdir().unwrap();
    let voice_name = "en-US-Harper:MAI-Voice-2";
    let output_format = "riff-24khz-16bit-mono-pcm";
    let saved = narration_preview::save_voice_preview(
        directory.path(),
        voice_name,
        output_format,
        &[1, 2, 3],
    )
    .unwrap();
    let settings = BackgroundMusicPreviewSettings {
        background_music_path: "background-music/demo.wav".to_string(),
        narration_voice_name: voice_name.to_string(),
        narration_voice_output_format: output_format.to_string(),
        background_music_volume_db: -24.0,
        background_music_duck_narration: true,
        background_music_fade_seconds: 0.5,
    };

    let resolved = resolve_preview_narration_path(directory.path(), &settings).unwrap();

    assert_eq!(resolved.to_string_lossy(), saved);
}

#[test]
fn background_music_preview_filter_pads_short_narration() {
    let settings = SketchVideoExportSettings {
        background_music_duck_narration: true,
        ..SketchVideoExportSettings::default()
    }
    .normalized();
    let filter = background_music_preview_filter("10.000".to_string(), 1.0, 9.0, &settings);

    assert!(filter.contains("[0:a]apad,atrim=0:10.000"));
    assert!(filter.contains("[previewNarration]"));
    assert!(filter.contains("[music][previewNarration]sidechaincompress"));
    assert!(filter.contains("[previewNarration][ducked]amix=inputs=2:duration=first"));
}

#[test]
fn narration_audio_filter_uses_recorded_audio_without_loudness_treatment() {
    let unchanged = narration_audio_filter("0.500", "3.000", "3.350");
    assert!(!unchanged.contains("loudnorm"));
    assert_eq!(
        unchanged,
        "atrim=start=0.500:duration=3.000,asetpts=PTS-STARTPTS,apad,atrim=duration=3.350,aresample=48000,aformat=channel_layouts=stereo"
    );
}

#[test]
fn export_timeline_timing_keeps_row_content_and_transitions_separate() {
    let settings = SketchVideoExportSettings {
        title_card_duration_seconds: 3.0,
        title_to_first_row_hold_seconds: 0.5,
        row_transition_hold_seconds: 2.0,
        final_hold_seconds: 4.0,
        narration_tail_hold_seconds: 0.35,
        ..SketchVideoExportSettings::default()
    };
    let segments = vec![
        test_row_segment(1, 1.0, settings.narration_tail_hold_seconds),
        test_row_segment(2, 1.5, settings.narration_tail_hold_seconds),
    ];

    let timing = export_timeline_timing(&segments, &settings);

    assert_seconds(timing.title_card_seconds, 3.0);
    assert_seconds(timing.lead_in_seconds, 0.5);
    assert_seconds(timing.row_content_seconds, 3.2);
    assert_seconds(timing.interior_transition_seconds, 2.0);
    assert_seconds(timing.final_hold_seconds, 4.0);
    assert_seconds(timing.total_seconds(), 12.7);
}

#[test]
fn export_timeline_timing_preserves_terminal_narration_tail_without_terminal_transition() {
    let settings = SketchVideoExportSettings {
        include_title_card: false,
        title_to_first_row_hold_seconds: 0.5,
        row_transition_hold_seconds: 9.0,
        final_hold_seconds: 3.0,
        narration_tail_hold_seconds: 0.4,
        ..SketchVideoExportSettings::default()
    };
    let segments = vec![test_row_segment(
        1,
        2.0,
        settings.narration_tail_hold_seconds,
    )];

    let timing = export_timeline_timing(&segments, &settings);

    assert_seconds(row_content_duration_seconds(2.0, 0.0, &settings), 2.4);
    assert_seconds(segments[0].duration_seconds, 2.4);
    assert_seconds(timing.title_card_seconds, 0.0);
    assert_seconds(timing.lead_in_seconds, 0.5);
    assert_seconds(timing.row_content_seconds, 2.4);
    assert_seconds(timing.interior_transition_seconds, 0.0);
    assert_seconds(timing.final_hold_seconds, 3.0);
    assert_seconds(timing.total_seconds(), 5.9);
}

#[test]
fn row_content_duration_extends_to_resolved_demo_playback() {
    let settings = SketchVideoExportSettings {
        narration_tail_hold_seconds: 0.4,
        ..SketchVideoExportSettings::default()
    };

    assert_seconds(row_content_duration_seconds(2.0, 5.0, &settings), 5.4);
    assert_seconds(row_content_duration_seconds(5.0, 2.0, &settings), 5.4);
}

#[test]
fn narration_freshness_source_snapshot_blocks_export_before_media_probe() {
    let mut row = PlanningRow::new();
    row.narrative = "Updated narration".to_string();
    row.narration = Some(NarrationAsset {
        path: "missing.wav".to_string(),
        source_text: "Old narration".to_string(),
        source_text_hash: sha256_hex("Old narration"),
        narrative_text: Some("Old narration".to_string()),
        narrative_text_hash: Some(sha256_hex("Old narration")),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(250),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: 0,
        recorded_at: Utc::now(),
    });

    let error = validate_narration_fresh(1, &row, row.narration.as_ref().unwrap())
        .unwrap_err()
        .to_string();

    assert!(error.contains("Row 1 narration is stale"));
}

#[test]
fn narration_freshness_fingerprint_blocks_export_before_media_probe() {
    let mut row = PlanningRow::new();
    row.narrative = "Current narration".to_string();
    row.narration = Some(NarrationAsset {
        path: "missing.wav".to_string(),
        source_text: "Current narration".to_string(),
        source_text_hash: sha256_hex("Current narration"),
        narrative_text: Some("Current narration".to_string()),
        narrative_text_hash: Some(
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
        ),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(250),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: 0,
        recorded_at: Utc::now(),
    });

    let error = validate_narration_fresh(2, &row, row.narration.as_ref().unwrap())
        .unwrap_err()
        .to_string();

    assert!(error.contains("Row 2 narration fingerprint is stale"));
}

#[test]
fn narration_freshness_allows_rewritten_spoken_text_with_fresh_snapshot() {
    let mut row = PlanningRow::new();
    row.narrative = "Show the project dashboard.".to_string();
    row.narration = Some(NarrationAsset {
        path: "missing.wav".to_string(),
        source_text: "Now we can see the project dashboard.".to_string(),
        source_text_hash: sha256_hex("Now we can see the project dashboard."),
        narrative_text: Some("Show the project dashboard.".to_string()),
        narrative_text_hash: Some(sha256_hex("Show the project dashboard.")),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(250),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: 0,
        recorded_at: Utc::now(),
    });

    validate_narration_fresh(1, &row, row.narration.as_ref().unwrap()).unwrap();
}

#[test]
fn generated_resolved_demo_requires_screenshots_for_every_row() {
    let mut sketch = Sketch::new("Generated demo", chrono::Utc::now());
    let mut first = PlanningRow::new();
    first.screenshot = Some("screenshots/first.png".to_string());
    let mut second = PlanningRow::new();
    second.screenshot = Some("  ".to_string());
    sketch.rows = vec![first, second, PlanningRow::new()];

    assert_eq!(rows_missing_screenshots(&sketch), vec![2, 3]);
}

#[test]
fn load_resolved_demo_reads_project_relative_schema() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let schema_dir = root.join(".cutready").join("scenecast");
    std::fs::create_dir_all(&schema_dir).unwrap();
    std::fs::write(
        schema_dir.join("resolved-demo.json"),
        include_str!("../../fixtures/scenecast/resolved-demo.json"),
    )
    .unwrap();

    let demo = load_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 2).unwrap();

    assert_eq!(demo.demo.schema_version, "scenecast.resolved-demo.v1");
    assert_eq!(demo.demo.row_playback_duration_seconds(1), Some(1.25));
    assert_eq!(demo.demo.row_playback_duration_seconds(2), Some(1.0));
    assert_eq!(demo.asset_base_dir, schema_dir);
    assert!(load_resolved_demo(root, "../resolved-demo.json", 1).is_err());
}

#[test]
fn load_resolved_demo_rejects_unsupported_schema_version_before_typed_parse() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    std::fs::write(
        root.join("resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v2",
            "title": "Future shape"
        })
        .to_string(),
    )
    .unwrap();

    assert!(load_resolved_demo(root, "resolved-demo.json", 1)
        .unwrap_err()
        .to_string()
        .contains("Unsupported resolved demo schemaVersion"));
}

#[test]
fn inspect_resolved_demo_reports_row_coverage_and_assets() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let schema_dir = root.join(".cutready").join("scenecast");
    let captures_dir = schema_dir.join("captures");
    let frames_dir = schema_dir.join("frames");
    fs::create_dir_all(&captures_dir).unwrap();
    fs::create_dir_all(&frames_dir).unwrap();
    fs::write(captures_dir.join("row-1.png"), b"capture").unwrap();
    fs::write(frames_dir.join("row-1.png"), b"frame").unwrap();
    fs::write(
        schema_dir.join("resolved-demo.json"),
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
                    "targets": [],
                    "guideMarks": []
                },
                {
                    "id": "step-empty",
                    "order": 1,
                    "sceneId": "empty",
                    "title": "Empty",
                    "targets": [],
                    "guideMarks": []
                }
            ],
            "segments": [{
                "id": "segment-start",
                "kind": "scene",
                "stepId": "step-start",
                "startMs": 0,
                "durationMs": 250,
                "endMs": 250,
                "capture": { "path": "captures/stale.png" },
                "interaction": null,
                "frames": [{ "path": "frames/row-1.png", "durationMs": 250 }],
                "waitMs": 0
            }],
            "diagnostics": [{
                "severity": "warning",
                "code": "demo_note",
                "message": "Informational warning"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let inspection =
        inspect_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 2, None).unwrap();

    assert!(inspection.can_export);
    assert_eq!(inspection.title, "Demo");
    assert_eq!(inspection.diagnostic_count, 1);
    assert_eq!(inspection.rows.len(), 2);
    assert_eq!(inspection.rows[0].step_count, 1);
    assert_eq!(inspection.rows[0].segment_count, 1);
    assert_eq!(inspection.rows[0].media_asset_count, 1);
    assert_eq!(inspection.rows[0].missing_asset_count, 0);
    assert_eq!(inspection.rows[0].invalid_asset_count, 0);
    assert_eq!(inspection.rows[0].steps.len(), 1);
    assert_eq!(inspection.rows[0].steps[0].title, "Start");
    assert_eq!(inspection.rows[0].steps[0].segment_kinds, vec!["scene"]);
    assert_seconds(inspection.rows[0].duration_seconds.unwrap(), 0.25);
    assert_eq!(inspection.rows[1].step_count, 1);
    assert_eq!(inspection.rows[1].segment_count, 0);
    assert_eq!(inspection.rows[1].duration_seconds, None);
    assert_eq!(inspection.rows[1].media_asset_count, 0);
    assert_eq!(inspection.rows[1].steps[0].title, "Empty");
}

#[test]
fn inspect_resolved_demo_returns_blocking_diagnostic_as_data() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    fs::write(
        root.join("resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [],
            "segments": [],
            "diagnostics": [{
                "severity": "error",
                "code": "missing_scene",
                "message": "Scene could not be resolved"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let inspection = inspect_resolved_demo(root, "resolved-demo.json", 1, None).unwrap();

    assert!(!inspection.can_export);
    assert!(inspection
        .blocking_error
        .as_deref()
        .unwrap()
        .contains("missing_scene"));
    assert_eq!(inspection.diagnostics[0].severity, "error");
}

#[test]
fn inspect_resolved_demo_reports_stale_cutready_row_mapping() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    fs::write(
        root.join("resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [{
                "id": "step-row-a",
                "order": 0,
                "sceneId": crate::models::resolved_demo::cutready_row_scene_id("row-a"),
                "title": "Start",
                "targets": [],
                "guideMarks": []
            }],
            "segments": [{
                "id": "segment-row-a",
                "kind": "scene",
                "stepId": "step-row-a",
                "startMs": 0,
                "durationMs": 1000,
                "endMs": 1000,
                "capture": null,
                "interaction": null,
                "frames": [],
                "waitMs": 0
            }],
            "diagnostics": []
        })
        .to_string(),
    )
    .unwrap();

    let inspection =
        inspect_resolved_demo(root, "resolved-demo.json", 1, Some(&["row-b".to_string()])).unwrap();

    assert!(!inspection.can_export);
    assert!(inspection
        .blocking_error
        .as_deref()
        .unwrap()
        .contains("regenerate the resolved demo"));
}

#[test]
fn resolved_demo_media_becomes_manifest_relative_frame_sequence() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let schema_dir = root.join(".cutready").join("scenecast");
    let frames_dir = schema_dir.join("frames");
    let captures_dir = schema_dir.join("captures");
    fs::create_dir_all(&frames_dir).unwrap();
    fs::create_dir_all(&captures_dir).unwrap();
    fs::write(frames_dir.join("open.png"), b"frame").unwrap();
    fs::write(frames_dir.join("settled.png"), b"frame").unwrap();
    fs::write(captures_dir.join("terminal.png"), b"frame").unwrap();
    fs::write(
        schema_dir.join("resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [{
                "id": "step-start",
                "order": 0,
                "sceneId": "start",
                "title": "Start",
                "targets": [],
                "guideMarks": []
            }],
            "segments": [
                {
                    "id": "segment-open",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 0,
                    "durationMs": 100,
                    "endMs": 100,
                    "capture": null,
                    "interaction": null,
                    "frames": [
                        { "path": "frames/open.png", "durationMs": 100 },
                        { "path": "frames/settled.png", "durationMs": 200 }
                    ],
                    "waitMs": 0
                },
                {
                    "id": "segment-terminal",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 100,
                    "durationMs": 300,
                    "endMs": 400,
                    "capture": { "path": "captures/terminal.png" },
                    "interaction": null,
                    "frames": [],
                    "waitMs": 0
                }
            ],
            "diagnostics": []
        })
        .to_string(),
    )
    .unwrap();

    let loaded = load_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 1).unwrap();
    let sequence = resolved_demo_frame_sequence_for_row(&loaded, 1, 1.2, 10)
        .unwrap()
        .expect("resolved demo row media should create a frame sequence");

    assert_eq!(sequence.frames.len(), 3);
    assert_eq!(sequence.frames[0].path, frames_dir.join("open.png"));
    assert_seconds(sequence.frames[0].duration_seconds, 0.1);
    assert_eq!(sequence.frames[1].path, frames_dir.join("settled.png"));
    assert_seconds(sequence.frames[1].duration_seconds, 0.2);
    assert_eq!(sequence.frames[2].path, captures_dir.join("terminal.png"));
    assert_seconds(sequence.frames[2].duration_seconds, 0.9);
    match sequence.fit {
        FrameSequenceFit::Held { hold_seconds } => assert_seconds(hold_seconds, 0.9),
        fit => panic!("expected held frame sequence, got {fit:?}"),
    }
}

#[test]
fn resolved_demo_media_requires_existing_safe_assets() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let schema_dir = root.join(".cutready").join("scenecast");
    fs::create_dir_all(&schema_dir).unwrap();
    fs::write(
        schema_dir.join("resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [{
                "id": "step-start",
                "order": 0,
                "sceneId": "start",
                "title": "Start",
                "targets": [],
                "guideMarks": []
            }],
            "segments": [{
                "id": "segment-start",
                "kind": "scene",
                "stepId": "step-start",
                "startMs": 0,
                "durationMs": 100,
                "endMs": 100,
                "capture": { "path": "captures/missing.png" },
                "interaction": null,
                "frames": [],
                "waitMs": 0
            }],
            "diagnostics": []
        })
        .to_string(),
    )
    .unwrap();

    let loaded = load_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 1).unwrap();
    assert!(resolved_demo_frame_sequence_for_row(&loaded, 1, 1.0, 10)
        .unwrap_err()
        .to_string()
        .contains("Resolved demo asset does not exist"));
}

#[test]
fn load_visual_frame_sequence_accepts_manifest_relative_sparse_paths() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let export_dir = root.join(".cutready").join("visuals").join("hero-export");
    let frames_dir = export_dir.join("frames");
    std::fs::create_dir_all(&frames_dir).unwrap();
    std::fs::write(frames_dir.join("open-state.png"), b"not decoded by loader").unwrap();
    std::fs::write(frames_dir.join("zoomed-end.png"), b"not decoded by loader").unwrap();
    std::fs::write(
        export_dir.join("manifest.json"),
        serde_json::json!({
            "frames": [
                { "path": "frames/open-state.png", "duration_ms": 100, "terminal": false },
                { "path": "frames/zoomed-end.png", "duration_ms": 0, "terminal": true }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let plan =
        load_visual_frame_sequence(root, ".cutready/visuals/hero-export/manifest.json", 0.3, 10)
            .unwrap();

    assert_eq!(plan.frames.len(), 2);
    assert_seconds(plan.frames[0].duration_seconds, 0.1);
    assert_seconds(plan.frames[1].duration_seconds, 0.2);
    assert!(plan.frames[0].path.ends_with("frames/open-state.png"));
    assert!(load_visual_frame_sequence(root, "../manifest.json", 0.3, 10).is_err());
}

#[test]
fn planned_frame_counts_preserve_total_for_sub_100ms_frames() {
    let plan = FrameSequencePlan {
        frames: vec![
            crate::engine::frame_sequence::PlannedFrame {
                path: PathBuf::from("intro.png"),
                duration_seconds: 0.017,
            },
            crate::engine::frame_sequence::PlannedFrame {
                path: PathBuf::from("open.png"),
                duration_seconds: 0.017,
            },
            crate::engine::frame_sequence::PlannedFrame {
                path: PathBuf::from("rest.png"),
                duration_seconds: 0.066,
            },
        ],
        total_seconds: 0.1,
        fit: FrameSequenceFit::Held {
            hold_seconds: 0.066,
        },
    };

    let counts = planned_frame_counts(&plan, 60).unwrap();

    assert_eq!(counts, vec![1, 1, 4]);
    assert_eq!(counts.iter().sum::<u32>(), 6);
}

#[test]
fn planned_frame_counts_keep_a_coalesced_gesture_at_its_recorded_length() {
    // 8ms samples at 30fps coalesce to ~40ms steps; per-step rounding used to shrink the gesture.
    let manifest = (0..120)
        .map(|index| crate::engine::frame_sequence::FrameManifestEntry {
            path: PathBuf::from(format!("frame-{index:03}.png")),
            duration_ms: if index == 119 { 0 } else { 8 },
            terminal: index == 119,
        })
        .collect::<Vec<_>>();
    let gesture_seconds = 119.0 * 0.008;
    let plan = crate::engine::frame_sequence::plan_frame_sequence(&manifest, 2.0, 30).unwrap();

    let counts = planned_frame_counts(&plan, 30).unwrap();

    let gesture_frames: u32 = counts[..counts.len() - 1].iter().sum();
    assert!(
        (f64::from(gesture_frames) / 30.0 - gesture_seconds).abs() <= 1.0 / 30.0,
        "gesture encoded as {gesture_frames} frames"
    );
    assert_eq!(counts.iter().sum::<u32>(), 60);
}

#[test]
fn hold_video_filter_adds_dip_to_black_for_row_transitions() {
    let settings = SketchVideoExportSettings::default();
    let fade_out = FfmpegFilterGraph::chain(hold_video_filters(
        vec![FfmpegFilter::new("base")],
        0.5,
        HoldTransition::FadeOutToBlack,
        &settings,
    ))
    .render();
    assert_eq!(fade_out, "base,fade=t=out:st=0.150:d=0.350:color=black");

    let fade_in = FfmpegFilterGraph::chain(hold_video_filters(
        vec![FfmpegFilter::new("base")],
        0.5,
        HoldTransition::FadeInFromBlack,
        &settings,
    ))
    .render();
    assert_eq!(fade_in, "base,fade=t=in:st=0:d=0.350:color=black");

    let unchanged = FfmpegFilterGraph::chain(hold_video_filters(
        vec![FfmpegFilter::new("base")],
        3.0,
        HoldTransition::None,
        &settings,
    ))
    .render();
    assert_eq!(unchanged, "base");
}

#[test]
fn motion_image_video_filter_renders_zoompan_from_keyframes() {
    let plan = MotionPlan {
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
        rationale: None,
    };

    let settings = SketchVideoExportSettings::default();
    let end_crop = motion_crop_rect(&plan.keyframes[1], settings.motion_max_scale);
    assert!((end_crop.width - 0.862069).abs() < 0.000001);
    assert!((end_crop.x - 0.137931).abs() < 0.000001);
    assert_eq!(end_crop.y, 0.0);

    let filter = motion_image_video_filter(&plan, &[], 3.0, &settings).unwrap();
    assert!(filter.contains("zoompan=z='1/(if(lte(on\\,60)\\,1.000000+((0.862069-1.000000)*(min(max(on-0\\,0)/60\\,1)))\\,0.862069))'"));
    assert!(filter.contains(":x='iw*(if(lte(on\\,60)\\,"));
    assert!(filter.contains(":y='ih*(if(lte(on\\,60)\\,"));
    assert!(filter.contains("d=90"));
}

#[test]
fn typing_spots_render_before_zoompan_with_incremental_text() {
    let plan = MotionPlan {
        kind: MotionPlanKind::SubtlePush,
        keyframes: vec![
            MotionPlanKeyframe {
                time_ms: 0,
                scale: 1.0,
                x: 0.5,
                y: 0.5,
                easing: Some(MotionPlanEasing::Linear),
            },
            MotionPlanKeyframe {
                time_ms: 1_000,
                scale: 1.2,
                x: 0.6,
                y: 0.4,
                easing: Some(MotionPlanEasing::Linear),
            },
        ],
        rationale: None,
    };
    let spots = [TypingSpot {
        x: 0.2,
        y: 0.3,
        width: 0.4,
        height: 0.1,
        text: "Go".into(),
        start_offset_ms: Some(500),
        duration_ms: None,
        characters_per_second: Some(10.0),
        show_cursor: Some(true),
        text_color: Some("#ffcc00".into()),
        font_family: Some("mono".into()),
        font_scale: Some(1.2),
    }];

    let filter =
        motion_image_video_filter(&plan, &spots, 2.0, &SketchVideoExportSettings::default())
            .unwrap();

    assert!(filter.contains("text='G|'"));
    assert!(filter.contains("text='Go|'"));
    assert!(filter.contains("fontcolor=0xffcc00"));
    match typing_spot_fontfile(Some("mono")) {
        Some(font) => assert!(filter.contains(&format!(
            "fontfile={}",
            FfmpegValue::font_path(font).render()
        ))),
        None => assert!(!filter.contains("fontfile=")),
    }
    assert!(filter.contains("between(t\\,0.500\\,0.600)"));
    assert!(filter.contains("between(t\\,0.600\\,2.000)"));
    assert!(filter.contains("x='w*0.206250'"));
    assert!(filter.contains("y='h*0.307407+ascent'"));
    assert!(!filter.contains("box="));
    assert!(!filter.contains("boxcolor="));
    assert!(filter.find("drawtext=").unwrap() < filter.find("zoompan=").unwrap());

    let completed = FfmpegFilterGraph::chain(
        still_image_video_filters(&spots, 2.0, true, &SketchVideoExportSettings::default())
            .unwrap(),
    )
    .render();
    assert!(completed.contains("text='Go'"));
    assert!(!completed.contains("text='G|'"));
    assert!(!completed.contains("enable="));
}

#[test]
fn motion_image_video_filter_preserves_intermediate_keyframes() {
    let plan = MotionPlan {
        kind: MotionPlanKind::WideHoldThenPush,
        keyframes: vec![
            MotionPlanKeyframe {
                time_ms: 0,
                scale: 1.0,
                x: 0.5,
                y: 0.5,
                easing: Some(MotionPlanEasing::Linear),
            },
            MotionPlanKeyframe {
                time_ms: 1_000,
                scale: 1.0,
                x: 0.5,
                y: 0.5,
                easing: Some(MotionPlanEasing::Linear),
            },
            MotionPlanKeyframe {
                time_ms: 2_000,
                scale: 1.16,
                x: 0.62,
                y: 0.41,
                easing: Some(MotionPlanEasing::Linear),
            },
        ],
        rationale: None,
    };

    let settings = SketchVideoExportSettings::default();
    let filter = motion_image_video_filter(&plan, &[], 3.0, &settings).unwrap();
    assert!(filter.contains("if(lte(on\\,30)\\,"));
    assert!(filter.contains("if(lte(on\\,60)\\,"));
    assert!(filter.contains("min(max(on-30\\,0)/30\\,1)"));
}

#[test]
fn motion_final_frame_filter_holds_last_camera_position() {
    let plan = MotionPlan {
        kind: MotionPlanKind::SubtlePush,
        keyframes: vec![
            MotionPlanKeyframe {
                time_ms: 0,
                scale: 1.0,
                x: 0.5,
                y: 0.5,
                easing: Some(MotionPlanEasing::Linear),
            },
            MotionPlanKeyframe {
                time_ms: 2_000,
                scale: 1.16,
                x: 0.62,
                y: 0.41,
                easing: Some(MotionPlanEasing::Linear),
            },
        ],
        rationale: None,
    };

    let settings = SketchVideoExportSettings::default();
    let end_crop = motion_crop_rect(&plan.keyframes[1], settings.motion_max_scale);
    assert!((end_crop.width - 0.862069).abs() < 0.000001);
    assert!((end_crop.x - 0.137931).abs() < 0.000001);
    assert_eq!(end_crop.y, 0.0);

    let filter = motion_final_frame_video_filter(&plan, &[], &settings).unwrap();
    assert!(filter.contains("zoompan=z='1/0.862069'"));
    assert!(filter.contains(":x='iw*("));
    assert!(filter.contains(":y='ih*(0.000000)'"));
}

#[test]
fn motion_crop_rect_allows_deeper_pushes() {
    let keyframe = MotionPlanKeyframe {
        time_ms: 1_000,
        scale: 1.65,
        x: 0.5,
        y: 0.5,
        easing: Some(MotionPlanEasing::Linear),
    };

    let settings = SketchVideoExportSettings::default();
    let crop = motion_crop_rect(&keyframe, settings.motion_max_scale);
    assert!((crop.width - 0.606061).abs() < 0.000001);
    assert!((crop.x - 0.196970).abs() < 0.000001);
    assert!((crop.y - 0.196970).abs() < 0.000001);
}

#[test]
fn effective_source_duration_uses_longer_probe_result() {
    assert_eq!(
        effective_source_duration_seconds(Some(2.0), Some(2.4)),
        Some(2.4)
    );
    assert_eq!(
        effective_source_duration_seconds(Some(2.4), Some(2.0)),
        Some(2.4)
    );
    assert_eq!(
        effective_source_duration_seconds(Some(2.0), None),
        Some(2.0)
    );
    assert_eq!(
        effective_source_duration_seconds(Some(0.0), Some(f64::NAN)),
        None
    );
}

#[test]
fn effective_narration_timing_trims_silence_metadata() {
    let (start, duration) = effective_narration_timing(5.0, Some(700), Some(1200));
    assert_eq!(format_seconds(start), "0.700");
    assert_eq!(format_duration(duration), "3.100");
}

#[test]
fn effective_narration_timing_preserves_full_audio_with_zero_silence_metadata() {
    let (start, duration) = effective_narration_timing(5.0, Some(0), Some(0));
    assert_eq!(format_seconds(start), "0.000");
    assert_eq!(format_duration(duration), "5.000");
}

#[test]
fn effective_narration_timing_keeps_a_minimum_span_when_silence_overlaps() {
    let (start, duration) = effective_narration_timing(1.0, Some(900), Some(900));
    assert_eq!(format_seconds(start), "0.900");
    assert_eq!(format_duration(duration), "0.100");
}

#[test]
fn description_text_extracts_rich_text_without_node_type_names() {
    let value = serde_json::json!([
        {
            "type": "paragraph",
            "children": [
                { "text": "A crisp product demo" },
                { "text": " from sketch rows." }
            ]
        }
    ]);

    assert_eq!(
        description_text(&value),
        "A crisp product demo from sketch rows."
    );
}

#[test]
fn title_card_filter_includes_escaped_title_and_description() {
    let mut sketch = Sketch::new("Demo: Export, Now 100%", chrono::Utc::now());
    sketch.description = serde_json::json!([{ "type": "paragraph", "children": [{ "text": "Direction's script, A [B]" }] }]);

    let settings = SketchVideoExportSettings::default();
    let filter = title_card_filter(&sketch, &settings);
    assert!(filter.contains("drawtext=text='Demo\\: Export\\, Now 100\\%'"));
    assert!(filter.contains("text='Direction’s script\\, A \\[B\\]'"));
    assert!(!filter.contains("paragraph"));
}

#[test]
fn ffmpeg_filter_builder_escapes_filter_safe_paths() {
    let path = ["font root", "demo's:font.ttf"].iter().collect::<PathBuf>();
    assert_eq!(
        FfmpegValue::file_path(&path).render(),
        r"'font root/demo\\'s\:font.ttf'"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn ffmpeg_filter_builder_keeps_windows_drive_prefix() {
    assert_eq!(
        FfmpegValue::file_path(Path::new(r"C:\cutready\rko\title-card.txt")).render(),
        r"'C\:/cutready/rko/title-card.txt'"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn ffmpeg_filter_builder_strips_windows_font_drive_prefix() {
    assert_eq!(
        FfmpegValue::font_path(Path::new(r"C:\Windows\Fonts\segoeui.ttf")).render(),
        r"'/Windows/Fonts/segoeui.ttf'"
    );
}

#[test]
fn export_sketch_video_combines_typing_camera_motion_and_audio_when_ffmpeg_is_available() {
    if ensure_ffmpeg_available().is_err() {
        eprintln!("Skipping sketch video export smoke test because FFmpeg is unavailable");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
    fs::create_dir_all(root.join(".cutready/narration")).unwrap();

    let screenshot_path = root.join(".cutready/screenshots/row-1.png");
    RgbImage::from_pixel(320, 180, Rgb([120, 90, 200]))
        .save(&screenshot_path)
        .unwrap();

    let narration_path = root.join(".cutready/narration/row-1.wav");
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=440:duration=0.25".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        narration_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    let mut sketch = Sketch::new("Tiny Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = Some(".cutready/screenshots/row-1.png".to_string());
    row.typing_spots = vec![TypingSpot {
        x: 0.2,
        y: 0.25,
        width: 0.5,
        height: 0.12,
        text: "What's next?".to_string(),
        start_offset_ms: Some(0),
        duration_ms: None,
        characters_per_second: Some(24.0),
        show_cursor: Some(true),
        text_color: Some("#ffffff".to_string()),
        font_family: Some("sans".to_string()),
        font_scale: Some(1.0),
    }];
    row.motion_plan = Some(MotionPlan {
        kind: MotionPlanKind::SubtlePush,
        keyframes: vec![
            MotionPlanKeyframe {
                time_ms: 0,
                scale: 1.0,
                x: 0.5,
                y: 0.5,
                easing: Some(MotionPlanEasing::Linear),
            },
            MotionPlanKeyframe {
                time_ms: 250,
                scale: 1.1,
                x: 0.55,
                y: 0.45,
                easing: Some(MotionPlanEasing::Linear),
            },
        ],
        rationale: None,
    });
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: ".cutready/narration/row-1.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(250),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: narration_path.metadata().unwrap().len(),
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("tiny.sk"), root).unwrap();

    let export = export_sketch_video(root, "tiny.sk", None).unwrap();
    assert_eq!(export.row_count, 1);
    let output = PathBuf::from(&export.path);
    assert!(output.starts_with(root.join("exports")));
    assert!(output
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with("tiny-export-") && name.ends_with(".mp4")));
    assert!(output.is_file());
    assert!(output.metadata().unwrap().len() > 0);
}

#[test]
fn export_sketch_video_uses_requested_absolute_output_when_ffmpeg_is_available() {
    if ensure_ffmpeg_available().is_err() {
        eprintln!("Skipping sketch video export smoke test because FFmpeg is unavailable");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
    fs::create_dir_all(root.join(".cutready/narration")).unwrap();

    let screenshot_path = root.join(".cutready/screenshots/row-1.png");
    RgbImage::from_pixel(320, 180, Rgb([90, 120, 200]))
        .save(&screenshot_path)
        .unwrap();

    let narration_path = root.join(".cutready/narration/row-1.wav");
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=330:duration=0.25".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        narration_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    let mut sketch = Sketch::new("Custom Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = Some(".cutready/screenshots/row-1.png".to_string());
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: ".cutready/narration/row-1.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(250),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: narration_path.metadata().unwrap().len(),
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("custom.sk"), root).unwrap();

    let output_path = temp_dir.path().join("outside-project-custom-name.mp4");
    let export = export_sketch_video(root, "custom.sk", Some(output_path.as_path())).unwrap();
    assert_eq!(export.path, output_path.to_string_lossy().to_string());
    assert!(output_path.is_file());
}

#[test]
fn export_sketch_video_renders_visual_frame_manifest_duration() {
    if ensure_ffmpeg_available().is_err() {
        eprintln!("Skipping visual frame manifest export test because FFmpeg is unavailable");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let frame_dir = root.join(".cutready").join("visuals").join("hero-export");
    fs::create_dir_all(&frame_dir).unwrap();
    let frames = [
        ("intro-frame.png", Rgb([200, 60, 60])),
        ("dropdown-open-frame.png", Rgb([60, 200, 60])),
        ("zoomed-rest-frame.png", Rgb([60, 60, 200])),
    ];
    for (name, color) in frames {
        RgbImage::from_pixel(32, 18, color)
            .save(frame_dir.join(name))
            .unwrap();
    }
    fs::write(
        frame_dir.join("manifest.json"),
        serde_json::json!({
            "frames": [
                { "path": "intro-frame.png", "duration_ms": 17, "terminal": false },
                { "path": "dropdown-open-frame.png", "duration_ms": 17, "terminal": false },
                { "path": "zoomed-rest-frame.png", "duration_ms": 0, "terminal": true }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let narration_path = root.join("row-1.wav");
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=440:duration=0.1".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        narration_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    let mut sketch = Sketch::new("Frame Manifest Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = None;
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: "row-1.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(100),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: narration_path.metadata().unwrap().len(),
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("frame-manifest.sk"), root).unwrap();

    let output = root.join("frame-manifest.mp4");
    let settings = SketchVideoExportSettings {
        include_title_card: false,
        title_to_first_row_hold_seconds: 0.0,
        final_hold_seconds: 0.0,
        narration_tail_hold_seconds: 0.0,
        video_width: 32,
        video_height: 18,
        video_fps: 60,
        visual_frame_manifest_paths: vec![Some(
            ".cutready/visuals/hero-export/manifest.json".to_string(),
        )],
        ..SketchVideoExportSettings::default()
    };
    let export = export_sketch_video_with_progress(
        root,
        root,
        "frame-manifest.sk",
        Some(&output),
        settings,
        |_| {},
    )
    .unwrap();

    assert_seconds(export.duration_seconds, 0.3);
    let actual_duration = probe_media_duration_seconds(&output).unwrap();
    assert!(
        (actual_duration - 0.3).abs() < 0.08,
        "expected rendered duration near 0.3s, got {actual_duration}s"
    );
}

#[test]
fn export_sketch_video_generates_elucim_frame_manifest_for_visual_row() {
    if ensure_ffmpeg_available().is_err() {
        eprintln!("Skipping Elucim visual export test because FFmpeg is unavailable");
        return;
    }
    if !crate::engine::animation::elucim_renderer_available() {
        eprintln!("{}", crate::engine::animation::ELUCIM_RENDERER_SKIP_MESSAGE);
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    fs::create_dir_all(root.join(".cutready/visuals")).unwrap();
    fs::write(
        root.join(".cutready/visuals/intro.json"),
        serde_json::json!({
            "version": "2.0",
            "scene": {
                "type": "player",
                "fps": 30,
                "width": 160,
                "height": 90,
                "background": "transparent",
                "children": ["title"]
            },
            "elements": {
                "title": {
                    "id": "title",
                    "type": "text",
                    "props": {
                        "type": "text",
                        "x": 24,
                        "y": 48,
                        "content": "CutReady",
                        "fill": "$foreground",
                        "fontSize": 18
                    }
                }
            },
            "timelines": {
                "intro": {
                    "id": "intro",
                    "duration": 3,
                    "tracks": []
                }
            },
            "stateMachines": {
                "main": {
                    "id": "main",
                    "entry": "play",
                    "states": { "play": { "timeline": "intro" } },
                    "transitions": [
                        { "id": "entry-play", "from": "entry", "to": "play", "trigger": "onStart" }
                    ]
                }
            },
            "defaultStateMachine": "main"
        })
        .to_string(),
    )
    .unwrap();

    let narration_path = root.join("row-1.wav");
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=440:duration=0.1".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        narration_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    let mut sketch = Sketch::new("Elucim Visual Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = None;
    row.visual = Some(serde_json::Value::String(
        ".cutready/visuals/intro.json".to_string(),
    ));
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: "row-1.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(100),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: narration_path.metadata().unwrap().len(),
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("elucim-visual.sk"), root).unwrap();

    let output = root.join("elucim-visual.mp4");
    let settings = SketchVideoExportSettings {
        include_title_card: false,
        title_to_first_row_hold_seconds: 0.0,
        final_hold_seconds: 0.0,
        narration_tail_hold_seconds: 0.0,
        video_width: 160,
        video_height: 90,
        video_fps: 30,
        ..SketchVideoExportSettings::default()
    };
    let export = export_sketch_video_with_progress(
        root,
        root,
        "elucim-visual.sk",
        Some(&output),
        settings,
        |_| {},
    )
    .unwrap();

    assert_eq!(export.row_count, 1);
    assert!(output.is_file());
    assert!(output.metadata().unwrap().len() > 0);
}

#[test]
fn export_sketch_video_uses_resolved_demo_media_without_row_screenshot() {
    if ensure_ffmpeg_available().is_err() {
        eprintln!("Skipping resolved demo media export test because FFmpeg is unavailable");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let schema_dir = root.join(".cutready").join("scenecast");
    let frames_dir = schema_dir.join("frames");
    fs::create_dir_all(&frames_dir).unwrap();
    RgbImage::from_pixel(64, 36, Rgb([20, 80, 180]))
        .save(frames_dir.join("open.png"))
        .unwrap();
    RgbImage::from_pixel(64, 36, Rgb([180, 80, 20]))
        .save(frames_dir.join("terminal.png"))
        .unwrap();
    fs::write(
        schema_dir.join("resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [{
                "id": "step-start",
                "order": 0,
                "sceneId": "start",
                "title": "Start",
                "targets": [],
                "guideMarks": []
            }],
            "segments": [{
                "id": "segment-start",
                "kind": "scene",
                "stepId": "step-start",
                "startMs": 0,
                "durationMs": 400,
                "endMs": 400,
                "capture": null,
                "interaction": null,
                "frames": [
                    { "path": "frames/open.png", "durationMs": 100 },
                    { "path": "frames/terminal.png", "durationMs": 0 }
                ],
                "waitMs": 0
            }],
            "diagnostics": []
        })
        .to_string(),
    )
    .unwrap();

    let narration_path = root.join("row-1.wav");
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=440:duration=0.1".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        narration_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    let mut sketch = Sketch::new("Resolved Media Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = None;
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: "row-1.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(100),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: narration_path.metadata().unwrap().len(),
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("resolved-media.sk"), root).unwrap();

    let output = root.join("resolved-media.mp4");
    let settings = SketchVideoExportSettings {
        include_title_card: false,
        title_to_first_row_hold_seconds: 0.0,
        final_hold_seconds: 0.0,
        narration_tail_hold_seconds: 0.0,
        video_width: 64,
        video_height: 36,
        video_fps: 30,
        resolved_demo_path: Some(".cutready/scenecast/resolved-demo.json".to_string()),
        ..SketchVideoExportSettings::default()
    };
    let export = export_sketch_video_with_progress(
        root,
        root,
        "resolved-media.sk",
        Some(&output),
        settings,
        |_| {},
    )
    .unwrap();

    assert_eq!(export.row_count, 1);
    assert_seconds(export.duration_seconds, 0.6);
    assert!(output.is_file());
    assert!(output.metadata().unwrap().len() > 0);
}

#[test]
fn export_sketch_video_skips_resolved_demo_media_for_overlay_rows() {
    if ensure_ffmpeg_available().is_err() {
        eprintln!("Skipping resolved demo media overlay test because FFmpeg is unavailable");
        return;
    }

    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
    fs::create_dir_all(root.join(".cutready/scenecast")).unwrap();

    let screenshot_path = root.join(".cutready/screenshots/row-1.png");
    RgbImage::from_pixel(64, 36, Rgb([80, 20, 180]))
        .save(&screenshot_path)
        .unwrap();
    fs::write(
        root.join(".cutready/scenecast/resolved-demo.json"),
        serde_json::json!({
            "schemaVersion": "scenecast.resolved-demo.v1",
            "title": "Demo",
            "startSceneId": "start",
            "capturePolicy": {
                "kind": "reference-existing-assets",
                "assetBase": "bundle-relative",
                "missingCaptureBehavior": "diagnostic"
            },
            "steps": [{
                "id": "step-start",
                "order": 0,
                "sceneId": "start",
                "title": "Start",
                "targets": [],
                "guideMarks": []
            }],
            "segments": [{
                "id": "segment-start",
                "kind": "scene",
                "stepId": "step-start",
                "startMs": 0,
                "durationMs": 400,
                "endMs": 400,
                "capture": { "path": "captures/missing.png" },
                "interaction": null,
                "frames": [],
                "waitMs": 0
            }],
            "diagnostics": []
        })
        .to_string(),
    )
    .unwrap();

    let narration_path = root.join("row-1.wav");
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        "sine=frequency=440:duration=0.1".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        narration_path.to_string_lossy().to_string(),
    ])
    .unwrap();

    let mut sketch = Sketch::new("Resolved Media Overlay Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = Some(".cutready/screenshots/row-1.png".to_string());
    row.typing_spots = vec![TypingSpot {
        x: 0.2,
        y: 0.25,
        width: 0.5,
        height: 0.12,
        text: "Overlay".to_string(),
        start_offset_ms: Some(0),
        duration_ms: None,
        characters_per_second: Some(24.0),
        show_cursor: Some(true),
        text_color: Some("#ffffff".to_string()),
        font_family: Some("sans".to_string()),
        font_scale: Some(1.0),
    }];
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: "row-1.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(100),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: narration_path.metadata().unwrap().len(),
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("resolved-overlay.sk"), root).unwrap();

    let output = root.join("resolved-overlay.mp4");
    let settings = SketchVideoExportSettings {
        include_title_card: false,
        title_to_first_row_hold_seconds: 0.0,
        final_hold_seconds: 0.0,
        narration_tail_hold_seconds: 0.0,
        video_width: 64,
        video_height: 36,
        video_fps: 30,
        resolved_demo_path: Some(".cutready/scenecast/resolved-demo.json".to_string()),
        ..SketchVideoExportSettings::default()
    };
    let export = export_sketch_video_with_progress(
        root,
        root,
        "resolved-overlay.sk",
        Some(&output),
        settings,
        |_| {},
    )
    .unwrap();

    assert_eq!(export.row_count, 1);
    assert_seconds(export.duration_seconds, 0.6);
    assert!(output.is_file());
    assert!(output.metadata().unwrap().len() > 0);
}

#[test]
fn export_sketch_video_rejects_relative_output_path() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();
    let mut sketch = Sketch::new("Unsafe Export", chrono::Utc::now());
    let mut row = PlanningRow::new();
    row.screenshot = Some("missing.png".to_string());
    row.narrative = "Hello".to_string();
    row.narration = Some(NarrationAsset {
        path: "missing.wav".to_string(),
        source_text: "Hello".to_string(),
        source_text_hash: "hash".to_string(),
        narrative_text: Some("Hello".to_string()),
        narrative_text_hash: Some("hash".to_string()),
        mime_type: "audio/wav".to_string(),
        duration_ms: Some(250),
        leading_silence_ms: None,
        trailing_silence_ms: None,
        silence_threshold_db: None,
        byte_size: 0,
        recorded_at: Utc::now(),
    });
    sketch.rows = vec![row];
    project::write_sketch(&sketch, &root.join("unsafe.sk"), root).unwrap();

    let error = export_sketch_video(root, "unsafe.sk", Some(Path::new("escape.mp4"))).unwrap_err();
    assert!(error.to_string().contains("must be absolute"));
}

fn test_row_segment(
    row_number: usize,
    audio_duration_seconds: f64,
    narration_tail_hold_seconds: f64,
) -> RowSegment {
    let settings = SketchVideoExportSettings {
        narration_tail_hold_seconds,
        ..SketchVideoExportSettings::default()
    };
    RowSegment {
        row_number,
        image_path: PathBuf::from(format!("row-{row_number}.png")),
        narration_path: PathBuf::from(format!("row-{row_number}.wav")),
        audio_start_seconds: 0.0,
        audio_duration_seconds,
        duration_seconds: row_content_duration_seconds(audio_duration_seconds, 0.0, &settings),
        frame_sequence: None,
        motion_plan: None,
        typing_spots: Vec::new(),
    }
}

fn assert_seconds(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.000_001,
        "expected {expected}, got {actual}"
    );
}
