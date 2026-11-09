//! Animation engine — Elucim frame rendering for video export.

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::Context;
use serde::Deserialize;
use serde_json::json;

use super::project;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElucimFrameManifest {
    pub manifest_path: PathBuf,
    pub frame_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElucimFrameManifestOutput {
    manifest_path: PathBuf,
    frame_count: usize,
}

pub fn render_visual_frame_manifest(
    project_root: &Path,
    visual_relative_path: &str,
    output_dir: &Path,
    fps: u32,
) -> anyhow::Result<ElucimFrameManifest> {
    let visual_path = project::safe_resolve(project_root, visual_relative_path)
        .with_context(|| format!("Invalid Elucim visual path `{visual_relative_path}`"))?;
    if !visual_path.is_file() {
        anyhow::bail!("Elucim visual does not exist: {visual_relative_path}");
    }
    std::fs::create_dir_all(output_dir).with_context(|| {
        format!(
            "Failed to create Elucim frame output directory `{}`",
            output_dir.display()
        )
    })?;

    let sidecar_dir = super::interaction::resolve_sidecar_dir();
    let script = sidecar_dir.join(ELUCIM_FRAMES_SCRIPT);
    if !script.is_file() {
        anyhow::bail!("Elucim frame renderer not found: {}", script.display());
    }
    if !elucim_renderer_installed(&sidecar_dir) {
        anyhow::bail!(
            "Elucim frame renderer dependencies are missing; run `npm ci` in {}",
            sidecar_dir.display()
        );
    }
    let raw: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&visual_path)
            .with_context(|| format!("Failed to read Elucim visual `{visual_relative_path}`"))?,
    )
    .with_context(|| format!("Elucim visual `{visual_relative_path}` is not valid JSON"))?;
    // Legacy `{version: "1.0", root}` visuals are migrated to 2.0 here; the
    // sidecar renderer only understands `scene` + `elements` documents.
    let document =
        cutready_core::visual_document::normalize_visual_to_v2(&raw).map_err(|error| {
            anyhow::anyhow!("Invalid Elucim visual `{visual_relative_path}`: {error}")
        })?;
    let payload = json!({
        "document": document,
        "visualPath": visual_path,
        "outputDir": output_dir,
        "fps": fps,
        "theme": "light",
    });

    let mut command = Command::new("node");
    command
        .arg(&script)
        .current_dir(&sidecar_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .with_context(|| "Failed to start Elucim frame renderer")?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .with_context(|| "Failed to write Elucim frame renderer input")?;
    }
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .with_context(|| "Failed to wait for Elucim frame renderer")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!(
            "Elucim frame renderer failed with status {}: {}{}{}",
            output.status,
            excerpt(stderr.trim(), 2_000),
            if stdout.trim().is_empty() {
                ""
            } else {
                "\nstdout: "
            },
            excerpt(stdout.trim(), 2_000)
        );
    }

    let result: ElucimFrameManifestOutput = serde_json::from_slice(&output.stdout)
        .with_context(|| "Could not parse Elucim frame renderer output")?;
    if !result.manifest_path.is_file() {
        anyhow::bail!(
            "Elucim frame renderer did not create manifest `{}`",
            result.manifest_path.display()
        );
    }
    Ok(ElucimFrameManifest {
        manifest_path: result.manifest_path,
        frame_count: result.frame_count,
    })
}

const ELUCIM_FRAMES_SCRIPT: &str = "elucim-frames.mjs";

fn elucim_renderer_installed(sidecar_dir: &Path) -> bool {
    sidecar_dir
        .join("node_modules")
        .join("@elucim")
        .join("cli")
        .join("package.json")
        .is_file()
}

/// Whether the sidecar's Elucim renderer can run (`npm ci` has been run in it).
#[cfg(test)]
pub(crate) fn elucim_renderer_available() -> bool {
    elucim_renderer_installed(&super::interaction::resolve_sidecar_dir())
}

/// Printed by tests that skip because the sidecar's Elucim renderer isn't
/// installed; `npm run test:e2e:video-export` treats it as a failure.
#[cfg(test)]
pub(crate) const ELUCIM_RENDERER_SKIP_MESSAGE: &str =
    "Skipping Elucim render test: run `npm ci --prefix playwright-sidecar`";

