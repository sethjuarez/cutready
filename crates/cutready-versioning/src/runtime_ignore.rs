//! Keeps CutReady's local runtime files (note locks, workspace settings,
//! recordings, legacy chat/agent state) out of plain `git status`.
//!
//! Draftline already leaves them out of versions, but in a hybrid project a
//! developer running git in the enclosing repository would still see them as
//! untracked. The rules go in the repository's `info/exclude`, which is local
//! to the clone, so nothing new is committed and existing files are covered
//! without moving them.

use std::path::{Component, Path};

/// Paths, relative to a CutReady project folder, that only ever hold local
/// runtime state and are left out of Draftline versions.
pub(crate) const EXCLUDED_RUNTIME_PATHS: &[&str] = &[
    ".chats",
    ".cutready/recordings",
    ".cutready/agent-state.db",
    ".cutready/memory.json",
    ".cutready/locks.json",
];

/// Everything git should ignore: the excluded paths plus the per-project
/// settings file, which the content policy simply never includes.
pub(crate) const LOCAL_RUNTIME_PATHS: &[&str] = &[
    ".chats",
    ".cutready/recordings",
    ".cutready/agent-state.db",
    ".cutready/memory.json",
    ".cutready/locks.json",
    ".cutready/settings.json",
];

const BLOCK_START: &str = "# >>> CutReady local runtime files";
const BLOCK_END: &str = "# <<< CutReady local runtime files";

/// Make sure the repository holding `root` ignores CutReady's runtime files
/// for that folder (and any project folders under it). Returns whether the
/// exclude file changed. Folders outside a git repository are left alone.
pub fn exclude_runtime_paths(root: &Path) -> std::io::Result<bool> {
    let Ok(repo) = git2::Repository::discover(root) else {
        return Ok(false);
    };
    let Some(work_dir) = repo.workdir() else {
        return Ok(false);
    };
    let work_dir = std::fs::canonicalize(work_dir)?;
    let folder = std::fs::canonicalize(root)?;
    let Ok(rel) = folder.strip_prefix(&work_dir) else {
        return Ok(false);
    };
    let rel = rel_pattern(rel);
    let info = repo.commondir().join("info");
    let exclude = info.join("exclude");
    let current = read_exclude(&exclude)?;
    if current == with_block(&current, &rel) {
        return Ok(false);
    }
    std::fs::create_dir_all(&info)?;
    // Git's own lockfile protocol: whoever creates `exclude.lock` owns the
    // update, reads under it, and renames it over the file. A busy lock means
    // another CutReady (or git) is writing; the next open tries again.
    let lock_path = info.join("exclude.lock");
    let mut lock = open_lock(&lock_path)?;
    let result = (|| {
        use std::io::Write;
        let current = read_exclude(&exclude)?;
        let updated = with_block(&current, &rel);
        if updated == current {
            return Ok(false);
        }
        lock.write_all(updated.as_bytes())?;
        lock.sync_all()?;
        Ok(true)
    })();
    drop(lock);
    match result {
        Ok(true) => std::fs::rename(&lock_path, &exclude)
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&lock_path);
            })
            .map(|_| true),
        other => {
            let _ = std::fs::remove_file(&lock_path);
            other
        }
    }
}

/// Create the lockfile, waiting briefly while another writer holds it.
fn open_lock(path: &Path) -> std::io::Result<std::fs::File> {
    let mut attempts = 0;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists && attempts < 40 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            result => return result,
        }
    }
}

fn read_exclude(path: &Path) -> std::io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(err),
    }
}

