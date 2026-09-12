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

    let script = elucim_frame_manifest_script();
    if !script.is_file() {
        anyhow::bail!(
            "Elucim frame manifest script not found: {}",
            script.display()
        );
    }
    let repo_root = script
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."));
    let payload = json!({
        "visualPath": visual_path,
        "outputDir": output_dir,
        "fps": fps,
        "theme": "light",
    });

    let mut command = Command::new("node");
    command
        .arg(&script)
        .current_dir(repo_root)
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

fn elucim_frame_manifest_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("scripts")
        .join("elucim-frame-manifest.mjs")
}

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

        assert_eq!(manifest.frame_count, 3);
        assert!(manifest.manifest_path.is_file());
        let first_frame_path = output_dir.join("frame-0000.png");
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
        assert_eq!(manifest_json["frames"].as_array().unwrap().len(), 3);
        assert_eq!(manifest_json["frames"][2]["terminal"], true);
    }
}
