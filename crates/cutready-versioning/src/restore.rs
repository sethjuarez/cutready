//! Restore: bring back a whole project or selected documents from an earlier
//! version. Both always record a new version; history is never rewritten.

use std::path::Path;

use draftline::{Result as DraftlineResult, Version, VersionId};

use crate::CutReadyDraftlineAdapter;

impl CutReadyDraftlineAdapter {
    /// Restores everything tracked from `version` as a new version named `label`.
    pub fn restore_version_as_new_save(
        &self,
        version: &VersionId,
        label: &str,
    ) -> DraftlineResult<Version> {
        self.workspace.restore_version_as_new_save(version, label)
    }

    /// Restores only `paths` (Draftline paths, relative to the git work tree)
    /// from `version` as a new version named `label`. Paths missing from that
    /// version are deleted; everything else stays at the current version.
    pub fn restore_version_paths_as_new_save<P: AsRef<Path>>(
        &self,
        version: &VersionId,
        paths: &[P],
        label: &str,
    ) -> DraftlineResult<Version> {
        self.workspace
            .restore_version_paths_as_new_save(version, paths, label)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use draftline::DraftlineError;

    use crate::CutReadyDraftlineAdapter;

    fn write(path: impl AsRef<Path>, contents: &str) {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn read(path: impl AsRef<Path>) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn restore_version_as_new_save_requires_clean_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"One"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let first = adapter.save_version("First").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        adapter.save_version("Second").unwrap();

        write(root.join("planning.md"), "# unsaved\n");
        let error = adapter
            .restore_version_as_new_save(first.id(), "Restore first")
            .unwrap_err();
        assert!(matches!(error, DraftlineError::PreflightFailed(_)));
        assert_eq!(read(root.join("planning.md")), "# unsaved\n");
    }

    #[test]
    fn restore_version_as_new_save_restores_tracked_content_without_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"One"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"one"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let first = adapter.save_version("First").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"two"}"#);
        adapter.save_version("Second").unwrap();

        let restored = adapter
            .restore_version_as_new_save(first.id(), "Restore first")
            .unwrap();

        assert_eq!(read(root.join("intro.sk")), r#"{"title":"One"}"#);
        assert_eq!(
            read(root.join(".cutready/ui-state.json")),
            r#"{"panel":"two"}"#
        );
        let restored_preview = adapter
            .preview_version_file(restored.id(), "intro.sk")
            .unwrap()
            .unwrap();
        assert!(restored_preview
            .content
            .as_deref()
            .is_some_and(|content| content.contains("\"One\"")));
    }

    #[test]
    fn restore_paths_brings_back_one_document_as_a_new_version() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"One"}"#);
        write(root.join("notes.md"), "first\n");

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let first = adapter.save_version("First").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        write(root.join("notes.md"), "second\n");
        let second = adapter.save_version("Second").unwrap();

        let restored = adapter
            .restore_version_paths_as_new_save(
                first.id(),
                &["intro.sk"],
                "Restore intro\n\nFrom First",
            )
            .unwrap();

        assert_ne!(restored.id(), second.id());
        assert_eq!(read(root.join("intro.sk")), r#"{"title":"One"}"#);
        assert_eq!(read(root.join("notes.md")), "second\n");
    }

    #[test]
    fn restore_paths_reports_selection_errors() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"One"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let first = adapter.save_version("First").unwrap();

        let none: [&str; 0] = [];
        let error = adapter
            .restore_version_paths_as_new_save(first.id(), &none, "Restore")
            .unwrap_err();
        assert!(matches!(error, DraftlineError::NoPathsSelected));

        let error = adapter
            .restore_version_paths_as_new_save(first.id(), &["intro.sk"], "Restore")
            .unwrap_err();
        assert!(matches!(error, DraftlineError::NothingToRestore));
    }
}