/// The folder's path as an anchored, escaped gitignore prefix ("" at the root).
fn rel_pattern(rel: &Path) -> String {
    let parts: Vec<String> = rel
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => Some(escape(&name.to_string_lossy())),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn escape(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for (index, ch) in segment.chars().enumerate() {
        let leading = index == 0 && matches!(ch, '#' | '!');
        if leading || matches!(ch, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `current` with this folder's block present exactly once and up to date.
fn with_block(current: &str, rel: &str) -> String {
    let start = format!("{BLOCK_START} ({}) >>>", display_folder(rel));
    let end = format!("{BLOCK_END} ({}) <<<", display_folder(rel));
    let mut block = vec![start.clone()];
    for path in LOCAL_RUNTIME_PATHS {
        let dir = if path.ends_with(".db") || path.ends_with(".json") {
            ""
        } else {
            "/"
        };
        if rel.is_empty() {
            block.push(format!("**/{path}{dir}"));
        } else {
            block.push(format!("{rel}/**/{path}{dir}"));
        }
    }
    block.push(end.clone());

    let all: Vec<&str> = current.lines().collect();
    let mut lines: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < all.len() {
        // Only drop a block whose end marker is present; a damaged block keeps
        // the developer's rules after it, and a fresh block is appended.
        if all[index] == start {
            let close = all[index + 1..]
                .iter()
                .take_while(|line| **line != start)
                .position(|line| *line == end);
            if let Some(offset) = close {
                index += offset + 2;
                continue;
            }
        }
        lines.push(all[index]);
        index += 1;
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&block.join("\n"));
    out.push('\n');
    out
}

fn display_folder(rel: &str) -> &str {
    if rel.is_empty() {
        "/"
    } else {
        rel
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        command.args(args).current_dir(dir);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "git {args:?} failed: {output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn opening_a_hybrid_folder_hides_its_runtime_files() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-q", "-b", "main"]);
        git(repo, &["config", "user.name", "Dev"]);
        git(repo, &["config", "user.email", "dev@example.com"]);
        write(&repo.join("README.md"), "# Contoso\n");
        git(repo, &["add", "README.md"]);
        git(repo, &["commit", "-q", "-m", "Initial code"]);
        write(&repo.join("cutready/intro.sk"), "{}");
        write(&repo.join("cutready/.cutready/locks.json"), "{}");

        crate::CutReadyDraftlineAdapter::open_project(repo.join("cutready")).unwrap();

        let status = git(repo, &["status", "--porcelain", "--untracked-files=all"]);
        assert!(status.contains("cutready/intro.sk"), "{status}");
        assert!(!status.contains("locks.json"), "{status}");
    }

    #[test]
    fn hybrid_runtime_files_disappear_from_git_status() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git2::Repository::init(repo).unwrap();
        let folder = repo.join("cutready");
        write(&folder.join("intro.sk"), "{}");
        write(&folder.join(".cutready/projects.json"), "{}");
        write(&folder.join("alaska/.cutready/locks.json"), "{}");
        write(&folder.join(".cutready/locks.json"), "{}");
        write(&folder.join(".cutready/settings.json"), "{}");
        write(&folder.join(".cutready/recordings/take/meta.json"), "{}");
        write(&folder.join(".chats/old.json"), "{}");
        // The same names in the developer's code stay visible.
        write(&repo.join("src/.cutready/locks.json"), "{}");

        assert!(exclude_runtime_paths(&folder).unwrap());
        assert!(
            !exclude_runtime_paths(&folder).unwrap(),
            "second run is a no-op"
        );

        let status = git(repo, &["status", "--porcelain", "--untracked-files=all"]);
        assert!(status.contains("cutready/intro.sk"), "{status}");
        assert!(
            status.contains("cutready/.cutready/projects.json"),
            "{status}"
        );
        assert!(status.contains("src/.cutready/locks.json"), "{status}");
        for hidden in ["locks.json\n", "settings.json", "recordings", ".chats"] {
            assert!(
                !status
                    .lines()
                    .any(|line| line.starts_with("?? cutready/") && line.contains(hidden.trim())),
                "{hidden} still untracked: {status}"
            );
        }
    }

    #[test]
    fn standalone_root_ignores_runtime_files_everywhere_in_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git2::Repository::init(root).unwrap();
        write(&root.join("demo/.cutready/locks.json"), "{}");
        write(&root.join(".cutready/locks.json"), "{}");
        write(&root.join("intro.sk"), "{}");

        assert!(exclude_runtime_paths(root).unwrap());

        let status = git(root, &["status", "--porcelain", "--untracked-files=all"]);
        assert!(status.contains("intro.sk"), "{status}");
        assert!(!status.contains("locks.json"), "{status}");
    }

    #[test]
    fn block_is_replaced_in_place_and_other_rules_survive() {
        let first = with_block("*.log\n", "/cutready");
        let again = with_block(&first, "/cutready");
        assert_eq!(first, again);
        assert!(first.starts_with("*.log\n"));
        let other = with_block(&first, "/docs/demo");
        assert_eq!(other.matches(BLOCK_START).count(), 2);
    }

    #[test]
    fn special_characters_in_folder_names_are_escaped() {
        assert_eq!(rel_pattern(Path::new("#demo/a*b")), "/\\#demo/a\\*b");
        assert_eq!(rel_pattern(Path::new("")), "");
    }

    #[test]
    fn a_damaged_block_keeps_the_rules_after_it() {
        let start = format!("{BLOCK_START} (/cutready) >>>");
        let damaged = format!("{start}\n**/x\n*.log\n");
        let fixed = with_block(&damaged, "/cutready");
        assert!(fixed.contains("*.log\n"), "{fixed}");
        assert_eq!(with_block(&fixed, "/cutready"), fixed);
    }

    #[test]
    fn concurrent_opens_of_two_folders_keep_both_blocks() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git2::Repository::init(repo).unwrap();
        let folders: Vec<_> = (0..4).map(|n| repo.join(format!("demo{n}"))).collect();
        for folder in &folders {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::thread::scope(|scope| {
            for folder in &folders {
                scope.spawn(move || exclude_runtime_paths(folder).unwrap());
            }
        });
        let text = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        for n in 0..4 {
            assert!(text.contains(&format!("(/demo{n}) >>>")), "{text}");
        }
        assert!(!repo.join(".git/info/exclude.lock").exists());
    }

    #[test]
    fn every_path_draftline_skips_is_also_ignored_by_git() {
        for path in EXCLUDED_RUNTIME_PATHS {
            assert!(
                LOCAL_RUNTIME_PATHS.contains(path),
                "{path} is not in info/exclude"
            );
        }
    }

    #[test]
    fn folders_outside_a_repository_are_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!exclude_runtime_paths(temp.path()).unwrap());
    }
}