fn excerpt(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        value.to_string()
    } else {
        format!("{}...", &value[..max_len])
    }
}

#[cfg(test)]
mod tests {
    use image::ImageReader;
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_elucim_visual_to_frame_manifest() {
        if !elucim_renderer_available() {
            eprintln!("{ELUCIM_RENDERER_SKIP_MESSAGE}");
            return;
        }
        let project = tempfile::tempdir().unwrap();
        let visuals_dir = project.path().join(".cutready").join("visuals");
        std::fs::create_dir_all(&visuals_dir).unwrap();
        let visual_path = visuals_dir.join("intro.json");
        std::fs::write(
            &visual_path,
            serde_json::to_vec_pretty(&json!({
                "version": "2.0",
                "scene": {
                    "type": "player",
                    "fps": 30,
                    "width": 160,
                    "height": 90,
                    "background": "$background",
                    "children": ["panel"]
                },
                "elements": {
                    "panel": {
                        "id": "panel",
                        "type": "rect",
                        "props": {
                            "type": "rect",
                            "x": 0,
                            "y": 0,
                            "width": 80,
                            "height": 45,
                            "fill": "$accent"
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
            }))
            .unwrap(),
        )
        .unwrap();

        let output_dir = project
            .path()
            .join(".cutready")
            .join("exports")
            .join("frames");
        let manifest = render_visual_frame_manifest(
            project.path(),
            ".cutready/visuals/intro.json",
            &output_dir,
            30,
        )
        .unwrap();

        // Elucim plans frames 0..=duration, so a 3-frame timeline yields 4
        // frames ending on its final state.
        assert_eq!(manifest.frame_count, 4);
        assert!(manifest.manifest_path.is_file());
        let first_frame_path = output_dir.join("frame-000000.png");
        assert!(first_frame_path.is_file());
        let first_frame = ImageReader::open(&first_frame_path)
            .unwrap()
            .decode()
            .unwrap()
            .to_rgba8();
        let pixel = first_frame.get_pixel(8, 8).0;
        assert_eq!(pixel, [111, 99, 232, 255]);
        let background_pixel = first_frame.get_pixel(240, 140).0;
        assert_eq!(background_pixel, [251, 250, 248, 255]);
        let manifest_json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest.manifest_path).unwrap()).unwrap();
        assert_eq!(manifest_json["frames"].as_array().unwrap().len(), 4);
        assert_eq!(manifest_json["frames"][3]["terminal"], true);
    }

    #[test]
    fn renders_legacy_visual_with_theme_background() {
        if !elucim_renderer_available() {
            eprintln!("{ELUCIM_RENDERER_SKIP_MESSAGE}");
            return;
        }
        let project = tempfile::tempdir().unwrap();
        let visuals_dir = project.path().join(".cutready").join("visuals");
        std::fs::create_dir_all(&visuals_dir).unwrap();
        // Legacy 1.0 shape with no background: must be migrated, not crash,
        // and must not encode a transparent (black) backdrop.
        std::fs::write(
            visuals_dir.join("legacy.json"),
            serde_json::to_vec_pretty(&json!({
                "version": "1.0",
                "root": {
                    "type": "scene",
                    "width": 160,
                    "height": 90,
                    "durationInFrames": 30,
                    "children": [{
                        "type": "rect",
                        "id": "panel",
                        "x": 0,
                        "y": 0,
                        "width": 80,
                        "height": 45,
                        "fill": "light-dark(#ff0000, #00ff00)"
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let output_dir = project.path().join("frames");
        let manifest = render_visual_frame_manifest(
            project.path(),
            ".cutready/visuals/legacy.json",
            &output_dir,
            30,
        )
        .unwrap();

        assert!(manifest.frame_count >= 1);
        let frame = ImageReader::open(output_dir.join("frame-000000.png"))
            .unwrap()
            .decode()
            .unwrap()
            .to_rgba8();
        assert_eq!(frame.get_pixel(8, 8).0, [255, 0, 0, 255]);
        assert_eq!(frame.get_pixel(240, 140).0, [251, 250, 248, 255]);
    }
}
