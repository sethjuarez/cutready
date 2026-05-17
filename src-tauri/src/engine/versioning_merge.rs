//! Three-way merge engine for CutReady timelines.
//!
//! Uses git2's merge infrastructure to perform three-way merges between
//! timeline branches. Detects conflicts and classifies them by file type
//! (sketch, storyboard, note, other) so the frontend can render
//! appropriate conflict resolvers.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::engine::versioning::VersioningError;

// ── Data types ──────────────────────────────────────────────────────

/// File type classification for conflict resolution strategy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictFileType {
    Sketch,
    Storyboard,
    Note,
    Other,
}

/// A single conflicting field within a JSON file (sketch or storyboard).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldConflict {
    /// JSON path to the conflicting field (e.g. "title", "description", "planning[2].narrative")
    pub field_path: String,
    /// Value from target branch (ours / main)
    pub ours: serde_json::Value,
    /// Value from source branch (theirs / fork)
    pub theirs: serde_json::Value,
    /// Value from common ancestor
    pub ancestor: serde_json::Value,
}

/// A conflicting region in a text file (note/markdown).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextConflictRegion {
    /// Line number where the conflict starts (0-indexed in the ancestor)
    pub start_line: usize,
    /// Lines from target branch (ours)
    pub ours_lines: Vec<String>,
    /// Lines from source branch (theirs)
    pub theirs_lines: Vec<String>,
    /// Lines from common ancestor
    pub ancestor_lines: Vec<String>,
}

/// A file with merge conflicts, classified by type with structured diff data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictFile {
    /// Path relative to project root (e.g. "sketches/intro.sk")
    pub path: String,
    /// File type classification
    pub file_type: ConflictFileType,
    /// Raw content from target branch (ours)
    pub ours: String,
    /// Raw content from source branch (theirs)
    pub theirs: String,
    /// Raw content from common ancestor (empty if file is new on one side)
    pub ancestor: String,
    /// Structured field-level conflicts (for sketch/storyboard JSON files)
    pub field_conflicts: Vec<FieldConflict>,
    /// Structured text-level conflicts (for note/markdown files)
    pub text_conflicts: Vec<TextConflictRegion>,
}

/// Result of a merge operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum MergeResult {
    /// Merge completed without conflicts — a merge commit was created.
    #[serde(rename = "clean")]
    Clean { commit_id: String },
    /// Merge has conflicts that need manual resolution.
    #[serde(rename = "conflicts")]
    Conflicts { conflicts: Vec<ConflictFile> },
    /// Fast-forward: source is a direct descendant of target (no merge commit needed).
    #[serde(rename = "fast_forward")]
    FastForward { commit_id: String },
    /// Nothing to merge: branches point at the same commit.
    #[serde(rename = "nothing")]
    Nothing,
}

/// A user's resolution for a single file conflict.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileResolution {
    /// Path matching ConflictFile.path
    pub path: String,
    /// Resolved content to write
    pub content: String,
}

/// Which side to pick for a conflict region.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// User choices for resolving a single file's conflicts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictChoices {
    /// For text files: map of region index → side
    #[serde(default)]
    pub text_choices: std::collections::HashMap<usize, ConflictSide>,
    /// For JSON files: map of field_path → side
    #[serde(default)]
    pub field_choices: std::collections::HashMap<String, ConflictSide>,
}

// ── Constants ───────────────────────────────────────────────────────

const TIMELINE_PREFIX: &str = "refs/heads/timeline/";
const MAIN_BRANCH: &str = "main";

// ── Core merge engine ───────────────────────────────────────────────

