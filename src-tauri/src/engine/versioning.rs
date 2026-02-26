//! Git-backed document versioning via gix (pure-Rust git).
//!
//! Each project directory is a git repository. Every save auto-commits
//! a snapshot, giving users infinite undo and version history without
//! needing to understand git.

use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};

use crate::models::sketch::{GraphNode, TimelineInfo, VersionEntry};

/// Errors that can occur during versioning operations.
#[derive(Debug, thiserror::Error)]
pub enum VersioningError {
    #[error("Git error: {0}")]
    Git(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("No commits found")]
    NoCommits,
}

/// Initialize a git repository in the given project directory.
pub fn init_project_repo(project_dir: &Path) -> Result<(), VersioningError> {
    let repo = gix::init(project_dir).map_err(|e| VersioningError::Git(e.to_string()))?;
    // Ensure HEAD points to refs/heads/main (not master)
    let head_path = repo.git_dir().join("HEAD");
    std::fs::write(&head_path, "ref: refs/heads/main\n")
        .map_err(|e| VersioningError::Io(e.to_string()))?;
    Ok(())
}

/// Stage all files and commit a snapshot with the given message.
pub fn commit_snapshot(
    project_dir: &Path,
    message: &str,
    fork_label: Option<&str>,
) -> Result<String, VersioningError> {
    let repo = open_repo(project_dir)?;

    // If rewound (prev-tip exists), the new commit goes on a FORK branch.
    // Main keeps pointing at its original tip so original commits stay on "Main".
    let forking = load_prev_tip(project_dir).is_some();

    // Build a tree from the working directory
    let tree_id = build_tree_from_dir(&repo, project_dir, project_dir)?;

    // Find the parent commit (if any)
    let parent_ids: Vec<gix::ObjectId> = match repo.head_commit() {
        Ok(commit) => vec![commit.id],
        Err(_) => vec![],
    };

    let parents_refs: Vec<&gix::oid> = parent_ids.iter().map(|id| id.as_ref()).collect();

    let committer = gix::actor::SignatureRef {
        name: "CutReady".into(),
        email: "app@cutready.local".into(),
        time: gix::date::Time::now_local_or_utc(),
    };

    // Commit to HEAD (which is whatever branch/commit we're currently on)
    let commit_id = repo
        .commit_as(
            committer,
            committer,
            "HEAD",
            message,
            tree_id,
            parents_refs,
        )
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    if forking {
        let prev_tip = load_prev_tip(project_dir).unwrap(); // safe: we checked above
        let timestamp = chrono::Utc::now().format("%H%M%S").to_string();
        let fork_slug = format!("fork-{}", timestamp);

        // Label for the new direction (user-provided or auto-generated)
        let label = match fork_label {
            Some(l) if !l.trim().is_empty() => l.trim().to_string(),
            _ => "New direction".to_string(),
        };

        // Create a timeline branch for the NEW commit
        let fork_ref = format!("{}{}", TIMELINE_PREFIX, fork_slug);
        let _ = repo.reference(
            fork_ref.as_str(),
            commit_id,
            gix::refs::transaction::PreviousValue::MustNotExist,
            format!("Fork: {}", label),
        );
        let _ = save_timeline_label(project_dir, &fork_slug, &label);

        // Restore main to its original tip
        reset_branch_ref(&repo, MAIN_BRANCH, prev_tip)?;

        // Checkout the new fork commit so HEAD follows the new branch
        // (update HEAD to point at the fork branch)
        let head_ref_path = project_dir.join(".git").join("HEAD");
        std::fs::write(&head_ref_path, format!("ref: {}\n", fork_ref))
            .map_err(|e| VersioningError::Io(e.to_string()))?;

        clear_prev_tip(project_dir);
    }

    Ok(commit_id.to_string())
}

/// Check if the project is in a rewound state (prev-tip exists).
pub fn is_rewound(project_dir: &Path) -> bool {
    prev_tip_path(project_dir).exists()
}

/// Check if working directory has changes not captured in a snapshot.
pub fn has_unsaved_changes(project_dir: &Path) -> Result<bool, VersioningError> {
    let repo = open_repo(project_dir)?;

    let head_tree_id = match repo.head_commit() {
        Ok(commit) => {
            let tree = commit.tree().map_err(|e| VersioningError::Git(e.to_string()))?;
            tree.id
        }
        Err(_) => return Ok(true), // No commits yet = everything is unsaved
    };

    let working_tree_id = build_tree_from_dir(&repo, project_dir, project_dir)?;
    Ok(working_tree_id != head_tree_id)
}

