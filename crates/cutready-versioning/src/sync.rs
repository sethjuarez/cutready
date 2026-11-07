//! Collaboration status for the current timeline. Draftline (0.12+) counts
//! "to send" as versions no remote branch contains; the tests pin that.

use draftline::{Result as DraftlineResult, SyncStatus};

use crate::CutReadyDraftlineAdapter;

impl CutReadyDraftlineAdapter {
    pub fn sync_status(&self, remote: &str) -> DraftlineResult<SyncStatus> {
        self.workspace.sync_status(remote)
    }
}

#[cfg(test)]
mod tests {
    use draftline::SyncState;

    use crate::tests::{configure_identity, init_bare_main_remote, write};
    use crate::{cutready_remote_options, CutReadyDraftlineAdapter};

    #[test]
    fn a_new_timeline_counts_only_versions_the_remote_lacks() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_main_remote(&remote);
        let root = temp.path().join("project");
        write(root.join("intro.sk"), r#"{"title":"One"}"#);
        let adapter = CutReadyDraftlineAdapter::open_project(&root).unwrap();
        configure_identity(&root, "Seth", "seth@example.com");
        adapter
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();
        adapter.save_version("One").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        let sent = adapter.save_version("Two").unwrap();
        adapter
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        let timeline = adapter.create_variation_from(sent.id(), "alt").unwrap();
        adapter.switch_variation(timeline.id()).unwrap();
        let status = adapter.sync_status("origin").unwrap();
        assert_eq!(status.state, SyncState::NoRemoteVersion);
        assert_eq!(status.ahead, 0);

        write(root.join("intro.sk"), r#"{"title":"Alt"}"#);
        adapter.save_version("Alt").unwrap();
        assert_eq!(adapter.sync_status("origin").unwrap().ahead, 1);
    }

    #[test]
    fn a_project_never_sent_counts_its_whole_history() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_main_remote(&remote);
        let root = temp.path().join("project");
        write(root.join("intro.sk"), r#"{"title":"One"}"#);
        let adapter = CutReadyDraftlineAdapter::open_project(&root).unwrap();
        configure_identity(&root, "Seth", "seth@example.com");
        adapter
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();
        adapter.save_version("One").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        adapter.save_version("Two").unwrap();

        let status = adapter.sync_status("origin").unwrap();
        assert_eq!(status.state, SyncState::NoRemoteVersion);
        assert_eq!(status.ahead, 2);
    }
}
