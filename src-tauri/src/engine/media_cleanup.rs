//! Removing unused media the user confirmed in the Media library.
//!
//! Only the listed paths are candidates, and each is re-checked as unreferenced
//! at delete time, so a file that became used after the user confirmed is kept.

use std::path::Path;

use crate::engine::{narration_assets, project};

/// Deletes the listed screenshots and visuals that are still unreferenced.
pub fn delete_unused_images(root: &Path, paths: &[String]) -> Result<u32, String> {
    let assets = project::list_images_with_refs(root).map_err(|e| e.to_string())?;
    let mut deleted = 0u32;
    for asset in assets
        .iter()
        .filter(|asset| asset.referenced_by.is_empty() && paths.contains(&asset.path))
    {
        let abs = project::safe_resolve(root, &asset.path).map_err(|e| e.to_string())?;
        if abs.exists() {
            std::fs::remove_file(&abs)
                .map_err(|e| format!("Failed to delete {}: {e}", asset.path))?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// Deletes the listed narration audio files that are still unreferenced.
pub fn delete_unused_narrations(root: &Path, paths: &[String]) -> Result<u32, String> {
    let narration_root = root.join(".cutready").join("narration");
    let assets = narration_assets::list(root).map_err(|e| e.to_string())?;
    let mut deleted = 0u32;
    for asset in assets
        .iter()
        .filter(|asset| asset.referenced_by.is_empty() && paths.contains(&asset.path))
    {
        let abs = project::safe_resolve(root, &asset.path).map_err(|e| e.to_string())?;
        if !abs.starts_with(&narration_root) {
            return Err(format!(
                "Refusing to delete narration asset outside .cutready/narration: {}",
                asset.path
            ));
        }
        if !abs.exists() {
            continue;
        }
        if narration_assets::audio_mime_from_path(&abs).is_none() {
            return Err(format!(
                "Refusing to delete non-audio asset: {}",
                asset.path
            ));
        }
        std::fs::remove_file(&abs).map_err(|e| format!("Failed to delete {}: {e}", asset.path))?;
        deleted += 1;
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn sketch_using(image: &str, narration: &str) -> String {
        format!(
            r#"{{"title":"S","rows":[{{"time":"","narrative":"","demo_actions":"","screenshot":"{image}","narration":{{"path":"{narration}"}}}}]}}"#
        )
    }

    fn owned(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn deletes_only_listed_images_that_are_still_unused() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        file(root, ".cutready/screenshots/used.png", "x");
        file(root, ".cutready/screenshots/listed.png", "x");
        file(root, ".cutready/screenshots/unlisted.png", "x");
        file(
            root,
            "s.sk",
            &sketch_using(".cutready/screenshots/used.png", ""),
        );

        let listed = owned(&[
            ".cutready/screenshots/used.png",
            ".cutready/screenshots/listed.png",
        ]);
        assert_eq!(delete_unused_images(root, &listed).unwrap(), 1);
        assert!(
            root.join(".cutready/screenshots/used.png").exists(),
            "became used, so kept"
        );
        assert!(!root.join(".cutready/screenshots/listed.png").exists());
        assert!(
            root.join(".cutready/screenshots/unlisted.png").exists(),
            "not confirmed"
        );
        assert_eq!(delete_unused_images(root, &[]).unwrap(), 0);
    }

    #[test]
    fn deletes_only_listed_narrations_that_are_still_unused() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        file(root, ".cutready/narration/used.webm", "x");
        file(root, ".cutready/narration/listed.webm", "x");
        file(root, ".cutready/narration/unlisted.webm", "x");
        file(
            root,
            "s.sk",
            &sketch_using("", ".cutready/narration/used.webm"),
        );

        let listed = owned(&[
            ".cutready/narration/used.webm",
            ".cutready/narration/listed.webm",
        ]);
        assert_eq!(delete_unused_narrations(root, &listed).unwrap(), 1);
        assert!(
            root.join(".cutready/narration/used.webm").exists(),
            "became used, so kept"
        );
        assert!(!root.join(".cutready/narration/listed.webm").exists());
        assert!(
            root.join(".cutready/narration/unlisted.webm").exists(),
            "not confirmed"
        );
        assert_eq!(delete_unused_narrations(root, &[]).unwrap(), 0);
    }

    #[test]
    fn refuses_listed_audio_outside_the_narration_folder() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        file(root, ".cutready/narration/keep.webm", "x");
        file(root, "recordings/raw.wav", "x");
        assert_eq!(
            delete_unused_narrations(root, &owned(&["recordings/raw.wav"])).unwrap(),
            0
        );
        assert!(root.join("recordings/raw.wav").exists());
    }
}
