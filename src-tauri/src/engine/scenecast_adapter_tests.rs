use chrono::Utc;

use super::*;
use cutready_core::models::sketch::{InteractionCapturePolicy, SketchState};

fn sketch(rows: Vec<PlanningRow>) -> Sketch {
    Sketch {
        title: "Product tour".to_string(),
        description: serde_json::Value::Null,
        rows,
        state: SketchState::Draft,
        metadata: Default::default(),
        locked: false,
        unknown_fields: Default::default(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn row(screenshot: &str) -> PlanningRow {
    let row_id = Path::new(screenshot)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("row")
        .to_string();
    PlanningRow {
        time: "~10s".to_string(),
        narrative: "Show the dashboard.".to_string(),
        demo_actions: "Click Continue.".to_string(),
        screenshot: Some(screenshot.to_string()),
        id: row_id,
        ..PlanningRow::new()
    }
}

#[test]
fn builds_portable_bundle_manifest_from_sketch_rows() {
    let mut first = row("screenshots/dashboard.PNG");
    first.demo_steps = vec![DemoStep::Click {
        target: "Continue".to_string(),
        target_bounds: None,
        capture: Some(InteractionCapturePolicy::BeforeAfterAndMotion),
    }];
    let build =
        build_scenecast_bundle(&sketch(vec![first, row("screenshots/pricing.png")])).unwrap();

    assert_eq!(
        build.manifest.schema_version,
        SCENECAST_BUNDLE_SCHEMA_VERSION
    );
    assert_eq!(build.manifest.graph.start_scene, "cutready-row-dashboard");
    assert_eq!(
        build.manifest.sections[0].scenes,
        vec!["cutready-row-dashboard", "cutready-row-pricing"]
    );
    assert_eq!(
        build.manifest.graph.scenes[0].assets.screenshot,
        "captures/row-001.png"
    );
    assert_eq!(build.manifest.graph.scenes[0].title, "Show the dashboard.");
    assert_eq!(
        build.manifest.graph.scenes[1].assets.screenshot,
        "captures/row-002.png"
    );
    assert_eq!(
        build.asset_copies[0],
        ScenecastAssetCopy {
            source_project_path: "screenshots/dashboard.PNG".to_string(),
            bundle_path: "captures/row-001.png".to_string(),
        }
    );
    assert_eq!(build.manifest.graph.scenes[0].hotspots, Vec::new());
    assert_eq!(build.diagnostics.len(), 1);
    assert_eq!(build.diagnostics[0].code, "missing_hotspot_bounds");
}

#[test]
fn warns_when_terminal_row_steps_cannot_become_hotspots() {
    let mut only = row("screenshots/dashboard.png");
    only.demo_steps = vec![DemoStep::Click {
        target: "Continue".to_string(),
        target_bounds: None,
        capture: None,
    }];

    let build = build_scenecast_bundle(&sketch(vec![only])).unwrap();

    assert_eq!(build.manifest.graph.scenes[0].hotspots, Vec::new());
    assert_eq!(build.diagnostics.len(), 1);
    assert_eq!(build.diagnostics[0].row_number, 1);
    assert_eq!(build.diagnostics[0].code, "missing_hotspot_bounds");
}

#[test]
fn emits_hotspots_from_demo_step_target_bounds() {
    let mut first = row("screenshots/dashboard.png");
    first.demo_steps = vec![DemoStep::Click {
        target: "View pricing".to_string(),
        target_bounds: Some(cutready_core::models::sketch::InteractionBounds {
            x: 420.0,
            y: 240.0,
            width: 160.0,
            height: 48.0,
        }),
        capture: Some(InteractionCapturePolicy::BeforeAfter),
    }];

    let build =
        build_scenecast_bundle(&sketch(vec![first, row("screenshots/pricing.png")])).unwrap();

    assert!(build.diagnostics.is_empty());
    assert_eq!(build.manifest.graph.scenes[0].hotspots.len(), 1);
    assert_eq!(
        build.manifest.graph.scenes[0].hotspots[0].id,
        "row-001-step-001"
    );
    assert_eq!(
        build.manifest.graph.scenes[0].hotspots[0].label,
        "View pricing"
    );
    assert_eq!(
        build.manifest.graph.scenes[0].hotspots[0].target,
        "cutready-row-pricing"
    );
    assert_eq!(
        build.manifest.graph.scenes[0].hotspots[0].bounds,
        ScenecastRect {
            x: 420.0,
            y: 240.0,
            width: 160.0,
            height: 48.0,
        }
    );
}

#[test]
fn skips_rows_without_screenshots_until_visual_scenes_are_supported() {
    let build = build_scenecast_bundle(&sketch(vec![
        PlanningRow::new(),
        row(".cutready/screenshots/second.jpg"),
    ]))
    .unwrap();

    assert_eq!(build.manifest.graph.start_scene, "cutready-row-second");
    assert_eq!(
        build.manifest.sections[0].scenes,
        vec!["cutready-row-second"]
    );
    assert_eq!(build.asset_copies[0].bundle_path, "captures/row-002.jpg");
}

#[test]
fn rejects_sketches_without_screenshot_scenes() {
    let err = build_scenecast_bundle(&sketch(vec![PlanningRow::new()])).unwrap_err();

    assert!(err
        .to_string()
        .contains("at least one row with a screenshot"));
}

#[test]
fn writes_manifest_and_copied_captures_to_bundle_directory() {
    let project = tempfile::tempdir().unwrap();
    let screenshots = project.path().join("screenshots");
    std::fs::create_dir_all(&screenshots).unwrap();
    std::fs::write(screenshots.join("dashboard.png"), b"capture").unwrap();
    let bundle_dir = project
        .path()
        .join(".cutready")
        .join("scenecast")
        .join("demo.scenecast");

    let build = write_scenecast_bundle(
        project.path(),
        &sketch(vec![row("screenshots/dashboard.png")]),
        &bundle_dir,
    )
    .unwrap();

    assert_eq!(build.asset_copies[0].bundle_path, "captures/row-001.png");
    assert_eq!(
        std::fs::read(bundle_dir.join("captures").join("row-001.png")).unwrap(),
        b"capture"
    );
    let manifest = std::fs::read_to_string(bundle_dir.join("manifest.json")).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["schema_version"], SCENECAST_BUNDLE_SCHEMA_VERSION);
    assert_eq!(manifest["graph"]["start_scene"], "cutready-row-dashboard");
}

#[test]
fn pinned_minimal_bundle_fixture_matches_scenecast_manifest_shape() {
    let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("scenecast")
        .join("minimal.scenecast");
    let manifest_path = fixture_dir.join("manifest.json");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();

    assert_eq!(manifest["schema_version"], SCENECAST_BUNDLE_SCHEMA_VERSION);
    assert!(manifest.get("schemaVersion").is_none());
    assert_eq!(manifest["graph"]["start_scene"], "start");
    assert!(manifest["graph"].get("startScene").is_none());
    assert_eq!(
        manifest["sections"][0]["scenes"],
        serde_json::json!(["start", "pricing"])
    );
    assert_eq!(
        manifest["graph"]["scenes"][0]["assets"]["screenshot"],
        "captures/start.png"
    );
    assert_eq!(
        manifest["graph"]["scenes"][0]["hotspots"][0]["target"],
        "pricing"
    );
    assert!(fixture_dir.join("captures").join("start.png").is_file());
    assert!(fixture_dir.join("captures").join("pricing.png").is_file());
}

#[test]
fn writer_rejects_unsafe_or_missing_source_assets() {
    let project = tempfile::tempdir().unwrap();
    let bundle_dir = project.path().join("demo.scenecast");
    let err = write_scenecast_bundle(
        project.path(),
        &sketch(vec![row("../outside.png")]),
        &bundle_dir,
    )
    .unwrap_err();
    assert!(err
        .to_string()
        .contains("Invalid Scenecast source asset path"));
    assert!(!bundle_dir.exists());

    let bundle_dir = project.path().join("missing.scenecast");
    let err = write_scenecast_bundle(
        project.path(),
        &sketch(vec![row("screenshots/missing.png")]),
        &bundle_dir,
    )
    .unwrap_err();
    assert!(err.to_string().contains("does not exist or is not a file"));
    assert!(!bundle_dir.exists());
}

#[test]
fn writer_replaces_stale_bundle_contents() {
    let project = tempfile::tempdir().unwrap();
    let screenshots = project.path().join("screenshots");
    std::fs::create_dir_all(&screenshots).unwrap();
    std::fs::write(screenshots.join("first.png"), b"first").unwrap();
    std::fs::write(screenshots.join("second.jpg"), b"second").unwrap();
    let bundle_dir = project.path().join("demo.scenecast");

    write_scenecast_bundle(
        project.path(),
        &sketch(vec![
            row("screenshots/first.png"),
            row("screenshots/second.jpg"),
        ]),
        &bundle_dir,
    )
    .unwrap();
    assert!(bundle_dir.join("captures").join("row-002.jpg").exists());

    write_scenecast_bundle(
        project.path(),
        &sketch(vec![row("screenshots/first.png")]),
        &bundle_dir,
    )
    .unwrap();

    assert!(bundle_dir.join("captures").join("row-001.png").exists());
    assert!(!bundle_dir.join("captures").join("row-002.jpg").exists());
}

#[test]
fn capture_bundle_paths_use_known_image_extensions_only() {
    assert_eq!(
        bundle_capture_path(1, "screenshots/dashboard.PNG").unwrap(),
        "captures/row-001.png"
    );
    assert_eq!(
        bundle_capture_path(2, "screenshots/dashboard.exe").unwrap(),
        "captures/row-002.png"
    );
    assert_eq!(
        bundle_capture_path(3, "screenshots/dashboard").unwrap(),
        "captures/row-003.png"
    );
    assert!(resolve_bundle_path(Path::new("bundle"), "captures\\row.png").is_err());
    assert!(resolve_bundle_path(Path::new("bundle"), "C:/row.png").is_err());
}

#[test]
fn invokes_scenecast_cli_export_resolved_demo() {
    let project = tempfile::tempdir().unwrap();
    let cli = write_fake_scenecast_cli(project.path(), true);
    let bundle_dir = project.path().join("demo.scenecast");
    let output_dir = project.path().join("resolved");
    std::fs::create_dir_all(&bundle_dir).unwrap();

    let resolved =
        export_resolved_demo_with_scenecast_cli_path(cli, &bundle_dir, &output_dir).unwrap();

    assert_eq!(resolved, output_dir.join(RESOLVED_DEMO_FILE));
    let resolved_json = std::fs::read_to_string(resolved).unwrap();
    assert!(resolved_json.contains("scenecast.resolved-demo.v1"));
}

#[test]
fn real_scenecast_cli_resolved_demo_contract_when_configured() {
    let Some(cli) = env::var_os(SCENECAST_CLI_ENV) else {
        eprintln!(
            "Skipping real Scenecast CLI contract test because {SCENECAST_CLI_ENV} is not set"
        );
        return;
    };
    let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("scenecast")
        .join("minimal.scenecast");
    let output_dir = tempfile::tempdir().unwrap();

    let resolved = export_resolved_demo_with_scenecast_cli_path(
        PathBuf::from(cli),
        &fixture_dir,
        output_dir.path(),
    )
    .unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(resolved).unwrap()).unwrap();
    let demo: crate::models::resolved_demo::ResolvedDemo =
        serde_json::from_value(value.clone()).unwrap();

    demo.validate_for_row_count(2).unwrap();
    assert_eq!(value["sceneOrder"], serde_json::json!(["start", "pricing"]));
    assert_eq!(value["sections"][0]["id"], "main");
    assert_eq!(value["steps"][0]["targets"][0]["scrollDirection"], "any");
    assert!(value["segments"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|segment| segment["frames"].as_array().into_iter().flatten())
        .all(|frame| frame.get("durationMs").is_some()));
}

#[test]
fn reports_scenecast_cli_failures() {
    let project = tempfile::tempdir().unwrap();
    let cli = write_fake_scenecast_cli(project.path(), false);
    let err = export_resolved_demo_with_scenecast_cli_path(
        cli,
        &project.path().join("demo.scenecast"),
        &project.path().join("resolved"),
    )
    .unwrap_err();

    let message = err.to_string();
    assert!(message.contains("Scenecast CLI failed"));
    assert!(message.contains("fake scenecast failure"));
}

#[cfg(target_os = "windows")]
fn write_fake_scenecast_cli(root: &Path, succeeds: bool) -> PathBuf {
    let cli = root.join("scenecast-cli.cmd");
    let body = if succeeds {
        format!(
            "@echo off\r\nif \"%1\"==\"--version\" exit /b 0\r\nif not \"%1\"==\"export-resolved-demo\" exit /b 7\r\nif not exist \"%3\" mkdir \"%3\"\r\necho {{\"schemaVersion\":\"scenecast.resolved-demo.v1\"}}>\"%3\\{}\"\r\n",
            RESOLVED_DEMO_FILE
        )
    } else {
        "@echo off\r\necho fake scenecast failure 1>&2\r\nexit /b 9\r\n".to_string()
    };
    std::fs::write(&cli, body).unwrap();
    cli
}

#[cfg(not(target_os = "windows"))]
fn write_fake_scenecast_cli(root: &Path, succeeds: bool) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let cli = root.join("scenecast-cli");
    let body = if succeeds {
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nif [ \"$1\" != \"export-resolved-demo\" ]; then exit 7; fi\nmkdir -p \"$3\"\nprintf '{{\"schemaVersion\":\"scenecast.resolved-demo.v1\"}}' > \"$3/{}\"\n",
            RESOLVED_DEMO_FILE
        )
    } else {
        "#!/bin/sh\necho fake scenecast failure >&2\nexit 9\n".to_string()
    };
    std::fs::write(&cli, body).unwrap();
    let mut permissions = std::fs::metadata(&cli).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&cli, permissions).unwrap();
    cli
}
