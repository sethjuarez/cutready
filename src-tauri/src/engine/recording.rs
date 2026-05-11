//! Recording engine — FFmpeg process management for screen + audio capture.
//!
//! The capture pipeline will manage FFmpeg lifecycle, command construction,
//! progress parsing, and multi-track recording. This module currently owns the
//! project storage foundation for local-only recording media.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::engine::project;

const RECORDINGS_DIR: &str = ".cutready/recordings";
const RECORDINGS_GITIGNORE: &str = "*\n!.gitignore\n";

/// Return the local-only recordings directory for a project.
pub fn recordings_dir(project_root: &Path) -> PathBuf {
    project_root.join(RECORDINGS_DIR)
}

/// Initialize the recording storage folder and ignore rules.
///
/// Recording media can be very large, so the directory contains its own
/// `.gitignore` that ignores every take asset while allowing the ignore file
/// itself to be tracked.
pub fn initialize_recording_storage(project_root: &Path) -> anyhow::Result<PathBuf> {
    let dir = recordings_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    ensure_recordings_gitignore(&dir)?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecordingScope {
    Sketch { path: String },
    Storyboard { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureSource {
    FullScreen,
    Region,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputQuality {
    Lossless,
    High,
    Compact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecorderSettings {
    pub capture_source: CaptureSource,
    pub mic_device_id: Option<String>,
    pub countdown_seconds: u8,
    pub include_cursor: bool,
    pub output_quality: OutputQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingAssetKind {
    Screen,
    Mic,
    Camera,
    SystemAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingAssetStatus {
    Planned,
    LocalOnly,
    Missing,
    Exported,
    Uploaded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingAssetRef {
    pub kind: RecordingAssetKind,
    /// Path relative to the take directory.
    pub path: String,
    pub status: RecordingAssetStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingMarker {
    /// Recording-relative timestamp.
    pub time_ms: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingTakeStatus {
    Prepared,
    Recording,
    Finalized,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingTake {
    pub schema_version: u32,
    pub id: String,
    pub scope: RecordingScope,
    pub settings: RecorderSettings,
    pub status: RecordingTakeStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Path to `take.json` relative to the project root.
    pub metadata_path: String,
    #[serde(default)]
    pub assets: Vec<RecordingAssetRef>,
    #[serde(default)]
    pub markers: Vec<RecordingMarker>,
}

pub fn create_recording_take(
    project_root: &Path,
    scope: RecordingScope,
    settings: RecorderSettings,
) -> anyhow::Result<RecordingTake> {
    let scope = validate_scope(project_root, scope)?;
    let recordings = initialize_recording_storage(project_root)?;

    for _ in 0..5 {
        let id = generate_take_id();
        if let Some(take) = try_create_recording_take(&recordings, &id, &scope, &settings)? {
            return Ok(take);
        }
    }

    anyhow::bail!("Could not allocate a unique recording take id")
}

fn try_create_recording_take(
    recordings_dir: &Path,
    id: &str,
    scope: &RecordingScope,
    settings: &RecorderSettings,
) -> anyhow::Result<Option<RecordingTake>> {
    validate_take_id(id)?;
    let take_dir = recordings_dir.join(id);
    match std::fs::create_dir(&take_dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(err) => return Err(err.into()),
    }

    let now = Utc::now();
    let take = RecordingTake {
        schema_version: 1,
        id: id.to_string(),
        scope: scope.clone(),
        settings: settings.clone(),
        status: RecordingTakeStatus::Prepared,
        created_at: now,
        updated_at: now,
        metadata_path: format!("{RECORDINGS_DIR}/{id}/take.json"),
        assets: Vec::new(),
        markers: Vec::new(),
    };

    write_take_sidecar(&take_dir.join("take.json"), &take)?;
    Ok(Some(take))
}

fn validate_scope(project_root: &Path, scope: RecordingScope) -> anyhow::Result<RecordingScope> {
    let (path, expected_ext) = match &scope {
        RecordingScope::Sketch { path } => (path, "sk"),
        RecordingScope::Storyboard { path } => (path, "sb"),
    };

    let resolved = project::safe_resolve(project_root, path).map_err(|e| anyhow::anyhow!("{e}"))?;
    if !resolved.exists() {
        anyhow::bail!("Recording scope does not exist: {path}");
    }
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if !ext.eq_ignore_ascii_case(expected_ext) {
        anyhow::bail!("Recording scope must reference a .{expected_ext} file");
    }

    let normalized = path.replace('\\', "/");
    Ok(match scope {
        RecordingScope::Sketch { .. } => RecordingScope::Sketch { path: normalized },
        RecordingScope::Storyboard { .. } => RecordingScope::Storyboard { path: normalized },
    })
}

fn validate_take_id(id: &str) -> anyhow::Result<()> {
    if id.is_empty() || id.len() > 80 || id.starts_with('.') {
        anyhow::bail!("Invalid recording take id");
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        anyhow::bail!("Invalid recording take id");
    }
    Ok(())
}

fn generate_take_id() -> String {
    let suffix = Uuid::new_v4().simple().to_string();
    format!(
        "take_{}_{}",
        Utc::now().format("%Y%m%d_%H%M%S"),
        &suffix[..8]
    )
}

fn write_take_sidecar(path: &Path, take: &RecordingTake) -> anyhow::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(take)?;
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn ensure_recordings_gitignore(recordings_dir: &Path) -> anyhow::Result<()> {
    let path = recordings_dir.join(".gitignore");
    if !path.exists() {
        std::fs::write(path, RECORDINGS_GITIGNORE)?;
        return Ok(());
    }

    let existing = std::fs::read_to_string(&path)?;
    let mut updated = existing.clone();
    let mut changed = false;

    for rule in ["*", "!.gitignore"] {
        if !existing.lines().any(|line| line.trim() == rule) {
            if !updated.ends_with('\n') {
                updated.push('\n');
            }
            updated.push_str(rule);
            updated.push('\n');
            changed = true;
        }
    }

    if changed {
        std::fs::write(path, updated)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> RecorderSettings {
        RecorderSettings {
            capture_source: CaptureSource::FullScreen,
            mic_device_id: None,
            countdown_seconds: 3,
            include_cursor: true,
            output_quality: OutputQuality::Lossless,
        }
    }

    #[test]
    fn initializes_recording_storage_with_dedicated_gitignore() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();

        assert_eq!(dir, temp.path().join(".cutready").join("recordings"));
        assert!(dir.is_dir());
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "*\n!.gitignore\n"
        );
    }

    #[test]
    fn recording_storage_initialization_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        let gitignore = dir.join(".gitignore");
        let first = std::fs::read(&gitignore).unwrap();

        initialize_recording_storage(temp.path()).unwrap();
        let second = std::fs::read(&gitignore).unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn recording_gitignore_keeps_itself_trackable() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        let rules: Vec<&str> = content.lines().collect();

        assert!(rules.contains(&"*"));
        assert!(rules.contains(&"!.gitignore"));
        assert!(
            !content.contains(".cutready/"),
            "recording ignore rules must not ignore other .cutready assets"
        );
    }

    #[test]
    fn existing_recording_gitignore_preserves_extra_rules() {
        let temp = tempfile::tempdir().unwrap();
        let dir = recordings_dir(temp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "# local notes\n*.tmp\n").unwrap();

        initialize_recording_storage(temp.path()).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();

        assert!(content.contains("# local notes"));
        assert!(content.contains("*.tmp"));
        assert!(content.lines().any(|line| line == "*"));
        assert!(content.lines().any(|line| line == "!.gitignore"));
    }

    #[test]
    fn create_take_writes_prepared_sidecar_with_relative_scope() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("intro.sk"), "{}").unwrap();

        let take = create_recording_take(
            temp.path(),
            RecordingScope::Sketch {
                path: "intro.sk".into(),
            },
            default_settings(),
        )
        .unwrap();

        assert_eq!(take.schema_version, 1);
        assert_eq!(take.status, RecordingTakeStatus::Prepared);
        assert_eq!(
            take.scope,
            RecordingScope::Sketch {
                path: "intro.sk".into()
            }
        );
        assert!(take.metadata_path.starts_with(".cutready/recordings/"));

        let sidecar = temp.path().join(&take.metadata_path);
        let parsed: RecordingTake =
            serde_json::from_str(&std::fs::read_to_string(sidecar).unwrap()).unwrap();
        assert_eq!(parsed, take);
    }

    #[test]
    fn create_take_rejects_traversal_scope() {
        let temp = tempfile::tempdir().unwrap();
        let err = create_recording_take(
            temp.path(),
            RecordingScope::Sketch {
                path: "../outside.sk".into(),
            },
            default_settings(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("Path traversal"));
    }

    #[test]
    fn create_take_rejects_wrong_scope_extension() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("intro.md"), "# intro").unwrap();

        let err = create_recording_take(
            temp.path(),
            RecordingScope::Sketch {
                path: "intro.md".into(),
            },
            default_settings(),
        )
        .unwrap_err();

        assert!(err.to_string().contains(".sk"));
    }

    #[test]
    fn validate_take_id_rejects_path_components() {
        for id in [
            "../take",
            "take/one",
            "take\\one",
            ".hidden",
            "take:one",
            "",
        ] {
            assert!(validate_take_id(id).is_err(), "{id} should be rejected");
        }
        assert!(validate_take_id("take_20260511_abcdef12").is_ok());
    }

    #[test]
    fn duplicate_take_id_does_not_clobber_existing_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let recordings = initialize_recording_storage(temp.path()).unwrap();
        std::fs::create_dir(recordings.join("take_duplicate")).unwrap();
        std::fs::write(
            recordings.join("take_duplicate").join("take.json"),
            "existing",
        )
        .unwrap();

        let result = try_create_recording_take(
            &recordings,
            "take_duplicate",
            &RecordingScope::Storyboard {
                path: "demo.sb".into(),
            },
            &default_settings(),
        )
        .unwrap();

        assert!(result.is_none());
        assert_eq!(
            std::fs::read_to_string(recordings.join("take_duplicate").join("take.json")).unwrap(),
            "existing"
        );
    }
}
