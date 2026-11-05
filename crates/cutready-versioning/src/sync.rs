//! Collaboration status for the current timeline, with "to send" counting
//! only versions the remote doesn't already have.

use draftline::{Result as DraftlineResult, SyncState, SyncStatus};

use crate::CutReadyDraftlineAdapter;

impl CutReadyDraftlineAdapter {
    /// Draftline's status, except that a timeline the remote doesn't have yet
    /// counts only versions missing from every one of the remote's branches.
    /// Draftline counts the whole history there, so a new timeline branched
    /// from `main` would report all of `main`'s already-sent versions.
    pub fn sync_status(&self, remote: &str) -> DraftlineResult<SyncStatus> {
        let mut status = self.workspace.sync_status(remote)?;
        if status.state == SyncState::NoRemoteVersion {
            status.ahead = self.unsent_version_count(remote)?;
        }
        Ok(status)
    }

    /// Versions reachable from HEAD that no `refs/remotes/<remote>/*` contains.
    fn unsent_version_count(&self, remote: &str) -> DraftlineResult<usize> {
        let repo = git2::Repository::open(self.root())?;
        let mut walk = repo.revwalk()?;
        walk.push_head()?;
        walk.hide_glob(&format!("refs/remotes/{remote}/*"))?;
        Ok(walk.count())
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
