//! Location of the Stronghold credential vault.
//!
//! Builds before this fix put the vault beside the app data folder
//! (`<app data dir>vault.hold`, e.g. `%APPDATA%\com.cutready.appvault.hold`)
//! because the frontend joined the path without a separator. The vault now
//! lives at `<app data dir>/vault.hold`; the legacy file is moved on first use.
//!
//! If both files exist, a downgraded build wrote the legacy one. Encrypted
//! snapshots can't be merged, so the newer file wins and the other is kept as
//! `vault.hold.bak`.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

const VAULT_FILE: &str = "vault.hold";
const BACKUP_FILE: &str = "vault.hold.bak";
/// Log target from before the move into this crate, so filters keep matching.
const LOG_TARGET: &str = "cutready_lib::engine::secret_vault";
const SALT_FILE: &str = "salt.txt";

pub fn vault_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(VAULT_FILE)
}

/// The Argon2 salt Stronghold derives the vault key from. It lives in the app
/// *local* data dir, not beside the vault.
pub fn salt_path(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join(SALT_FILE)
}

/// Returns `<dir>/salt.txt` in the drill folder, creating it.
pub fn drill_salt_path(dir: &Path) -> io::Result<PathBuf> {
    Ok(drill_vault_path(dir)?.with_file_name(SALT_FILE))
}

pub fn legacy_vault_path(app_data_dir: &Path) -> PathBuf {
    let mut legacy = OsString::from(app_data_dir.as_os_str());
    legacy.push(VAULT_FILE);
    PathBuf::from(legacy)
}

/// Returns the vault path to load, moving a legacy vault into place first.
pub fn resolve_and_migrate(app_data_dir: &Path) -> io::Result<PathBuf> {
    resolve_and_migrate_with(app_data_dir, |from, to| std::fs::rename(from, to))
}

/// Env var a drill fixture sets so debug builds use a throwaway vault folder.
pub const DRILL_VAULT_DIR_ENV: &str = "CUTREADY_DRILL_VAULT_DIR";

/// The throwaway vault folder drills ask for. Release builds never honor it, so a
/// stray env var can't point a shipped app away from the user's vault.
pub fn drill_vault_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        drill_vault_dir_from(std::env::var_os(DRILL_VAULT_DIR_ENV))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn drill_vault_dir_from(value: Option<OsString>) -> Option<PathBuf> {
    let dir = PathBuf::from(value?);
    (dir.is_absolute()).then_some(dir)
}

/// Returns `<dir>/vault.hold` in the drill folder, creating it; no migration.
pub fn drill_vault_path(dir: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    Ok(dir.join(VAULT_FILE))
}

fn resolve_and_migrate_with(
    app_data_dir: &Path,
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    let new = vault_path(app_data_dir);
    let legacy = legacy_vault_path(app_data_dir);

    if new.exists() {
        if legacy.exists() && is_newer(&legacy, &new) {
            log::warn!(target: LOG_TARGET, "[secrets] a newer legacy credential vault exists; using it and keeping the current one as a backup");
            if let Err(err) = rename(&new, &app_data_dir.join(BACKUP_FILE)) {
                log::warn!(target: LOG_TARGET, "[secrets] could not back up the current vault, keeping it: {err}");
                return Ok(new);
            }
        } else {
            if legacy.exists() {
                log::warn!(target: LOG_TARGET, "[secrets] ignoring an older legacy credential vault");
            }
            return Ok(new);
        }
    }

    std::fs::create_dir_all(app_data_dir)?;
    if !legacy.exists() {
        return Ok(new);
    }

    match rename(&legacy, &new) {
        Ok(()) => {
            log::info!(target: LOG_TARGET, "[secrets] moved the credential vault into the app data folder");
            Ok(new)
        }
        // Another caller may have finished the move, so re-check before falling back.
        Err(err) if new.exists() => {
            log::debug!(target: LOG_TARGET, "[secrets] vault already moved: {err}");
            Ok(new)
        }
        Err(err) if legacy.exists() => {
            log::warn!(target: LOG_TARGET, "[secrets] could not move the credential vault, using it in place: {err}");
            Ok(legacy)
        }
        Err(err) => Err(err),
    }
}