/// List all versions (commits) in reverse chronological order.
pub fn list_versions(project_dir: &Path) -> Result<Vec<VersionEntry>, VersioningError> {
    let repo = open_repo(project_dir)?;

    let head = match repo.head_commit() {
        Ok(commit) => commit,
        Err(_) => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    let mut current = Some(head.id().detach());

    while let Some(oid) = current {
        let commit_obj = repo
            .find_commit(oid)
            .map_err(|e| VersioningError::Git(e.to_string()))?;

        let message = commit_obj.message_raw_sloppy().to_string();
        let time = commit_obj
            .time()
            .map_err(|e| VersioningError::Git(e.to_string()))?;
        let timestamp = gix_time_to_chrono(time);

        entries.push(VersionEntry {
            id: oid.to_string(),
            message: message.trim().to_string(),
            timestamp,
            summary: String::new(),
        });

        // Follow first parent only (linear history)
        current = commit_obj.parent_ids().next().map(|id| id.detach());
    }

    Ok(entries)
}

/// Get the content of a specific file at a given commit.
pub fn get_file_at_version(
    project_dir: &Path,
    commit_id: &str,
    file_path: &str,
) -> Result<Vec<u8>, VersioningError> {
    let repo = open_repo(project_dir)?;

    let oid: gix::ObjectId = commit_id
        .parse()
        .map_err(|e: gix::hash::decode::Error| VersioningError::Git(e.to_string()))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let tree = commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let entry = tree
        .lookup_entry_by_path(file_path)
        .map_err(|e| VersioningError::Git(e.to_string()))?
        .ok_or_else(|| {
            VersioningError::Git(format!("File not found at version: {}", file_path))
        })?;

    let object = entry
        .object()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    Ok(object.data.to_vec())
}

/// Restore the project to a historical version by checking out that commit's
/// full tree and creating a new "Restored from..." commit.
pub fn restore_version(project_dir: &Path, commit_id: &str) -> Result<String, VersioningError> {
    checkout_version(project_dir, commit_id)?;

    let short_id = &commit_id[..8.min(commit_id.len())];
    let message = format!("Restored from {}", short_id);
    commit_snapshot(project_dir, &message, None)
}

/// Check out a snapshot's files to the working directory WITHOUT committing.
/// Used for browsing/previewing historical snapshots.
pub fn checkout_version(project_dir: &Path, commit_id: &str) -> Result<(), VersioningError> {
    let repo = open_repo(project_dir)?;

    let oid: gix::ObjectId = commit_id
        .parse()
        .map_err(|e: gix::hash::decode::Error| VersioningError::Git(e.to_string()))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let tree = commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    clean_working_dir(project_dir)?;
    write_tree_to_dir(&repo, tree.id, project_dir)
}

/// Stash the current working tree into a git tree object.
/// Stores the tree OID in `.git/cutready-stash` for later retrieval.
pub fn stash_working_tree(project_dir: &Path) -> Result<(), VersioningError> {
    let repo = open_repo(project_dir)?;
    let tree_id = build_tree_from_dir(&repo, project_dir, project_dir)?;
    let stash_file = project_dir.join(".git").join("cutready-stash");
    std::fs::write(&stash_file, tree_id.to_string())
        .map_err(|e| VersioningError::Io(e.to_string()))?;
    Ok(())
}

/// Pop the stashed working tree, restoring files to disk.
/// Returns Ok(true) if a stash was restored, Ok(false) if no stash existed.
pub fn pop_stash(project_dir: &Path) -> Result<bool, VersioningError> {
    let stash_file = project_dir.join(".git").join("cutready-stash");
    if !stash_file.exists() {
        return Ok(false);
    }
    let oid_str = std::fs::read_to_string(&stash_file)
        .map_err(|e| VersioningError::Io(e.to_string()))?;
    let tree_id: gix::ObjectId = oid_str
        .trim()
        .parse()
        .map_err(|e: gix::hash::decode::Error| VersioningError::Git(e.to_string()))?;

    let repo = open_repo(project_dir)?;
    clean_working_dir(project_dir)?;
    write_tree_to_dir(&repo, tree_id, project_dir)?;

    std::fs::remove_file(&stash_file).map_err(|e| VersioningError::Io(e.to_string()))?;
    Ok(true)
}

/// Check whether a stash exists.
pub fn has_stash(project_dir: &Path) -> bool {
    project_dir.join(".git").join("cutready-stash").exists()
}

/// Navigate to any snapshot on the current timeline.
///
/// If the target is an ancestor of HEAD (navigating backward), the commits
/// between target and HEAD are auto-forked into a new visible timeline so
/// nothing is lost. The current branch is then reset to the target commit.
///
/// If the target IS the current HEAD, this is a no-op.
/// If the target is on a different timeline, switches to that timeline first.
pub fn navigate_to_snapshot(
    project_dir: &Path,
    commit_id: &str,
) -> Result<(), VersioningError> {
    let repo = open_repo(project_dir)?;

    let target_oid: gix::ObjectId = commit_id
        .parse()
        .map_err(|e: gix::hash::decode::Error| VersioningError::Git(e.to_string()))?;

    // Get current HEAD commit
    let head_commit = repo
        .head_commit()
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let head_oid = head_commit.id().detach();

    // If target == HEAD, just checkout (handles dirty→clean refresh)
    if target_oid == head_oid {
        return checkout_version(project_dir, commit_id);
    }

    // Figure out if we need to save a prev-tip for the current branch
    let going_backward_on_current = is_ancestor(&repo, target_oid, head_oid)?;

    if going_backward_on_current {
        // Save current tip so "future" commits remain visible in the graph.
        // If prev-tip is already set (deeper rewind), keep the original.
        let tip_to_save = load_prev_tip(project_dir).unwrap_or(head_oid);
        save_prev_tip(project_dir, tip_to_save)?;
    }

    // Going forward and reaching prev-tip — clear it
    if let Some(prev_tip) = load_prev_tip(project_dir) {
        if target_oid == prev_tip {
            clear_prev_tip(project_dir);
        }
    }

    // If target matches a branch tip, re-attach HEAD to that branch.
    // Otherwise detach HEAD to the target commit — branches stay where they are.
    let head_path = project_dir.join(".git").join("HEAD");
    let timelines = list_timelines(project_dir)?;
    let mut attached = false;
    for tl in &timelines {
        let ref_name = if tl.name == MAIN_BRANCH {
            format!("refs/heads/{}", MAIN_BRANCH)
        } else {
            format!("{}{}", TIMELINE_PREFIX, tl.name)
        };
        if let Ok(r) = repo.find_reference(&ref_name) {
            if r.id().detach() == target_oid {
                std::fs::write(&head_path, format!("ref: {}\n", ref_name))
                    .map_err(|e| VersioningError::Io(e.to_string()))?;
                attached = true;
                break;
            }
        }
    }
    if !attached {
        std::fs::write(&head_path, format!("{}\n", target_oid))
            .map_err(|e| VersioningError::Io(e.to_string()))?;
    }

    checkout_version(project_dir, commit_id)
}

// ── Timeline (branch) management ────────────────────────────────────

/// Prefix for CutReady timeline branches.
const TIMELINE_PREFIX: &str = "refs/heads/timeline/";
/// The main (default) branch name.
const MAIN_BRANCH: &str = "main";

/// Create a new timeline branching from the given commit.
/// Switches the working directory to the new timeline.
pub fn create_timeline(
    project_dir: &Path,
    from_commit_id: &str,
    name: &str,
) -> Result<(), VersioningError> {
    let repo = open_repo(project_dir)?;

    let oid: gix::ObjectId = from_commit_id
        .parse()
        .map_err(|e: gix::hash::decode::Error| VersioningError::Git(e.to_string()))?;

    // Ensure the source commit exists
    repo.find_commit(oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Slugify the name for the branch ref
    let slug = slugify_timeline_name(name);
    let ref_name = format!("{}{}", TIMELINE_PREFIX, slug);

    // Create the branch ref pointing at the commit
    repo.reference(
        ref_name.as_str(),
        oid,
        gix::refs::transaction::PreviousValue::MustNotExist,
        format!("Create timeline: {}", name),
    )
    .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Store the human-readable label in .git/cutready-timeline-labels
    save_timeline_label(project_dir, &slug, name)?;

    // Switch HEAD to the new branch
    set_head_to_branch(&repo, &ref_name)?;

    // Checkout the commit's tree
    checkout_version(project_dir, from_commit_id)?;

    Ok(())
}

/// List all timelines (branches) in the project.
pub fn list_timelines(project_dir: &Path) -> Result<Vec<TimelineInfo>, VersioningError> {
    let repo = open_repo(project_dir)?;
    let labels = load_timeline_labels(project_dir);

    // Find active branch name
    let active_branch = get_current_branch_name(&repo);

    let mut timelines = Vec::new();
    let mut color_idx = 0;

    // Check if "main" branch exists
    let main_ref = format!("refs/heads/{}", MAIN_BRANCH);
    if repo.find_reference(&main_ref).is_ok() {
        let count = count_commits_on_ref(&repo, &main_ref)?;
        timelines.push(TimelineInfo {
            name: MAIN_BRANCH.to_string(),
            label: "Main".to_string(),
            is_active: active_branch.as_deref() == Some(MAIN_BRANCH),
            snapshot_count: count,
            color_index: color_idx,
        });
        color_idx += 1;
    }

    // List timeline/* branches
    if let Ok(refs) = repo.references() {
        if let Ok(prefixed) = refs.prefixed(TIMELINE_PREFIX) {
            for reference in prefixed {
                if let Ok(r) = reference {
                    let full_name = r.name().as_bstr().to_string();
                    let slug = full_name
                        .strip_prefix(TIMELINE_PREFIX)
                        .unwrap_or(&full_name)
                        .to_string();
                    let label = labels
                        .get(&slug)
                        .cloned()
                        .unwrap_or_else(|| slug.clone());
                    let is_active = active_branch.as_deref() == Some(&full_name)
                        || active_branch.as_deref() == Some(&format!("timeline/{}", slug));
                    let count = count_commits_on_ref(&repo, &full_name)?;
                    timelines.push(TimelineInfo {
                        name: slug,
                        label,
                        is_active,
                        snapshot_count: count,
                        color_index: color_idx,
                    });
                    color_idx += 1;
                }
            }
        }
    }

    // If no branches found but HEAD exists (legacy repos without branches), show "Main"
    if timelines.is_empty() {
        if let Ok(_commit) = repo.head_commit() {
            let count = count_commits_on_ref(&repo, "HEAD")?;
            timelines.push(TimelineInfo {
                name: MAIN_BRANCH.to_string(),
                label: "Main".to_string(),
                is_active: true,
                snapshot_count: count,
                color_index: 0,
            });
        }
    }

    // If HEAD is detached (no active branch), find which timeline contains HEAD
    // and mark it active so the graph renders correctly
    if active_branch.is_none() && !timelines.iter().any(|t| t.is_active) {
        if let Ok(head_commit) = repo.head_commit() {
            let head_oid = head_commit.id().detach();
            // First check if HEAD matches any tip exactly
            let mut found = false;
            for tl in timelines.iter_mut() {
                let ref_name = if tl.name == MAIN_BRANCH {
                    format!("refs/heads/{}", MAIN_BRANCH)
                } else {
                    format!("{}{}", TIMELINE_PREFIX, tl.name)
                };
                if let Ok(r) = repo.find_reference(&ref_name) {
                    let tip = r.id().detach();
                    if tip == head_oid {
                        tl.is_active = true;
                        found = true;
                        break;
                    }
                }
            }
            // If no exact match, find which timeline HEAD is an ancestor of
            if !found {
                for tl in timelines.iter_mut() {
                    let ref_name = if tl.name == MAIN_BRANCH {
                        format!("refs/heads/{}", MAIN_BRANCH)
                    } else {
                        format!("{}{}", TIMELINE_PREFIX, tl.name)
                    };
                    if let Ok(r) = repo.find_reference(&ref_name) {
                        let tip = r.id().detach();
                        if is_ancestor(&repo, head_oid, tip).unwrap_or(false) {
                            tl.is_active = true;
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(timelines)
}

/// Switch to a different timeline.
pub fn switch_timeline(project_dir: &Path, name: &str) -> Result<(), VersioningError> {
    let repo = open_repo(project_dir)?;

    let ref_name = if name == MAIN_BRANCH {
        format!("refs/heads/{}", MAIN_BRANCH)
    } else {
        format!("{}{}", TIMELINE_PREFIX, name)
    };

    // Find the branch's tip commit
    let reference = repo
        .find_reference(&ref_name)
        .map_err(|e| VersioningError::Git(format!("Timeline not found: {}", e)))?;

    let commit_id = reference
        .id()
        .detach();

    // Switch HEAD to the branch
    set_head_to_branch(&repo, &ref_name)?;

    // Checkout the tree
    let commit = repo
        .find_commit(commit_id)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let tree = commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    clean_working_dir(project_dir)?;
    write_tree_to_dir(&repo, tree.id, project_dir)
}

/// Delete a non-active timeline.
pub fn delete_timeline(project_dir: &Path, name: &str) -> Result<(), VersioningError> {
    if name == MAIN_BRANCH {
        return Err(VersioningError::Git("Cannot delete the main timeline".into()));
    }

    let repo = open_repo(project_dir)?;
    let ref_name = format!("{}{}", TIMELINE_PREFIX, name);

    // Ensure not deleting the active branch
    let active = get_current_branch_name(&repo);
    if active.as_deref() == Some(&ref_name)
        || active.as_deref() == Some(&format!("timeline/{}", name))
    {
        return Err(VersioningError::Git("Cannot delete the active timeline".into()));
    }

    // Delete the ref
    let reference = repo
        .find_reference(&ref_name)
        .map_err(|e| VersioningError::Git(format!("Timeline not found: {}", e)))?;
    reference
        .delete()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Remove label
    remove_timeline_label(project_dir, name);

    Ok(())
}

/// Get the full timeline graph — all commits across all timelines.
pub fn get_timeline_graph(project_dir: &Path) -> Result<Vec<GraphNode>, VersioningError> {
    let repo = open_repo(project_dir)?;
    let timelines = list_timelines(project_dir)?;

    // Get current HEAD commit for is_head marking
    let head_oid = repo.head_commit().ok().map(|c| c.id().detach());

    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Find the active timeline for attributing prev-tip nodes
    let active_timeline = timelines.iter().find(|t| t.is_active);

    for timeline in &timelines {
        let ref_name = if timeline.name == MAIN_BRANCH {
            format!("refs/heads/{}", MAIN_BRANCH)
        } else {
            format!("{}{}", TIMELINE_PREFIX, timeline.name)
        };

        // Walk commits from this branch's tip
        let tip_oid = match repo.find_reference(&ref_name) {
            Ok(r) => r.id().detach(),
            Err(_) => {
                // Fallback: try HEAD directly (legacy repos)
                match repo.head_commit() {
                    Ok(c) => c.id().detach(),
                    Err(_) => continue,
                }
            }
        };

        let mut current = Some(tip_oid);
        while let Some(oid) = current {
            if !seen.insert(oid) {
                break; // Already visited (shared ancestor)
            }

            let commit = repo
                .find_commit(oid)
                .map_err(|e| VersioningError::Git(e.to_string()))?;

            let message = commit.message_raw_sloppy().to_string();
            let time = commit
                .time()
                .map_err(|e| VersioningError::Git(e.to_string()))?;
            let timestamp = gix_time_to_chrono(time);
            let parents: Vec<String> = commit.parent_ids().map(|id| id.to_string()).collect();

            nodes.push(GraphNode {
                id: oid.to_string(),
                message: message.trim().to_string(),
                timestamp,
                timeline: timeline.name.clone(),
                parents,
                lane: timeline.color_index,
                is_head: head_oid.map_or(false, |h| h == oid),
            });

            current = commit.parent_ids().next().map(|id| id.detach());
        }
    }

    // Include commits from prev-tip chain (rewound "future" commits)
    if let Some(prev_tip) = load_prev_tip(project_dir) {
        let active_name = active_timeline
            .map(|t| t.name.clone())
            .unwrap_or_else(|| MAIN_BRANCH.to_string());
        let active_lane = active_timeline.map(|t| t.color_index).unwrap_or(0);

        let mut current = Some(prev_tip);
        while let Some(oid) = current {
            if !seen.insert(oid) {
                break; // Already visited (shared with current branch)
            }

            let commit = repo
                .find_commit(oid)
                .map_err(|e| VersioningError::Git(e.to_string()))?;

            let message = commit.message_raw_sloppy().to_string();
            let time = commit
                .time()
                .map_err(|e| VersioningError::Git(e.to_string()))?;
            let timestamp = gix_time_to_chrono(time);
            let parents: Vec<String> = commit.parent_ids().map(|id| id.to_string()).collect();

            nodes.push(GraphNode {
                id: oid.to_string(),
                message: message.trim().to_string(),
                timestamp,
                timeline: active_name.clone(),
                parents,
                lane: active_lane,
                is_head: false,
            });

            current = commit.parent_ids().next().map(|id| id.detach());
        }
    }

    // Ensure the HEAD commit is attributed to the active timeline
    // (it may have been claimed by a different timeline that walked it first)
    if let (Some(h_oid), Some(active)) = (head_oid, active_timeline) {
        let h_str = h_oid.to_string();
        if let Some(head_node) = nodes.iter_mut().find(|n| n.id == h_str) {
            if head_node.timeline != active.name {
                head_node.timeline = active.name.clone();
                head_node.lane = active.color_index;
            }
        }
    }

    // Sort by timestamp descending (newest first)
    nodes.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(nodes)
}

// ── Internal helpers ────────────────────────────────────────────────

fn open_repo(project_dir: &Path) -> Result<gix::Repository, VersioningError> {
    gix::open(project_dir).map_err(|e| VersioningError::Git(e.to_string()))
}

fn slugify_timeline_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string()
}

fn set_head_to_branch(repo: &gix::Repository, ref_name: &str) -> Result<(), VersioningError> {
    let head_path = repo.git_dir().join("HEAD");
    let content = format!("ref: {}\n", ref_name);
    std::fs::write(&head_path, content).map_err(|e| VersioningError::Io(e.to_string()))
}

/// Check whether `ancestor` is an ancestor of `descendant` by walking the commit chain.
fn is_ancestor(
    repo: &gix::Repository,
    ancestor: gix::ObjectId,
    descendant: gix::ObjectId,
) -> Result<bool, VersioningError> {
    let mut current = Some(descendant);
    while let Some(oid) = current {
        if oid == ancestor {
            return Ok(true);
        }
        let commit = repo
            .find_commit(oid)
            .map_err(|e| VersioningError::Git(e.to_string()))?;
        current = commit.parent_ids().next().map(|p| p.detach());
    }
    Ok(false)
}

fn get_current_branch_name(repo: &gix::Repository) -> Option<String> {
    let head_path = repo.git_dir().join("HEAD");
    let content = std::fs::read_to_string(&head_path).ok()?;
    if content.starts_with("ref: ") {
        let ref_name = content.trim().strip_prefix("ref: ")?;
        // Return just the branch name part after refs/heads/
        Some(ref_name.strip_prefix("refs/heads/").unwrap_or(ref_name).to_string())
    } else {
        None // Detached HEAD
    }
}

fn count_commits_on_ref(repo: &gix::Repository, ref_name: &str) -> Result<usize, VersioningError> {
    let oid = if ref_name == "HEAD" {
        match repo.head_commit() {
            Ok(c) => c.id().detach(),
            Err(_) => return Ok(0),
        }
    } else {
        match repo.find_reference(ref_name) {
            Ok(r) => r.id().detach(),
            Err(_) => return Ok(0),
        }
    };

    let mut count = 0;
    let mut current = Some(oid);
    while let Some(id) = current {
        count += 1;
        let commit = repo.find_commit(id).map_err(|e| VersioningError::Git(e.to_string()))?;
        current = commit.parent_ids().next().map(|p| p.detach());
    }
    Ok(count)
}

/// Timeline label storage — simple file in .git/cutready-timeline-labels (key=value lines)
fn labels_path(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join(".git").join("cutready-timeline-labels")
}

fn load_timeline_labels(project_dir: &Path) -> std::collections::HashMap<String, String> {
    let path = labels_path(project_dir);
    let mut map = std::collections::HashMap::new();
    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            if let Some((key, value)) = line.split_once('=') {
                map.insert(key.to_string(), value.to_string());
            }
        }
    }
    map
}

fn save_timeline_label(project_dir: &Path, slug: &str, label: &str) -> Result<(), VersioningError> {
    let mut labels = load_timeline_labels(project_dir);
    labels.insert(slug.to_string(), label.to_string());
    write_timeline_labels(project_dir, &labels)
}

fn remove_timeline_label(project_dir: &Path, slug: &str) {
    let mut labels = load_timeline_labels(project_dir);
    labels.remove(slug);
    let _ = write_timeline_labels(project_dir, &labels);
}

fn write_timeline_labels(
    project_dir: &Path,
    labels: &std::collections::HashMap<String, String>,
) -> Result<(), VersioningError> {
    let path = labels_path(project_dir);
    let content: String = labels.iter().map(|(k, v)| format!("{}={}", k, v)).collect::<Vec<_>>().join("\n");
    std::fs::write(&path, content).map_err(|e| VersioningError::Io(e.to_string()))
}

/// Path to the prev-tip file (stores OID of the original branch tip before rewind).
fn prev_tip_path(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join(".git").join("cutready-prev-tip")
}

/// Save the previous branch tip before rewinding (only if not already set).
fn save_prev_tip(project_dir: &Path, oid: gix::ObjectId) -> Result<(), VersioningError> {
    let path = prev_tip_path(project_dir);
    if !path.exists() {
        std::fs::write(&path, oid.to_string())
            .map_err(|e| VersioningError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Load the previous branch tip OID (if any).
fn load_prev_tip(project_dir: &Path) -> Option<gix::ObjectId> {
    let path = prev_tip_path(project_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Clear the prev-tip file (after committing or fully navigating forward).
fn clear_prev_tip(project_dir: &Path) {
    let path = prev_tip_path(project_dir);
    let _ = std::fs::remove_file(&path);
}

/// Reset a branch ref to a specific commit OID on disk.
fn reset_branch_ref(
    repo: &gix::Repository,
    branch_name: &str,
    target_oid: gix::ObjectId,
) -> Result<(), VersioningError> {
    let branch_ref = format!("refs/heads/{}", branch_name);
    let mut ref_path = repo.git_dir().to_path_buf();
    for component in branch_ref.split('/') {
        ref_path = ref_path.join(component);
    }
    if let Some(parent) = ref_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| VersioningError::Io(e.to_string()))?;
    }
    std::fs::write(&ref_path, format!("{}\n", target_oid))
        .map_err(|e| VersioningError::Io(e.to_string()))
}

/// Build a git tree object from a directory on disk (recursive).
/// Skips hidden files/dirs (starting with '.').
fn build_tree_from_dir(
    repo: &gix::Repository,
    root: &Path,
    dir: &Path,
) -> Result<gix::ObjectId, VersioningError> {
    let mut entries: Vec<gix::objs::tree::Entry> = Vec::new();

    let read_dir = std::fs::read_dir(dir).map_err(|e| VersioningError::Io(e.to_string()))?;

    for fs_entry in read_dir {
        let fs_entry = fs_entry.map_err(|e| VersioningError::Io(e.to_string()))?;
        let path = fs_entry.path();
        let name = fs_entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            let sub_tree_id = build_tree_from_dir(repo, root, &path)?;
            entries.push(gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Tree.into(),
                filename: name.into(),
                oid: sub_tree_id,
            });
        } else if path.is_file() {
            let data = std::fs::read(&path).map_err(|e| VersioningError::Io(e.to_string()))?;
            let blob_id: gix::ObjectId = repo
                .write_blob(&data)
                .map_err(|e| VersioningError::Git(e.to_string()))?
                .into();
            entries.push(gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Blob.into(),
                filename: name.into(),
                oid: blob_id,
            });
        }
    }

    // gix requires entries sorted by name (with special dir sorting rules)
    entries.sort();

    let tree = gix::objs::Tree { entries };
    let tree_id = repo
        .write_object(&tree)
        .map_err(|e| VersioningError::Git(e.to_string()))?
        .detach();

    Ok(tree_id)
}

fn gix_time_to_chrono(time: gix::date::Time) -> DateTime<Utc> {
    Utc.timestamp_opt(time.seconds, 0)
        .single()
        .unwrap_or_else(Utc::now)
}

/// Remove all non-hidden files/dirs from the project directory.
fn clean_working_dir(project_dir: &Path) -> Result<(), VersioningError> {
    for entry in std::fs::read_dir(project_dir).map_err(|e| VersioningError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| VersioningError::Io(e.to_string()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| VersioningError::Io(e.to_string()))?;
        } else {
            std::fs::remove_file(&path).map_err(|e| VersioningError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

/// Write a git tree's contents to a directory on disk (recursive).
fn write_tree_to_dir(
    repo: &gix::Repository,
    tree_id: gix::ObjectId,
    dir: &Path,
) -> Result<(), VersioningError> {
    let object = repo
        .find_object(tree_id)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let tree = object
        .try_into_tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    for entry_result in tree.iter() {
        let entry = entry_result.map_err(|e| VersioningError::Git(e.to_string()))?;
        let name = String::from_utf8_lossy(entry.filename()).to_string();
        let path = dir.join(&name);
        let oid = entry.oid().to_owned();
        let mode = entry.mode();

        if mode.is_tree() {
            std::fs::create_dir_all(&path).map_err(|e| VersioningError::Io(e.to_string()))?;
            write_tree_to_dir(repo, oid, &path)?;
        } else if mode.is_blob() {
            let blob = repo
                .find_object(oid)
                .map_err(|e| VersioningError::Git(e.to_string()))?;
            std::fs::write(&path, &blob.data).map_err(|e| VersioningError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_project_dir() -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 1}"#,
        )
        .unwrap();
        tmp
    }

    #[test]
    fn init_creates_git_repo() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();
        assert!(tmp.path().join(".git").exists());
    }

    #[test]
    fn commit_and_list_versions() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "Initial commit", None).unwrap();
        assert!(!id1.is_empty());

        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 2}"#,
        )
        .unwrap();
        let id2 = commit_snapshot(tmp.path(), "Update version", None).unwrap();
        assert_ne!(id1, id2);

        let versions = list_versions(tmp.path()).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].message, "Update version");
        assert_eq!(versions[1].message, "Initial commit");
    }

    #[test]
    fn list_versions_empty_repo() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();
        let versions = list_versions(tmp.path()).unwrap();
        assert!(versions.is_empty());
    }

    #[test]
    fn get_file_at_version() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();

        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 2}"#,
        )
        .unwrap();
        let _id2 = commit_snapshot(tmp.path(), "v2", None).unwrap();

        let data = super::get_file_at_version(tmp.path(), &id1, "project.json").unwrap();
        let content = String::from_utf8(data).unwrap();
        assert!(content.contains("\"version\": 1"));
    }

    #[test]
    fn restore_version_works() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();

        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 2}"#,
        )
        .unwrap();
        commit_snapshot(tmp.path(), "v2", None).unwrap();

        restore_version(tmp.path(), &id1).unwrap();

        let content = std::fs::read_to_string(tmp.path().join("project.json")).unwrap();
        assert!(content.contains("\"version\": 1"));

        let versions = list_versions(tmp.path()).unwrap();
        assert_eq!(versions.len(), 3);
        assert!(versions[0].message.contains("Restored"));
    }

    #[test]
    fn commit_with_subdirectories() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let docs_dir = tmp.path().join("documents");
        std::fs::create_dir_all(&docs_dir).unwrap();
        std::fs::write(docs_dir.join("doc1.json"), r#"{"title": "Doc 1"}"#).unwrap();

        let id = commit_snapshot(tmp.path(), "With subdirs", None).unwrap();
        assert!(!id.is_empty());

        let data = super::get_file_at_version(tmp.path(), &id, "documents/doc1.json").unwrap();
        let content = String::from_utf8(data).unwrap();
        assert!(content.contains("Doc 1"));
    }

    #[test]
    fn restore_version_restores_full_tree() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        // v1: project.json + a sketch file
        let sketches_dir = tmp.path().join("sketches");
        std::fs::create_dir_all(&sketches_dir).unwrap();
        std::fs::write(sketches_dir.join("intro.sk"), r#"{"title":"Intro v1"}"#).unwrap();
        let id1 = commit_snapshot(tmp.path(), "v1 with sketch", None).unwrap();

        // v2: modify sketch and add another
        std::fs::write(sketches_dir.join("intro.sk"), r#"{"title":"Intro v2"}"#).unwrap();
        std::fs::write(sketches_dir.join("outro.sk"), r#"{"title":"Outro"}"#).unwrap();
        commit_snapshot(tmp.path(), "v2 modified", None).unwrap();

        // Verify v2 state
        assert!(sketches_dir.join("outro.sk").exists());

        // Restore to v1
        restore_version(tmp.path(), &id1).unwrap();

        // intro.sk should be v1 content
        let intro = std::fs::read_to_string(sketches_dir.join("intro.sk")).unwrap();
        assert!(intro.contains("Intro v1"));

        // outro.sk should NOT exist (wasn't in v1)
        assert!(!sketches_dir.join("outro.sk").exists());
    }

    #[test]
    fn stash_and_pop_working_tree() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        // Commit baseline
        commit_snapshot(tmp.path(), "baseline", None).unwrap();

        // Make edits
        std::fs::write(tmp.path().join("project.json"), r#"{"name":"dirty","version":99}"#).unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "some notes").unwrap();
        assert!(has_unsaved_changes(tmp.path()).unwrap());

        // Stash
        stash_working_tree(tmp.path()).unwrap();
        assert!(tmp.path().join(".git").join("cutready-stash").exists());

        // Checkout baseline (wipes working tree to committed state)
        let versions = list_versions(tmp.path()).unwrap();
        checkout_version(tmp.path(), &versions[0].id).unwrap();
        let content = std::fs::read_to_string(tmp.path().join("project.json")).unwrap();
        assert!(content.contains("\"version\": 1")); // baseline content
        assert!(!tmp.path().join("notes.txt").exists());

        // Pop stash — restores dirty edits
        let had_stash = pop_stash(tmp.path()).unwrap();
        assert!(had_stash);
        let content = std::fs::read_to_string(tmp.path().join("project.json")).unwrap();
        assert!(content.contains("\"version\":99"));
        assert!(tmp.path().join("notes.txt").exists());
        assert!(!tmp.path().join(".git").join("cutready-stash").exists());

        // Pop again — no stash
        assert!(!pop_stash(tmp.path()).unwrap());
    }

    #[test]
    fn create_and_list_timelines() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();
        commit_snapshot(tmp.path(), "v2", None).unwrap();

        // Initially just "Main" timeline
        let timelines = list_timelines(tmp.path()).unwrap();
        assert_eq!(timelines.len(), 1);
        assert_eq!(timelines[0].label, "Main");
        assert!(timelines[0].is_active);
        assert_eq!(timelines[0].snapshot_count, 2);

        // Create a new timeline from v1
        create_timeline(tmp.path(), &id1, "Exploration").unwrap();

        let timelines = list_timelines(tmp.path()).unwrap();
        assert_eq!(timelines.len(), 2);

        // New timeline should be active
        let active: Vec<_> = timelines.iter().filter(|t| t.is_active).collect();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].label, "Exploration");
    }

    #[test]
    fn switch_and_delete_timeline() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();
        std::fs::write(tmp.path().join("project.json"), r#"{"name":"test","version":2}"#).unwrap();
        commit_snapshot(tmp.path(), "v2", None).unwrap();

        // Create exploration from v1
        create_timeline(tmp.path(), &id1, "Exploration").unwrap();

        // We're on the exploration timeline; project.json should be v1 content
        let content = std::fs::read_to_string(tmp.path().join("project.json")).unwrap();
        assert!(content.contains("\"version\": 1"));

        // Switch back to main
        switch_timeline(tmp.path(), "main").unwrap();
        let content = std::fs::read_to_string(tmp.path().join("project.json")).unwrap();
        assert!(content.contains("\"version\":2") || content.contains("\"version\": 2"));

        // Delete exploration
        delete_timeline(tmp.path(), "exploration").unwrap();
        let timelines = list_timelines(tmp.path()).unwrap();
        assert_eq!(timelines.len(), 1);
        assert_eq!(timelines[0].label, "Main");
    }

    #[test]
    fn timeline_graph_shows_all_branches() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();
        std::fs::write(tmp.path().join("project.json"), r#"{"name":"test","version":2}"#).unwrap();
        commit_snapshot(tmp.path(), "v2", None).unwrap();

        // Create exploration from v1 and add a commit there
        create_timeline(tmp.path(), &id1, "Exploration").unwrap();
        std::fs::write(tmp.path().join("project.json"), r#"{"name":"test","version":3}"#).unwrap();
        commit_snapshot(tmp.path(), "v3 on exploration", None).unwrap();

        let graph = get_timeline_graph(tmp.path()).unwrap();
        // Should have: v1 (shared), v2 (main), v3 (exploration)
        assert!(graph.len() >= 3);

        let messages: Vec<&str> = graph.iter().map(|n| n.message.as_str()).collect();
        assert!(messages.contains(&"v1"));
        assert!(messages.contains(&"v2"));
        assert!(messages.contains(&"v3 on exploration"));
    }

    #[test]
    fn navigate_backward_defers_fork_until_commit() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();
        std::fs::write(tmp.path().join("project.json"), r#"{"version":2}"#).unwrap();
        let id2 = commit_snapshot(tmp.path(), "v2", None).unwrap();
        std::fs::write(tmp.path().join("project.json"), r#"{"version":3}"#).unwrap();
        let _id3 = commit_snapshot(tmp.path(), "v3", None).unwrap();

        // Navigate backward to v1 — should NOT create a fork
        navigate_to_snapshot(tmp.path(), &id1).unwrap();

        let versions = list_versions(tmp.path()).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, id1);

        let timelines = list_timelines(tmp.path()).unwrap();
        assert_eq!(timelines.len(), 1, "No fork yet — just navigation");

        // The "future" commits should still be visible in the graph
        let graph = get_timeline_graph(tmp.path()).unwrap();
        assert!(graph.len() >= 3, "Graph should show all commits via prev-tip");

        // Navigate forward to v2 — should work without issues
        navigate_to_snapshot(tmp.path(), &id2).unwrap();
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Clean after forward nav");

        // Navigate back to v1 again
        navigate_to_snapshot(tmp.path(), &id1).unwrap();

        // Now commit new work — THIS should create the fork
        std::fs::write(tmp.path().join("project.json"), r#"{"version":"new"}"#).unwrap();
        let _new_id = commit_snapshot(tmp.path(), "new direction", None).unwrap();

        let timelines = list_timelines(tmp.path()).unwrap();
        assert!(timelines.len() >= 2, "Fork created on commit, got {}", timelines.len());
        // The fork is for the NEW direction (not "before rewind" anymore)
        let fork = timelines.iter().find(|t| t.name != "main");
        assert!(fork.is_some(), "Expected a fork timeline after commit from rewound state");
    }

    #[test]
    fn commit_with_custom_fork_label() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();
        std::fs::write(tmp.path().join("project.json"), r#"{"v":2}"#).unwrap();
        let _id2 = commit_snapshot(tmp.path(), "v2", None).unwrap();

        navigate_to_snapshot(tmp.path(), &id1).unwrap();
        assert!(is_rewound(tmp.path()), "Should be rewound after backward nav");

        std::fs::write(tmp.path().join("project.json"), r#"{"v":"alt"}"#).unwrap();
        let _id3 = commit_snapshot(tmp.path(), "alternative approach", Some("Original plan")).unwrap();

        let timelines = list_timelines(tmp.path()).unwrap();
        // The user's label is on the NEW fork branch (the active one)
        let fork = timelines.iter().find(|t| t.name != "main");
        assert!(fork.is_some(), "Fork should exist");
        assert_eq!(fork.unwrap().label, "Original plan", "Should use custom label");
        assert!(!is_rewound(tmp.path()), "prev-tip cleared after commit");
    }

    #[test]
    fn navigate_to_current_head_is_noop() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1", None).unwrap();

        // Navigate to HEAD — should not create any forks
        navigate_to_snapshot(tmp.path(), &id1).unwrap();

        let timelines = list_timelines(tmp.path()).unwrap();
        assert_eq!(timelines.len(), 1, "Should still have only main timeline");
    }

    #[test]
    fn has_stash_check() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();
        commit_snapshot(tmp.path(), "v1", None).unwrap();

        assert!(!has_stash(tmp.path()));

        stash_working_tree(tmp.path()).unwrap();
        assert!(has_stash(tmp.path()));

        pop_stash(tmp.path()).unwrap();
        assert!(!has_stash(tmp.path()));
    }

    /// Full end-to-end workflow test simulating real user behaviour:
    /// 1. Create project with a sketch file
    /// 2. Save 3 snapshots with different content
    /// 3. Navigate backward — verify files, dirty state, NO fork yet
    /// 4. Navigate forward/backward freely — still no fork
    /// 5. Make edits and save new snapshot — fork created on commit
    /// 6. Navigate to a commit on the forked timeline — cross-timeline nav
    /// 7. Verify graph shows everything
    #[test]
    fn full_workflow_navigate_edit_crossbranch() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        // Simulate sketch file like the real app
        let sketch = r#"{"title":"Start","rows":[{"text":"row1"}]}"#;
        std::fs::write(tmp.path().join("start.sk"), sketch).unwrap();
        let id1 = commit_snapshot(tmp.path(), "row one", None).unwrap();

        let sketch2 = r#"{"title":"Start","rows":[{"text":"row1"},{"text":"row2"}]}"#;
        std::fs::write(tmp.path().join("start.sk"), sketch2).unwrap();
        let id2 = commit_snapshot(tmp.path(), "row two", None).unwrap();

        let sketch3 = r#"{"title":"Start","rows":[{"text":"row1"},{"text":"row2"},{"text":"row3"}]}"#;
        std::fs::write(tmp.path().join("start.sk"), sketch3).unwrap();
        let id3 = commit_snapshot(tmp.path(), "row three", None).unwrap();

        // Verify: HEAD is at id3, 3 versions, file has 3 rows
        assert_eq!(list_versions(tmp.path()).unwrap().len(), 3);
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Should be clean after commit");

        // === Navigate backward to id1 ===
        navigate_to_snapshot(tmp.path(), &id1).unwrap();

        // File on disk should match id1's content
        let disk = std::fs::read_to_string(tmp.path().join("start.sk")).unwrap();
        assert!(disk.contains("row1"), "File should contain row1");
        assert!(!disk.contains("row2"), "File should NOT contain row2 after navigating to id1");
        assert!(!disk.contains("row3"), "File should NOT contain row3 after navigating to id1");

        // Should NOT be dirty (file matches HEAD)
        assert!(!has_unsaved_changes(tmp.path()).unwrap(),
            "Should be clean right after navigating — file matches HEAD");

        // list_versions should show only id1 (that's where main points now)
        let versions = list_versions(tmp.path()).unwrap();
        assert_eq!(versions.len(), 1, "Main should have 1 commit after rewind");
        assert_eq!(versions[0].id, id1);

        // NO fork yet — just navigation, no new work
        let timelines = list_timelines(tmp.path()).unwrap();
        assert_eq!(timelines.len(), 1, "No fork until we commit new work");

        // But the graph should show all commits (via prev-tip)
        let graph = get_timeline_graph(tmp.path()).unwrap();
        assert!(graph.len() >= 3, "Graph should have at least 3 nodes via prev-tip");
        let head_nodes: Vec<_> = graph.iter().filter(|n| n.is_head).collect();
        assert_eq!(head_nodes.len(), 1, "Exactly one HEAD node");
        assert_eq!(head_nodes[0].id, id1, "HEAD should be id1");

        // Navigate forward to id2 — should work
        navigate_to_snapshot(tmp.path(), &id2).unwrap();
        let disk = std::fs::read_to_string(tmp.path().join("start.sk")).unwrap();
        assert!(disk.contains("row2"), "Should have row2 after forward nav");
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Clean after forward nav");

        // Navigate back to id1 again
        navigate_to_snapshot(tmp.path(), &id1).unwrap();

        // === Edit and save new work from id1 — THIS creates the fork ===
        let sketch_new = r#"{"title":"Start","rows":[{"text":"row1"},{"text":"new direction"}]}"#;
        std::fs::write(tmp.path().join("start.sk"), sketch_new).unwrap();
        assert!(has_unsaved_changes(tmp.path()).unwrap(), "Should be dirty after editing");

        let id4 = commit_snapshot(tmp.path(), "new direction", None).unwrap();
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Should be clean after saving");

        // Fork should now exist (new direction goes on the fork, main keeps original)
        let timelines = list_timelines(tmp.path()).unwrap();
        assert!(timelines.len() >= 2, "Should have main + fork after commit");
        let fork = timelines.iter().find(|t| t.name != "main");
        assert!(fork.is_some(), "Fork should exist for new direction");

        // HEAD is now on the fork branch with id4
        // Main still has id1, id2, id3 (original commits)
        // The fork has id4 → id1 (branched from id1)

        // === Navigate to id3 (on the fork) — cross-timeline ===
        navigate_to_snapshot(tmp.path(), &id3).unwrap();

        // File should have 3 rows again
        let disk = std::fs::read_to_string(tmp.path().join("start.sk")).unwrap();
        assert!(disk.contains("row3"), "After cross-timeline nav, file should have row3");

        // Should NOT be dirty
        assert!(!has_unsaved_changes(tmp.path()).unwrap(),
            "Should be clean after cross-timeline navigation");

        // Graph should still show everything
        let graph = get_timeline_graph(tmp.path()).unwrap();
        let head_nodes: Vec<_> = graph.iter().filter(|n| n.is_head).collect();
        assert_eq!(head_nodes.len(), 1, "Still exactly one HEAD");

        // id2 should also be navigable
        navigate_to_snapshot(tmp.path(), &id2).unwrap();
        let disk = std::fs::read_to_string(tmp.path().join("start.sk")).unwrap();
        assert!(disk.contains("row2"), "Should have row2");
        assert!(!disk.contains("row3"), "Should NOT have row3");
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Clean after nav to id2");
    }

    /// Navigate back to initial (empty) commit — working dir should be clean and match commit tree.
    #[test]
    fn navigate_to_empty_initial_commit() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        // Initial commit includes project.json from setup_project_dir
        let init_id = commit_snapshot(tmp.path(), "Init", None).unwrap();

        // Create a sketch file and commit
        std::fs::write(tmp.path().join("sketch.sk"), r#"{"title":"Test"}"#).unwrap();
        let _id2 = commit_snapshot(tmp.path(), "Added sketch", None).unwrap();

        // Navigate back to the initial commit
        navigate_to_snapshot(tmp.path(), &init_id).unwrap();

        // Working dir should NOT contain sketch.sk (only project.json from init)
        let files: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        assert!(!files.contains(&"sketch.sk".to_string()),
            "sketch.sk should not exist after navigating to initial commit");
        assert!(files.contains(&"project.json".to_string()),
            "project.json should still exist from initial commit");

        // Should NOT be dirty
        assert!(!has_unsaved_changes(tmp.path()).unwrap(),
            "Should be clean after navigating to initial commit");
    }

    /// Simulate the debounce race: navigate backward, then write stale data.
    /// Verifies that has_unsaved_changes correctly detects the stale write.
    #[test]
    fn stale_write_after_navigation_detected_as_dirty() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let sketch_v1 = r#"{"title":"V1","rows":[]}"#;
        std::fs::write(tmp.path().join("demo.sk"), sketch_v1).unwrap();
        let id1 = commit_snapshot(tmp.path(), "version 1", None).unwrap();

        let sketch_v2 = r#"{"title":"V2","rows":[{"text":"added"}]}"#;
        std::fs::write(tmp.path().join("demo.sk"), sketch_v2).unwrap();
        let _id2 = commit_snapshot(tmp.path(), "version 2", None).unwrap();

        // Navigate back to v1
        navigate_to_snapshot(tmp.path(), &id1).unwrap();
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Clean after nav");

        // Simulate debounce race: stale write puts V2 content back
        std::fs::write(tmp.path().join("demo.sk"), sketch_v2).unwrap();
        assert!(has_unsaved_changes(tmp.path()).unwrap(),
            "Should be dirty after stale write — this is the bug the frontend fix prevents");

        // Navigate to same commit again to re-checkout (like a refresh)
        navigate_to_snapshot(tmp.path(), &id1).unwrap();
        let disk = std::fs::read_to_string(tmp.path().join("demo.sk")).unwrap();
        assert!(disk.contains("V1"), "File should be V1 after re-checkout");
        assert!(!has_unsaved_changes(tmp.path()).unwrap(), "Clean after re-checkout");
    }

    /// Shared ancestor commits should be attributed to the main timeline, not to forks.
    #[test]
    fn shared_ancestors_attributed_to_main() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        // Create commits on main
        std::fs::write(tmp.path().join("a.txt"), "one").unwrap();
        let id1 = commit_snapshot(tmp.path(), "one", None).unwrap();

        std::fs::write(tmp.path().join("a.txt"), "two").unwrap();
        let _id2 = commit_snapshot(tmp.path(), "two", None).unwrap();

        // Navigate backward to id1
        navigate_to_snapshot(tmp.path(), &id1).unwrap();

        // Make changes and commit with a fork label (creates a branch)
        std::fs::write(tmp.path().join("b.txt"), "branch work").unwrap();
        let _branch_id = commit_snapshot(tmp.path(), "branch first", Some("experiment")).unwrap();

        // Now get the graph
        let graph = get_timeline_graph(tmp.path()).unwrap();

        // Find the "one" commit (shared ancestor) — it should be on "main" timeline
        let one_node = graph.iter().find(|n| n.message == "one").unwrap();
        assert_eq!(one_node.timeline, "main",
            "Shared ancestor 'one' should be attributed to main, got '{}'", one_node.timeline);

        // "two" should also stay on main (it was the original main tip, now on prev-tip fork → main still reaches it)
        let two_node = graph.iter().find(|n| n.message == "two").unwrap();
        assert_eq!(two_node.timeline, "main",
            "Original main commit 'two' should stay on main, got '{}'", two_node.timeline);

        // The branch-specific commit should be on the fork timeline
        let branch_node = graph.iter().find(|n| n.message == "branch first").unwrap();
        assert_ne!(branch_node.timeline, "main",
            "Branch commit should NOT be on main");
    }
}
