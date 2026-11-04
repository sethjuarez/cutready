//! The project's narration audio library: every audio file under
//! `.cutready/narration` and the sketches whose rows reference it.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationAssetInfo {
    pub path: String,
    pub size: u64,
    pub mime_type: String,
    pub modified_at: u64,
    pub referenced_by: Vec<String>,
}

/// Lists narration audio, newest first, with the sketches that reference each file.
pub fn list(root: &Path) -> std::io::Result<Vec<NarrationAssetInfo>> {
    let mut assets = Vec::new();
    collect_project_audio_assets(root, &root.join(".cutready").join("narration"), &mut assets)?;
    populate_narration_references(root, &mut assets)?;
    assets.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(assets)
}

fn collect_project_audio_assets(
    root: &Path,
    dir: &Path,
    assets: &mut Vec<NarrationAssetInfo>,
) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if matches!(file_name, ".git" | "node_modules" | "target") {
                continue;
            }
            collect_project_audio_assets(root, &path, assets)?;
            continue;
        }

        let Some(mime_type) = audio_mime_from_path(&path) else {
            continue;
        };
        let metadata = entry.metadata()?;
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        assets.push(NarrationAssetInfo {
            path: relative_path,
            size: metadata.len(),
            mime_type: mime_type.to_string(),
            modified_at,
            referenced_by: Vec::new(),
        });
    }
    Ok(())
}

fn populate_narration_references(
    root: &Path,
    assets: &mut [NarrationAssetInfo],
) -> std::io::Result<()> {
    let mut ref_map = std::collections::HashMap::<String, Vec<String>>::new();
    for asset in assets.iter() {
        ref_map.insert(asset.path.clone(), Vec::new());
    }
    if ref_map.is_empty() {
        return Ok(());
    }

    collect_sketch_narration_references(root, root, &mut ref_map)?;

    for asset in assets {
        asset.referenced_by = ref_map.remove(&asset.path).unwrap_or_default();
    }
    Ok(())
}

fn collect_sketch_narration_references(
    root: &Path,
    dir: &Path,
    ref_map: &mut std::collections::HashMap<String, Vec<String>>,
) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if matches!(file_name, ".git" | "node_modules" | "target") {
                continue;
            }
            collect_sketch_narration_references(root, &path, ref_map)?;
            continue;
        }

        if path.extension().and_then(|extension| extension.to_str()) != Some("sk") {
            continue;
        }

        let content = std::fs::read_to_string(&path)?;
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        for narration_ref in extract_sketch_narration_refs(&content) {
            if let Some(referrers) = ref_map.get_mut(&narration_ref) {
                referrers.push(relative_path.clone());
            }
        }
    }
    Ok(())
}

fn extract_sketch_narration_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = value.get("rows").and_then(|rows| rows.as_array()) {
            for row in rows {
                let Some(path) = row
                    .get("narration")
                    .and_then(|narration| narration.get("path"))
                    .and_then(|path| path.as_str())
                else {
                    continue;
                };
                refs.push(path.replace('\\', "/"));
            }
        }
    }
    refs
}

pub fn audio_mime_from_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("webm") => Some("audio/webm"),
        Some("ogg") | Some("oga") => Some("audio/ogg"),
        Some("mp3") => Some("audio/mpeg"),
        Some("wav") => Some("audio/wav"),
        Some("m4a") | Some("mp4") => Some("audio/mp4"),
        Some("flac") => Some("audio/flac"),
        _ => None,
    }
}