fn is_newer(a: &Path, b: &Path) -> bool {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    matches!((modified(a), modified(b)), (Some(a), Some(b)) if a > b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn app_dir(root: &tempfile::TempDir) -> PathBuf {
        root.path().join("com.cutready.app")
    }

    #[test]
    fn drill_vault_dir_needs_an_absolute_path() {
        assert_eq!(drill_vault_dir_from(None), None);
        assert_eq!(drill_vault_dir_from(Some(OsString::new())), None);
        assert_eq!(drill_vault_dir_from(Some("relative/vault".into())), None);
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            drill_vault_dir_from(Some(root.path().as_os_str().to_owned())),
            Some(root.path().to_path_buf())
        );
    }

    #[test]
    fn drill_vault_path_creates_the_folder_and_skips_migration() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("drill-vault");
        let path = drill_vault_path(&dir).unwrap();
        assert_eq!(path, dir.join("vault.hold"));
        assert!(dir.is_dir());
        assert!(!path.exists());
    }

    // Run with `cargo test --release`: shipped builds must ignore the drill override.
    #[cfg(not(debug_assertions))]
    #[test]
    fn release_builds_ignore_the_drill_vault_dir() {
        let root = tempfile::tempdir().unwrap();
        std::env::set_var(DRILL_VAULT_DIR_ENV, root.path());
        assert_eq!(drill_vault_dir(), None);
        std::env::remove_var(DRILL_VAULT_DIR_ENV);
    }

    #[test]
    fn salt_paths_match_the_plugin_setup() {
        let dir = Path::new("C:/Users/me/AppData/Local/com.cutready.app");
        assert_eq!(salt_path(dir), dir.join("salt.txt"));
        let root = tempfile::tempdir().unwrap();
        let drill = root.path().join("drill-vault");
        assert_eq!(drill_salt_path(&drill).unwrap(), drill.join("salt.txt"));
        assert!(drill.is_dir());
    }

    #[test]
    fn legacy_path_matches_the_old_frontend_join() {
        let dir = Path::new("C:/Users/me/AppData/Roaming/com.cutready.app");
        assert_eq!(
            legacy_vault_path(dir),
            PathBuf::from("C:/Users/me/AppData/Roaming/com.cutready.appvault.hold")
        );
    }

    #[test]
    fn fresh_install_creates_the_app_data_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        let path = resolve_and_migrate(&dir).unwrap();
        assert_eq!(path, dir.join("vault.hold"));
        assert!(dir.is_dir());
        assert!(!path.exists());
    }

    #[test]
    fn moves_a_legacy_vault_into_the_app_data_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        fs::write(legacy_vault_path(&dir), b"legacy").unwrap();
        let path = resolve_and_migrate(&dir).unwrap();
        assert_eq!(path, dir.join("vault.hold"));
        assert_eq!(fs::read(&path).unwrap(), b"legacy");
        assert!(!legacy_vault_path(&dir).exists());
    }

    #[test]
    fn keeps_an_existing_vault() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(vault_path(&dir), b"current").unwrap();
        assert_eq!(resolve_and_migrate(&dir).unwrap(), vault_path(&dir));
    }

    fn set_age(path: &Path, secs_ago: u64) {
        let time = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    #[test]
    fn current_vault_wins_over_an_older_legacy_one() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(vault_path(&dir), b"current").unwrap();
        fs::write(legacy_vault_path(&dir), b"legacy").unwrap();
        set_age(&legacy_vault_path(&dir), 60);
        let path = resolve_and_migrate(&dir).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"current");
        assert!(
            legacy_vault_path(&dir).exists(),
            "legacy file is left alone"
        );
    }

    #[test]
    fn newer_legacy_vault_from_a_downgrade_replaces_the_current_one() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(vault_path(&dir), b"current").unwrap();
        set_age(&vault_path(&dir), 60);
        fs::write(legacy_vault_path(&dir), b"legacy").unwrap();
        let path = resolve_and_migrate(&dir).unwrap();
        assert_eq!(path, vault_path(&dir));
        assert_eq!(fs::read(&path).unwrap(), b"legacy");
        assert_eq!(fs::read(dir.join("vault.hold.bak")).unwrap(), b"current");
        assert!(!legacy_vault_path(&dir).exists());
    }

    #[test]
    fn uses_the_legacy_vault_in_place_when_the_move_fails() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        fs::write(legacy_vault_path(&dir), b"legacy").unwrap();
        let path = resolve_and_migrate_with(&dir, |_, _| Err(io::Error::other("locked"))).unwrap();
        assert_eq!(path, legacy_vault_path(&dir));
    }

    #[test]
    fn uses_the_new_vault_when_another_caller_moved_it_first() {
        let root = tempfile::tempdir().unwrap();
        let dir = app_dir(&root);
        fs::write(legacy_vault_path(&dir), b"legacy").unwrap();
        let path = resolve_and_migrate_with(&dir, |from, to| {
            fs::rename(from, to)?;
            Err(io::Error::new(io::ErrorKind::NotFound, "source vanished"))
        })
        .unwrap();
        assert_eq!(path, vault_path(&dir));
    }
}