/// Perform a three-way merge of `source_timeline` into `target_timeline`.
///
/// - If no common ancestor exists, returns an error.
/// - If source == target tip, returns `Nothing`.
/// - If source is a descendant of target, returns `FastForward`.
/// - Otherwise, performs a three-way merge using git2.
///   - Clean → creates merge commit, returns `Clean`.
///   - Conflicts → returns `Conflicts` with structured diff data.
pub fn merge_timelines(
    project_dir: &Path,
    source_timeline: &str,
    target_timeline: &str,
) -> Result<MergeResult, VersioningError> {
    let repo =
        git2::Repository::open(project_dir).map_err(|e| VersioningError::Git(e.to_string()))?;

    // Resolve branch refs
    let source_ref = timeline_ref_name(source_timeline);
    let target_ref = timeline_ref_name(target_timeline);

    let source_oid = resolve_ref_oid(&repo, &source_ref)?;
    let target_oid = resolve_ref_oid(&repo, &target_ref)?;

    // Same commit — nothing to do
    if source_oid == target_oid {
        return Ok(MergeResult::Nothing);
    }

    // Find merge base (common ancestor)
    let base_oid = repo
        .merge_base(source_oid, target_oid)
        .map_err(|e| VersioningError::Git(format!("No common ancestor: {}", e)))?;

    // Fast-forward check: source is descendant of target
    if base_oid == target_oid {
        // Target can fast-forward to source
        update_branch_ref(&repo, &target_ref, source_oid)?;

        // If target is active branch, update working directory
        checkout_to_working_dir(project_dir, &repo, source_oid)?;

        return Ok(MergeResult::FastForward {
            commit_id: source_oid.to_string(),
        });
    }

    // Reverse fast-forward: target is already ahead of source
    if base_oid == source_oid {
        return Ok(MergeResult::Nothing);
    }

    // Three-way merge
    let source_commit = repo
        .find_commit(source_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let target_commit = repo
        .find_commit(target_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let base_commit = repo
        .find_commit(base_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let source_tree = source_commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let target_tree = target_commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let base_tree = base_commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Perform the three-way tree merge
    let mut merge_opts = git2::MergeOptions::new();
    merge_opts.file_favor(git2::FileFavor::Normal); // Standard three-way merge
    let mut index = repo
        .merge_trees(&base_tree, &target_tree, &source_tree, Some(&merge_opts))
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    if index.has_conflicts() {
        // Collect conflict information
        let conflicts = collect_conflicts(&repo, &index, &base_tree, &target_tree, &source_tree)?;
        Ok(MergeResult::Conflicts { conflicts })
    } else {
        // Clean merge — create merge commit
        let tree_oid = index
            .write_tree_to(&repo)
            .map_err(|e| VersioningError::Git(e.to_string()))?;
        let tree = repo
            .find_tree(tree_oid)
            .map_err(|e| VersioningError::Git(e.to_string()))?;

        let sig = repo
            .signature()
            .unwrap_or_else(|_| git2::Signature::now("CutReady", "app@cutready.local").unwrap());

        let message = format!("Merge {} into {}", source_timeline, target_timeline);
        let commit_oid = repo
            .commit(
                Some(&target_ref),
                &sig,
                &sig,
                &message,
                &tree,
                &[&target_commit, &source_commit],
            )
            .map_err(|e| VersioningError::Git(e.to_string()))?;

        // Update working directory
        checkout_to_working_dir(project_dir, &repo, commit_oid)?;

        Ok(MergeResult::Clean {
            commit_id: commit_oid.to_string(),
        })
    }
}

/// Apply user-provided conflict resolutions and create a merge commit.
///
/// Called after `merge_timelines` returns `Conflicts` and the user has
/// resolved each conflict file via the UI.
pub fn apply_merge_resolution(
    project_dir: &Path,
    source_timeline: &str,
    target_timeline: &str,
    resolutions: Vec<FileResolution>,
) -> Result<String, VersioningError> {
    let repo =
        git2::Repository::open(project_dir).map_err(|e| VersioningError::Git(e.to_string()))?;

    let source_ref = timeline_ref_name(source_timeline);
    let target_ref = timeline_ref_name(target_timeline);

    let source_oid = resolve_ref_oid(&repo, &source_ref)?;
    let target_oid = resolve_ref_oid(&repo, &target_ref)?;
    let base_oid = repo
        .merge_base(source_oid, target_oid)
        .map_err(|e| VersioningError::Git(format!("No common ancestor: {}", e)))?;

    let source_commit = repo
        .find_commit(source_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let target_commit = repo
        .find_commit(target_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let base_commit = repo
        .find_commit(base_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Start with a three-way merge index again
    let mut merge_opts = git2::MergeOptions::new();
    merge_opts.file_favor(git2::FileFavor::Normal);
    let mut index = repo
        .merge_trees(
            &base_commit
                .tree()
                .map_err(|e| VersioningError::Git(e.to_string()))?,
            &target_commit
                .tree()
                .map_err(|e| VersioningError::Git(e.to_string()))?,
            &source_commit
                .tree()
                .map_err(|e| VersioningError::Git(e.to_string()))?,
            Some(&merge_opts),
        )
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Remove conflicts and add resolved entries
    for resolution in &resolutions {
        // Remove conflicting entries for this path
        index
            .remove_all([resolution.path.as_str()].iter(), None)
            .map_err(|e| VersioningError::Git(e.to_string()))?;

        // Write resolved content as blob
        let blob_oid = repo
            .blob(resolution.content.as_bytes())
            .map_err(|e| VersioningError::Git(e.to_string()))?;

        // Add the resolved file to the index
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100644, // Regular file
            uid: 0,
            gid: 0,
            file_size: resolution.content.len() as u32,
            id: blob_oid,
            flags: 0,
            flags_extended: 0,
            path: resolution.path.as_bytes().to_vec(),
        };
        index
            .add(&entry)
            .map_err(|e| VersioningError::Git(e.to_string()))?;
    }

    // Write the resolved tree
    let tree_oid = index
        .write_tree_to(&repo)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let sig = repo
        .signature()
        .unwrap_or_else(|_| git2::Signature::now("CutReady", "app@cutready.local").unwrap());

    let message = format!(
        "Merge {} into {} (resolved)",
        source_timeline, target_timeline
    );
    let commit_oid = repo
        .commit(
            Some(&target_ref),
            &sig,
            &sig,
            &message,
            &tree,
            &[&target_commit, &source_commit],
        )
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Write resolved files to working directory
    for resolution in &resolutions {
        let file_path = project_dir.join(&resolution.path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| VersioningError::Io(e.to_string()))?;
        }
        std::fs::write(&file_path, &resolution.content)
            .map_err(|e| VersioningError::Io(e.to_string()))?;
    }

    // Checkout the merged tree for non-conflicted files
    checkout_to_working_dir(project_dir, &repo, commit_oid)?;

    Ok(commit_oid.to_string())
}

// ── Conflict collection ─────────────────────────────────────────────

fn collect_conflicts(
    repo: &git2::Repository,
    index: &git2::Index,
    _base_tree: &git2::Tree,
    _target_tree: &git2::Tree,
    _source_tree: &git2::Tree,
) -> Result<Vec<ConflictFile>, VersioningError> {
    let mut conflicts = Vec::new();
    let git_conflicts = index
        .conflicts()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    for conflict_result in git_conflicts {
        let conflict = conflict_result.map_err(|e| VersioningError::Git(e.to_string()))?;

        // Get the path from whichever entry exists
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).to_string())
            .unwrap_or_default();

        if path.is_empty() {
            continue;
        }

        // Read content from each side
        let ancestor = read_blob_content(repo, conflict.ancestor.as_ref());
        let ours = read_blob_content(repo, conflict.our.as_ref());
        let theirs = read_blob_content(repo, conflict.their.as_ref());

        // Classify file type
        let file_type = classify_file_type(&path);

        // Generate structured diff data
        let field_conflicts = match file_type {
            ConflictFileType::Sketch | ConflictFileType::Storyboard => {
                json_field_diff(&ancestor, &ours, &theirs)
            }
            _ => Vec::new(),
        };

        let text_conflicts = match file_type {
            ConflictFileType::Note => text_line_diff(&ancestor, &ours, &theirs),
            _ => Vec::new(),
        };

        conflicts.push(ConflictFile {
            path,
            file_type,
            ours,
            theirs,
            ancestor,
            field_conflicts,
            text_conflicts,
        });
    }

    Ok(conflicts)
}

// ── JSON field-level differ ─────────────────────────────────────────

/// Compare two JSON documents against a common ancestor and return
/// only the fields where both sides made different changes.
pub fn json_field_diff(ancestor_str: &str, ours_str: &str, theirs_str: &str) -> Vec<FieldConflict> {
    let ancestor: serde_json::Value = match serde_json::from_str(ancestor_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let ours: serde_json::Value = match serde_json::from_str(ours_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let theirs: serde_json::Value = match serde_json::from_str(theirs_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut conflicts = Vec::new();
    collect_json_conflicts("", &ancestor, &ours, &theirs, &mut conflicts);
    conflicts
}

fn collect_json_conflicts(
    path: &str,
    ancestor: &serde_json::Value,
    ours: &serde_json::Value,
    theirs: &serde_json::Value,
    conflicts: &mut Vec<FieldConflict>,
) {
    match (ancestor, ours, theirs) {
        // Both are objects — recurse into each key
        (
            serde_json::Value::Object(a),
            serde_json::Value::Object(o),
            serde_json::Value::Object(t),
        ) => {
            // Collect all keys from all three
            let mut all_keys: Vec<&String> = a.keys().chain(o.keys()).chain(t.keys()).collect();
            all_keys.sort();
            all_keys.dedup();

            let null = serde_json::Value::Null;
            for key in all_keys {
                let a_val = a.get(key).unwrap_or(&null);
                let o_val = o.get(key).unwrap_or(&null);
                let t_val = t.get(key).unwrap_or(&null);
                let field_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", path, key)
                };
                collect_json_conflicts(&field_path, a_val, o_val, t_val, conflicts);
            }
        }
        // Both are arrays — compare element by element
        (serde_json::Value::Array(a), serde_json::Value::Array(o), serde_json::Value::Array(t)) => {
            let max_len = a.len().max(o.len()).max(t.len());
            let null = serde_json::Value::Null;
            for i in 0..max_len {
                let a_val = a.get(i).unwrap_or(&null);
                let o_val = o.get(i).unwrap_or(&null);
                let t_val = t.get(i).unwrap_or(&null);
                let field_path = format!("{}[{}]", path, i);
                collect_json_conflicts(&field_path, a_val, o_val, t_val, conflicts);
            }
        }
        // Leaf values — check for conflict
        _ => {
            let ours_changed = ours != ancestor;
            let theirs_changed = theirs != ancestor;
            // Only a conflict if BOTH sides changed AND they changed to different values
            if ours_changed && theirs_changed && ours != theirs {
                conflicts.push(FieldConflict {
                    field_path: path.to_string(),
                    ours: ours.clone(),
                    theirs: theirs.clone(),
                    ancestor: ancestor.clone(),
                });
            }
        }
    }
}

// ── Text line-level differ ──────────────────────────────────────────

/// Compare two text files against a common ancestor line-by-line and
/// return structured conflict regions.
pub fn text_line_diff(
    ancestor_str: &str,
    ours_str: &str,
    theirs_str: &str,
) -> Vec<TextConflictRegion> {
    let ancestor_lines: Vec<&str> = ancestor_str.lines().collect();
    let ours_lines: Vec<&str> = ours_str.lines().collect();
    let theirs_lines: Vec<&str> = theirs_str.lines().collect();

    // Simple three-way diff: find regions where both sides differ from ancestor
    // Uses a line-by-line walk with longest common subsequence approximation
    let ours_hunks = compute_diff_hunks(&ancestor_lines, &ours_lines);
    let theirs_hunks = compute_diff_hunks(&ancestor_lines, &theirs_lines);

    // Find overlapping hunks — those are conflicts
    let mut conflicts = Vec::new();
    for o_hunk in &ours_hunks {
        for t_hunk in &theirs_hunks {
            // Hunks overlap if their ancestor ranges intersect
            if hunks_overlap(o_hunk, t_hunk) {
                // Check if they made the same change (not a real conflict)
                if o_hunk.new_lines == t_hunk.new_lines {
                    continue;
                }
                let start = o_hunk.ancestor_start.min(t_hunk.ancestor_start);
                let end = (o_hunk.ancestor_start + o_hunk.ancestor_count)
                    .max(t_hunk.ancestor_start + t_hunk.ancestor_count);
                conflicts.push(TextConflictRegion {
                    start_line: start,
                    ours_lines: o_hunk.new_lines.iter().map(|s| s.to_string()).collect(),
                    theirs_lines: t_hunk.new_lines.iter().map(|s| s.to_string()).collect(),
                    ancestor_lines: ancestor_lines[start..end.min(ancestor_lines.len())]
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                });
            }
        }
    }

    conflicts
}

#[derive(Debug, Clone)]
struct DiffHunk<'a> {
    ancestor_start: usize,
    ancestor_count: usize,
    new_lines: Vec<&'a str>,
}

fn hunks_overlap(a: &DiffHunk, b: &DiffHunk) -> bool {
    let a_end = a.ancestor_start + a.ancestor_count.max(1);
    let b_end = b.ancestor_start + b.ancestor_count.max(1);
    a.ancestor_start < b_end && b.ancestor_start < a_end
}

/// Compute diff hunks between an ancestor and a new version.
/// Returns a list of changed regions (hunks).
fn compute_diff_hunks<'a>(ancestor: &[&str], new: &'a [&str]) -> Vec<DiffHunk<'a>> {
    let lcs = longest_common_subsequence(ancestor, new);
    let mut hunks = Vec::new();

    let mut ai = 0;
    let mut ni = 0;
    let mut li = 0;

    while ai < ancestor.len() || ni < new.len() {
        if li < lcs.len() {
            let (la, ln) = lcs[li];
            // Collect any non-matching lines before the next LCS match
            if ai < la || ni < ln {
                let a_start = ai;
                let mut new_lines = Vec::new();
                while ai < la {
                    ai += 1;
                }
                while ni < ln {
                    new_lines.push(new[ni]);
                    ni += 1;
                }
                if ai > a_start || !new_lines.is_empty() {
                    hunks.push(DiffHunk {
                        ancestor_start: a_start,
                        ancestor_count: ai - a_start,
                        new_lines,
                    });
                }
            }
            // Skip the matching line
            ai += 1;
            ni += 1;
            li += 1;
        } else {
            // Past the last LCS match — everything remaining is a diff
            let a_start = ai;
            let mut new_lines = Vec::new();
            while ni < new.len() {
                new_lines.push(new[ni]);
                ni += 1;
            }
            let a_count = ancestor.len() - a_start;
            ai = ancestor.len();
            if a_count > 0 || !new_lines.is_empty() {
                hunks.push(DiffHunk {
                    ancestor_start: a_start,
                    ancestor_count: a_count,
                    new_lines,
                });
            }
        }
    }

    hunks
}

/// Compute the longest common subsequence as pairs of (ancestor_index, new_index).
fn longest_common_subsequence(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let m = a.len();
    let n = b.len();
    if m == 0 || n == 0 {
        return Vec::new();
    }

    // Standard DP LCS
    let mut dp = vec![vec![0u32; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            if a[i - 1] == b[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }

    // Backtrack
    let mut result = Vec::new();
    let mut i = m;
    let mut j = n;
    while i > 0 && j > 0 {
        if a[i - 1] == b[j - 1] {
            result.push((i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] > dp[i][j - 1] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    result.reverse();
    result
}

// ── Backend conflict resolution ─────────────────────────────────────

/// Resolve a single conflict file using user choices, preserving non-conflicting
/// edits from both sides via proper three-way merge.
pub fn resolve_conflict_file(
    conflict: &ConflictFile,
    choices: &ConflictChoices,
) -> Result<String, VersioningError> {
    match conflict.file_type {
        ConflictFileType::Note => resolve_text_conflict(conflict, &choices.text_choices),
        ConflictFileType::Sketch | ConflictFileType::Storyboard => {
            resolve_json_conflict(conflict, &choices.field_choices)
        }
        ConflictFileType::Other => {
            // Whole-file: any theirs choice means use theirs
            if choices.text_choices.values().any(|c| *c == ConflictSide::Theirs)
                || choices
                    .field_choices
                    .values()
                    .any(|c| *c == ConflictSide::Theirs)
            {
                Ok(conflict.theirs.clone())
            } else {
                Ok(conflict.ours.clone())
            }
        }
    }
}

/// Resolve a text file conflict by merging non-conflicting hunks from both sides
/// and applying user choices for conflicting regions.
fn resolve_text_conflict(
    conflict: &ConflictFile,
    text_choices: &std::collections::HashMap<usize, ConflictSide>,
) -> Result<String, VersioningError> {
    let ancestor_lines: Vec<&str> = conflict.ancestor.lines().collect();
    let ours_lines: Vec<&str> = conflict.ours.lines().collect();
    let theirs_lines: Vec<&str> = conflict.theirs.lines().collect();

    let ours_hunks = compute_diff_hunks(&ancestor_lines, &ours_lines);
    let theirs_hunks = compute_diff_hunks(&ancestor_lines, &theirs_lines);

    // Build a map of ancestor ranges → action
    // Each ancestor line either: stays unchanged, gets replaced by an ours hunk,
    // gets replaced by a theirs hunk, or is part of a conflict (user chooses).
    #[derive(Debug, Clone)]
    enum Action<'a> {
        Keep,                    // Use ancestor line
        Replace(Vec<&'a str>),   // Non-conflicting hunk
        Conflict(usize),         // Conflict region index — user picks
    }

    // Map ancestor line index → action
    let mut actions: Vec<Action> = vec![Action::Keep; ancestor_lines.len() + 1];

    // Mark ours-only hunks (non-conflicting)
    for o_hunk in &ours_hunks {
        let is_conflict = theirs_hunks
            .iter()
            .any(|t| hunks_overlap(o_hunk, t) && o_hunk.new_lines != t.new_lines);
        if !is_conflict {
            // This is an ours-only change — apply it
            for i in 0..o_hunk.ancestor_count {
                let idx = o_hunk.ancestor_start + i;
                if idx < actions.len() {
                    actions[idx] = Action::Replace(Vec::new()); // Mark for removal
                }
            }
            if o_hunk.ancestor_count > 0 {
                actions[o_hunk.ancestor_start] =
                    Action::Replace(o_hunk.new_lines.clone());
            } else if o_hunk.ancestor_start <= actions.len() {
                // Pure insertion at a position
                actions[o_hunk.ancestor_start] =
                    Action::Replace(o_hunk.new_lines.clone());
            }
        }
    }

    // Mark theirs-only hunks (non-conflicting)
    for t_hunk in &theirs_hunks {
        let is_conflict = ours_hunks
            .iter()
            .any(|o| hunks_overlap(o, t_hunk) && o.new_lines != t_hunk.new_lines);
        if !is_conflict {
            // Check if ours made the same change (both sides agree)
            let same_change = ours_hunks
                .iter()
                .any(|o| hunks_overlap(o, t_hunk) && o.new_lines == t_hunk.new_lines);
            if same_change {
                continue; // Already applied via ours
            }
            for i in 0..t_hunk.ancestor_count {
                let idx = t_hunk.ancestor_start + i;
                if idx < actions.len() {
                    actions[idx] = Action::Replace(Vec::new());
                }
            }
            if t_hunk.ancestor_count > 0 {
                actions[t_hunk.ancestor_start] =
                    Action::Replace(t_hunk.new_lines.clone());
            } else if t_hunk.ancestor_start <= actions.len() {
                actions[t_hunk.ancestor_start] =
                    Action::Replace(t_hunk.new_lines.clone());
            }
        }
    }

    // Mark conflict regions
    for (ci, tc) in conflict.text_conflicts.iter().enumerate() {
        for i in 0..tc.ancestor_lines.len() {
            let idx = tc.start_line + i;
            if idx < actions.len() {
                actions[idx] = Action::Replace(Vec::new()); // Clear ancestor lines
            }
        }
        // The first line of the region carries the chosen content
        if tc.start_line < actions.len() {
            actions[tc.start_line] = Action::Conflict(ci);
        }
    }

    // Build result
    let mut result: Vec<String> = Vec::new();
    for (i, action) in actions.iter().enumerate() {
        if i >= ancestor_lines.len() {
            break;
        }
        match action {
            Action::Keep => {
                result.push(ancestor_lines[i].to_string());
            }
            Action::Replace(lines) => {
                for line in lines {
                    result.push(line.to_string());
                }
            }
            Action::Conflict(ci) => {
                let tc = &conflict.text_conflicts[*ci];
                let choice = text_choices.get(ci).unwrap_or(&ConflictSide::Ours);
                let chosen = match choice {
                    ConflictSide::Ours => &tc.ours_lines,
                    ConflictSide::Theirs => &tc.theirs_lines,
                };
                for line in chosen {
                    result.push(line.clone());
                }
            }
        }
    }

    Ok(result.join("\n"))
}

/// Resolve a JSON file conflict by starting from ours, applying theirs-only
/// non-conflicting changes, then applying user choices for conflicting fields.
fn resolve_json_conflict(
    conflict: &ConflictFile,
    field_choices: &std::collections::HashMap<String, ConflictSide>,
) -> Result<String, VersioningError> {
    let mut base: serde_json::Value = serde_json::from_str(&conflict.ours).map_err(|e| {
        VersioningError::Git(format!("Failed to parse ours JSON: {}", e))
    })?;
    let ancestor: serde_json::Value =
        serde_json::from_str(&conflict.ancestor).unwrap_or(serde_json::Value::Null);
    let theirs: serde_json::Value =
        serde_json::from_str(&conflict.theirs).unwrap_or(serde_json::Value::Null);

    // Collect conflict field paths for exclusion
    let conflict_paths: std::collections::HashSet<&str> = conflict
        .field_conflicts
        .iter()
        .map(|fc| fc.field_path.as_str())
        .collect();

    // Apply theirs-only non-conflicting changes:
    // Walk theirs top-level fields. If a field differs from ancestor AND
    // is not in our conflict set AND ours still matches ancestor, apply it.
    if let (Some(base_obj), Some(anc_obj), Some(theirs_obj)) = (
        base.as_object_mut(),
        ancestor.as_object(),
        theirs.as_object(),
    ) {
        for (key, theirs_val) in theirs_obj {
            if conflict_paths.contains(key.as_str()) {
                continue; // Handled below by user choice
            }
            let anc_val = anc_obj.get(key);
            // Theirs changed this field from ancestor
            if anc_val != Some(theirs_val) {
                // Only apply if ours didn't also change it (ours still matches ancestor)
                let ours_val = base_obj.get(key);
                if ours_val == anc_val {
                    base_obj.insert(key.clone(), theirs_val.clone());
                }
            }
        }
    }

    // Apply user choices for conflict fields
    for fc in &conflict.field_conflicts {
        let choice = field_choices.get(&fc.field_path).unwrap_or(&ConflictSide::Ours);
        if *choice == ConflictSide::Theirs {
            set_json_value(&mut base, &fc.field_path, &fc.theirs);
        }
        // Ours is already the default from the base
    }

    serde_json::to_string_pretty(&base).map_err(|e| {
        VersioningError::Git(format!("Failed to serialize merged JSON: {}", e))
    })
}

/// Set a value at a dot/bracket-separated JSON path.
fn set_json_value(obj: &mut serde_json::Value, path: &str, value: &serde_json::Value) {
    let parts: Vec<String> = path
        .replace('[', ".")
        .replace(']', "")
        .split('.')
        .map(|s| s.to_string())
        .collect();
    let mut current = obj;
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            // Set the value
            if let Ok(idx) = part.parse::<usize>() {
                if let Some(arr) = current.as_array_mut() {
                    if idx < arr.len() {
                        arr[idx] = value.clone();
                    }
                }
            } else if let Some(map) = current.as_object_mut() {
                map.insert(part.clone(), value.clone());
            }
        } else {
            // Navigate deeper
            if let Ok(idx) = part.parse::<usize>() {
                if let Some(arr) = current.as_array_mut() {
                    if idx < arr.len() {
                        current = &mut arr[idx];
                    } else {
                        return;
                    }
                } else {
                    return;
                }
            } else if let Some(map) = current.as_object_mut() {
                if !map.contains_key(part.as_str()) {
                    return;
                }
                current = map.get_mut(part.as_str()).unwrap();
            } else {
                return;
            }
        }
    }
}

// ── Internal helpers ────────────────────────────────────────────────

fn timeline_ref_name(timeline: &str) -> String {
    if timeline == MAIN_BRANCH || timeline == "main" {
        format!("refs/heads/{}", MAIN_BRANCH)
    } else if timeline.starts_with("refs/") {
        timeline.to_string()
    } else if timeline.starts_with("timeline/") {
        format!("refs/heads/{}", timeline)
    } else {
        format!("{}{}", TIMELINE_PREFIX, timeline)
    }
}

fn resolve_ref_oid(repo: &git2::Repository, ref_name: &str) -> Result<git2::Oid, VersioningError> {
    let reference = repo
        .find_reference(ref_name)
        .map_err(|e| VersioningError::Git(format!("Cannot find ref '{}': {}", ref_name, e)))?;
    reference.target().ok_or_else(|| {
        VersioningError::Git(format!("Ref '{}' is not a direct reference", ref_name))
    })
}

fn update_branch_ref(
    repo: &git2::Repository,
    ref_name: &str,
    oid: git2::Oid,
) -> Result<(), VersioningError> {
    repo.reference(ref_name, oid, true, "merge: fast-forward")
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    Ok(())
}

fn checkout_to_working_dir(
    project_dir: &Path,
    repo: &git2::Repository,
    oid: git2::Oid,
) -> Result<(), VersioningError> {
    // Use gix to write tree to working dir (consistent with existing checkout logic)
    let gix_repo = gix::open(project_dir).map_err(|e| VersioningError::Git(e.to_string()))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;
    let tree_oid_str = commit.tree_id().to_string();
    let gix_tree_id = gix::ObjectId::from_hex(tree_oid_str.as_bytes())
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    // Clean working dir and write new tree
    clean_working_dir(project_dir)?;
    write_tree_to_dir(&gix_repo, gix_tree_id, project_dir)?;

    Ok(())
}

fn clean_working_dir(project_dir: &Path) -> Result<(), VersioningError> {
    for entry in std::fs::read_dir(project_dir).map_err(|e| VersioningError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| VersioningError::Io(e.to_string()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || (name.starts_with('.') && name != ".cutready" && name != ".chats") {
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

fn read_blob_content(repo: &git2::Repository, entry: Option<&git2::IndexEntry>) -> String {
    match entry {
        Some(e) => repo
            .find_blob(e.id)
            .map(|blob| String::from_utf8_lossy(blob.content()).to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

fn classify_file_type(path: &str) -> ConflictFileType {
    if path.ends_with(".sk") {
        ConflictFileType::Sketch
    } else if path.ends_with(".sb") {
        ConflictFileType::Storyboard
    } else if path.ends_with(".md") {
        ConflictFileType::Note
    } else {
        ConflictFileType::Other
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Helper: create a project with git repo and initial commit
    fn setup_project(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        let repo = git2::Repository::init(dir).unwrap();

        // Create initial files and commit on main
        fs::create_dir_all(dir.join("sketches")).unwrap();
        fs::write(
            dir.join("sketches/intro.sk"),
            r#"{"title":"Hello","description":"initial"}"#,
        )
        .unwrap();
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(
            dir.join("notes/outline.md"),
            "# Outline\n\nLine 1\nLine 2\nLine 3\n",
        )
        .unwrap();

        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Initial commit",
            &tree,
            &[],
        )
        .unwrap();

        // Set HEAD to main
        repo.set_head("refs/heads/main").unwrap();
    }

    // Helper: commit changes on a specific branch
    fn commit_on_branch(
        dir: &Path,
        branch: &str,
        files: &[(&str, &str)],
        message: &str,
    ) -> git2::Oid {
        let repo = git2::Repository::open(dir).unwrap();

        // Resolve the branch ref
        let branch_ref = if branch == "main" {
            "refs/heads/main".to_string()
        } else {
            format!("refs/heads/timeline/{}", branch)
        };

        // Write files to disk
        for (path, content) in files {
            let full_path = dir.join(path);
            if let Some(parent) = full_path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&full_path, content).unwrap();
        }

        // Get parent commit from branch
        let parent_oid = repo.find_reference(&branch_ref).unwrap().target().unwrap();
        let parent = repo.find_commit(parent_oid).unwrap();

        // Build index from parent tree + new files
        let mut index = repo.index().unwrap();
        index.read_tree(&parent.tree().unwrap()).unwrap();
        for (path, content) in files {
            let blob_oid = repo.blob(content.as_bytes()).unwrap();
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100644,
                uid: 0,
                gid: 0,
                file_size: content.len() as u32,
                id: blob_oid,
                flags: (path.len() as u16) & 0xfff,
                flags_extended: 0,
                path: path.as_bytes().to_vec(),
            };
            index.add(&entry).unwrap();
        }
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();

        repo.commit(Some(&branch_ref), &sig, &sig, message, &tree, &[&parent])
            .unwrap()
    }

    // Helper: create a fork branch from main's current tip
    fn create_fork(dir: &Path, fork_name: &str) {
        let repo = git2::Repository::open(dir).unwrap();
        let main_oid = repo
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        let fork_ref = format!("refs/heads/timeline/{}", fork_name);
        repo.reference(&fork_ref, main_oid, false, "create fork")
            .unwrap();
    }

    #[test]
    fn merge_nothing_when_same_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        setup_project(&dir);

        let result = merge_timelines(&dir, "main", "main").unwrap();
        assert!(matches!(result, MergeResult::Nothing));
    }

    #[test]
    fn merge_fast_forward() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        setup_project(&dir);

        // Create fork from main and add a commit
        create_fork(&dir, "experiment");
        commit_on_branch(
            &dir,
            "experiment",
            &[(
                "sketches/intro.sk",
                r#"{"title":"Hello v2","description":"updated"}"#,
            )],
            "Update intro on fork",
        );

        // Merge fork into main — should fast-forward
        let result = merge_timelines(&dir, "timeline/experiment", "main").unwrap();
        match result {
            MergeResult::FastForward { commit_id } => {
                assert!(!commit_id.is_empty());
            }
            other => panic!("Expected FastForward, got {:?}", other),
        }

        // Main should now point at fork's tip
        let repo = git2::Repository::open(&dir).unwrap();
        let main_oid = repo
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        let fork_oid = repo
            .find_reference("refs/heads/timeline/experiment")
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(main_oid, fork_oid);
    }

    #[test]
    fn merge_clean_no_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        setup_project(&dir);

        // Create fork
        create_fork(&dir, "experiment");

        // Main edits one file
        commit_on_branch(
            &dir,
            "main",
            &[(
                "sketches/intro.sk",
                r#"{"title":"Main title","description":"initial"}"#,
            )],
            "Edit title on main",
        );

        // Fork edits a DIFFERENT file
        commit_on_branch(
            &dir,
            "experiment",
            &[("notes/outline.md", "# Updated Outline\n\nNew content\n")],
            "Edit outline on fork",
        );

        // Merge fork into main — should be clean (no overlapping changes)
        let result = merge_timelines(&dir, "timeline/experiment", "main").unwrap();
        match result {
            MergeResult::Clean { commit_id } => {
                assert!(!commit_id.is_empty());
                // Verify the merge commit has 2 parents
                let repo = git2::Repository::open(&dir).unwrap();
                let oid = git2::Oid::from_str(&commit_id).unwrap();
                let commit = repo.find_commit(oid).unwrap();
                assert_eq!(commit.parent_count(), 2);
            }
            other => panic!("Expected Clean, got {:?}", other),
        }
    }

    #[test]
    fn merge_conflict_detected() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        setup_project(&dir);

        create_fork(&dir, "experiment");

        // Both sides edit the SAME file differently
        commit_on_branch(
            &dir,
            "main",
            &[(
                "sketches/intro.sk",
                r#"{"title":"Main version","description":"from main"}"#,
            )],
            "Edit intro on main",
        );

        commit_on_branch(
            &dir,
            "experiment",
            &[(
                "sketches/intro.sk",
                r#"{"title":"Fork version","description":"from fork"}"#,
            )],
            "Edit intro on fork",
        );

        let result = merge_timelines(&dir, "timeline/experiment", "main").unwrap();
        match result {
            MergeResult::Conflicts { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                let c = &conflicts[0];
                assert_eq!(c.path, "sketches/intro.sk");
                assert_eq!(c.file_type, ConflictFileType::Sketch);
                assert!(!c.ours.is_empty());
                assert!(!c.theirs.is_empty());
            }
            other => panic!("Expected Conflicts, got {:?}", other),
        }
    }

    #[test]
    fn merge_conflict_with_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        setup_project(&dir);

        create_fork(&dir, "experiment");

        commit_on_branch(
            &dir,
            "main",
            &[(
                "sketches/intro.sk",
                r#"{"title":"Main version","description":"from main"}"#,
            )],
            "Edit on main",
        );

        commit_on_branch(
            &dir,
            "experiment",
            &[(
                "sketches/intro.sk",
                r#"{"title":"Fork version","description":"from fork"}"#,
            )],
            "Edit on fork",
        );

        // First confirm there's a conflict
        let result = merge_timelines(&dir, "timeline/experiment", "main").unwrap();
        assert!(matches!(result, MergeResult::Conflicts { .. }));

        // Now apply resolution
        let resolutions = vec![FileResolution {
            path: "sketches/intro.sk".to_string(),
            content: r#"{"title":"Merged version","description":"resolved"}"#.to_string(),
        }];

        let commit_id =
            apply_merge_resolution(&dir, "timeline/experiment", "main", resolutions).unwrap();
        assert!(!commit_id.is_empty());

        // Verify merge commit has 2 parents
        let repo = git2::Repository::open(&dir).unwrap();
        let oid = git2::Oid::from_str(&commit_id).unwrap();
        let commit = repo.find_commit(oid).unwrap();
        assert_eq!(commit.parent_count(), 2);

        // Verify resolved content on disk
        let content = fs::read_to_string(dir.join("sketches/intro.sk")).unwrap();
        assert!(content.contains("Merged version"));
    }

    #[test]
    fn merge_note_text_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        setup_project(&dir);

        create_fork(&dir, "experiment");

        commit_on_branch(
            &dir,
            "main",
            &[(
                "notes/outline.md",
                "# Outline\n\nMain Line 1\nLine 2\nLine 3\n",
            )],
            "Edit note on main",
        );

        commit_on_branch(
            &dir,
            "experiment",
            &[(
                "notes/outline.md",
                "# Outline\n\nFork Line 1\nLine 2\nLine 3\n",
            )],
            "Edit note on fork",
        );

        let result = merge_timelines(&dir, "timeline/experiment", "main").unwrap();
        match result {
            MergeResult::Conflicts { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                let c = &conflicts[0];
                assert_eq!(c.file_type, ConflictFileType::Note);
                assert!(!c.text_conflicts.is_empty());
            }
            other => panic!("Expected Conflicts for note, got {:?}", other),
        }
    }

    // ── JSON differ tests ──────────────────────────────────────────

    #[test]
    fn json_diff_no_conflict_when_same_change() {
        let ancestor = r#"{"title":"A","desc":"B"}"#;
        let ours = r#"{"title":"C","desc":"B"}"#;
        let theirs = r#"{"title":"C","desc":"B"}"#;

        let conflicts = json_field_diff(ancestor, ours, theirs);
        assert_eq!(conflicts.len(), 0, "Same change should not be a conflict");
    }

    #[test]
    fn json_diff_conflict_on_different_changes() {
        let ancestor = r#"{"title":"A","desc":"B"}"#;
        let ours = r#"{"title":"Main","desc":"B"}"#;
        let theirs = r#"{"title":"Fork","desc":"B"}"#;

        let conflicts = json_field_diff(ancestor, ours, theirs);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].field_path, "title");
        assert_eq!(conflicts[0].ours, serde_json::json!("Main"));
        assert_eq!(conflicts[0].theirs, serde_json::json!("Fork"));
    }

    #[test]
    fn json_diff_only_conflicting_fields() {
        let ancestor = r#"{"title":"A","desc":"B","state":"draft"}"#;
        let ours = r#"{"title":"Main","desc":"New desc","state":"draft"}"#;
        let theirs = r#"{"title":"Fork","desc":"B","state":"ready"}"#;

        let conflicts = json_field_diff(ancestor, ours, theirs);
        // Only "title" should conflict (both changed it differently)
        // "desc" only changed on ours, "state" only changed on theirs
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].field_path, "title");
    }

    #[test]
    fn json_diff_nested_fields() {
        let ancestor = r#"{"meta":{"author":"A","version":1}}"#;
        let ours = r#"{"meta":{"author":"B","version":1}}"#;
        let theirs = r#"{"meta":{"author":"C","version":1}}"#;

        let conflicts = json_field_diff(ancestor, ours, theirs);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].field_path, "meta.author");
    }

    #[test]
    fn json_diff_array_elements() {
        let ancestor = r#"{"items":["a","b","c"]}"#;
        let ours = r#"{"items":["x","b","c"]}"#;
        let theirs = r#"{"items":["y","b","c"]}"#;

        let conflicts = json_field_diff(ancestor, ours, theirs);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].field_path, "items[0]");
    }

    // ── Text differ tests ──────────────────────────────────────────

    #[test]
    fn text_diff_no_conflict_same_change() {
        let ancestor = "line1\nline2\nline3\n";
        let ours = "line1\nchanged\nline3\n";
        let theirs = "line1\nchanged\nline3\n";

        let conflicts = text_line_diff(ancestor, ours, theirs);
        assert_eq!(conflicts.len(), 0, "Same change should not be a conflict");
    }

    #[test]
    fn text_diff_conflict_on_same_line() {
        let ancestor = "line1\nline2\nline3\n";
        let ours = "line1\nours\nline3\n";
        let theirs = "line1\ntheirs\nline3\n";

        let conflicts = text_line_diff(ancestor, ours, theirs);
        assert!(!conflicts.is_empty(), "Should detect conflict on line 2");
    }

    #[test]
    fn text_diff_no_conflict_different_lines() {
        let ancestor = "line1\nline2\nline3\nline4\n";
        let ours = "line1\nours2\nline3\nline4\n";
        let theirs = "line1\nline2\nline3\ntheirs4\n";

        let conflicts = text_line_diff(ancestor, ours, theirs);
        assert_eq!(
            conflicts.len(),
            0,
            "Non-overlapping edits should not conflict"
        );
    }

    // ── Helper tests ───────────────────────────────────────────────

    #[test]
    fn classify_file_types() {
        assert_eq!(
            classify_file_type("sketches/intro.sk"),
            ConflictFileType::Sketch
        );
        assert_eq!(
            classify_file_type("storyboards/demo.sb"),
            ConflictFileType::Storyboard
        );
        assert_eq!(
            classify_file_type("notes/outline.md"),
            ConflictFileType::Note
        );
        assert_eq!(
            classify_file_type("assets/image.png"),
            ConflictFileType::Other
        );
    }

    #[test]
    fn timeline_ref_resolution() {
        assert_eq!(timeline_ref_name("main"), "refs/heads/main");
        assert_eq!(
            timeline_ref_name("fork-123"),
            "refs/heads/timeline/fork-123"
        );
        assert_eq!(
            timeline_ref_name("timeline/fork-123"),
            "refs/heads/timeline/fork-123"
        );
        assert_eq!(timeline_ref_name("refs/heads/custom"), "refs/heads/custom");
    }

    // ── resolve_conflict_file tests ─────────────────────────────

    fn make_text_conflict(ancestor: &str, ours: &str, theirs: &str) -> ConflictFile {
        let text_conflicts = text_line_diff(ancestor, ours, theirs);
        ConflictFile {
            path: "test.md".to_string(),
            file_type: ConflictFileType::Note,
            ours: ours.to_string(),
            theirs: theirs.to_string(),
            ancestor: ancestor.to_string(),
            field_conflicts: Vec::new(),
            text_conflicts,
        }
    }

    fn make_json_conflict(
        ancestor: &str,
        ours: &str,
        theirs: &str,
    ) -> ConflictFile {
        let field_conflicts = json_field_diff(ancestor, ours, theirs);
        ConflictFile {
            path: "test.sk".to_string(),
            file_type: ConflictFileType::Sketch,
            ours: ours.to_string(),
            theirs: theirs.to_string(),
            ancestor: ancestor.to_string(),
            field_conflicts,
            text_conflicts: Vec::new(),
        }
    }

    #[test]
    fn text_resolve_all_ours() {
        let conflict = make_text_conflict("line1\nold\nline3", "line1\nours\nline3", "line1\ntheirs\nline3");
        let choices = ConflictChoices {
            text_choices: [(0, ConflictSide::Ours)].into(),
            field_choices: Default::default(),
        };
        let result = resolve_conflict_file(&conflict, &choices).unwrap();
        assert!(result.contains("ours"));
        assert!(!result.contains("theirs"));
    }

    #[test]
    fn text_resolve_all_theirs() {
        let conflict = make_text_conflict("line1\nold\nline3", "line1\nours\nline3", "line1\ntheirs\nline3");
        let choices = ConflictChoices {
            text_choices: [(0, ConflictSide::Theirs)].into(),
            field_choices: Default::default(),
        };
        let result = resolve_conflict_file(&conflict, &choices).unwrap();
        assert!(result.contains("theirs"));
        assert!(!result.contains("ours"));
    }

    #[test]
    fn text_resolve_preserves_non_conflicting_edits() {
        // ancestor has 5 lines. ours changes line 2 (conflict) and line 5 (non-conflict).
        // theirs changes line 2 (conflict) and line 4 (non-conflict).
        let ancestor = "header\nold-conflict\nshared\nold-line4\nold-line5";
        let ours = "header\nours-conflict\nshared\nold-line4\nours-line5";
        let theirs = "header\ntheirs-conflict\nshared\ntheirs-line4\nold-line5";

        let conflict = make_text_conflict(ancestor, ours, theirs);
        assert_eq!(conflict.text_conflicts.len(), 1, "should have exactly 1 conflict region");

        // Pick theirs for the conflict
        let choices = ConflictChoices {
            text_choices: [(0, ConflictSide::Theirs)].into(),
            field_choices: Default::default(),
        };
        let result = resolve_conflict_file(&conflict, &choices).unwrap();

        // Should have theirs' conflict choice
        assert!(result.contains("theirs-conflict"), "should pick theirs for conflict");
        // Should preserve theirs' non-conflicting edit
        assert!(result.contains("theirs-line4"), "should preserve theirs non-conflicting edit");
        // Should preserve ours' non-conflicting edit
        assert!(result.contains("ours-line5"), "should preserve ours non-conflicting edit");
    }

    #[test]
    fn json_resolve_preserves_theirs_non_conflicting() {
        let ancestor = r#"{"title":"old","description":"desc","version":1}"#;
        let ours = r#"{"title":"ours-title","description":"desc","version":1}"#;
        let theirs = r#"{"title":"theirs-title","description":"desc","version":2}"#;

        let conflict = make_json_conflict(ancestor, ours, theirs);
        // title should be a conflict, version should be theirs-only non-conflicting
        assert!(conflict.field_conflicts.iter().any(|fc| fc.field_path == "title"));

        let choices = ConflictChoices {
            text_choices: Default::default(),
            field_choices: [("title".to_string(), ConflictSide::Ours)].into(),
        };
        let result = resolve_conflict_file(&conflict, &choices).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["title"], "ours-title", "should pick ours for conflict");
        assert_eq!(parsed["version"], 2, "should preserve theirs non-conflicting edit");
    }

    #[test]
    fn json_resolve_mixed_choices() {
        let ancestor = r#"{"title":"old","description":"old-desc"}"#;
        let ours = r#"{"title":"ours-title","description":"ours-desc"}"#;
        let theirs = r#"{"title":"theirs-title","description":"theirs-desc"}"#;

        let conflict = make_json_conflict(ancestor, ours, theirs);
        assert_eq!(conflict.field_conflicts.len(), 2);

        let choices = ConflictChoices {
            text_choices: Default::default(),
            field_choices: [
                ("title".to_string(), ConflictSide::Theirs),
                ("description".to_string(), ConflictSide::Ours),
            ].into(),
        };
        let result = resolve_conflict_file(&conflict, &choices).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["title"], "theirs-title");
        assert_eq!(parsed["description"], "ours-desc");
    }
}
