//! Registers the `cutready-cli` sidecar bundled with the app, so the Copilot
//! canvas and other agent hosts can find it (`cutready-cli register`, see
//! `crates/cutready-cli/src/discovery.rs`).
//!
//! Tauri installs the sidecar next to the app binary as `cutready-cli(.exe)`.
//! On Windows and in an AppImage the app registers a per-version copy in
//! `<local data>/cutready-cli/<version>/` instead: Windows locks a running
//! executable, so a canvas using the installed sidecar would block app
//! updates, and an AppImage runs from a transient mount. Registration is
//! idempotent: the CLI keeps a newer registered install and replaces an older
//! or equal one.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The sidecar's file name on this platform.
pub fn sidecar_file_name() -> String {
    format!("cutready-cli{}", std::env::consts::EXE_SUFFIX)
}

/// The bundled sidecar beside `app_exe`, if there is one.
pub fn bundled_cli(app_exe: &Path) -> Option<PathBuf> {
    let path = app_exe.parent()?.join(sidecar_file_name());
    path.is_file().then_some(path)
}

/// The folder holding per-version copies of the sidecar.
pub const COPIES_DIR: &str = "cutready-cli";

/// Copies `cli` to `<data_dir>/cutready-cli/<version>/` unless an identical
/// copy is already there, removes copies of other versions that aren't in
/// use, and returns the copy's path.
pub fn stable_copy(cli: &Path, data_dir: &Path, version: &str) -> std::io::Result<PathBuf> {
    let root = data_dir.join(COPIES_DIR);
    let dest = copy_version(cli, &root.join(version))?;
    prune_other_versions(&root, version);
    Ok(dest)
}

fn copy_version(cli: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    let dest = dir.join(sidecar_file_name());
    if std::fs::read(&dest).ok() == Some(std::fs::read(cli)?) {
        return Ok(dest);
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        "{}.{}.tmp",
        sidecar_file_name(),
        std::process::id()
    ));
    std::fs::copy(cli, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    if let Err(err) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(dest)
}

/// Best effort: a copy still running (Windows locks it) stays until a later
/// start.
fn prune_other_versions(root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name() != keep && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Runs `<cli> register` and returns its JSON output.
pub fn run_register(cli: &Path) -> Result<String, String> {
    let mut command = Command::new(cli);
    command.arg("register");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|err| format!("could not start {}: {err}", cli.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "{} register failed ({}): {stdout} {}",
            cli.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// Whether `path` only exists while this run lasts: a macOS app run from its
/// disk image or translocated by Gatekeeper.
pub fn is_transient(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with("/Volumes/") || text.contains("/AppTranslocation/")
}

/// Registers the bundled sidecar, if the app has one. Returns the CLI's
/// output, or `None` when no sidecar is bundled (development builds) or the
/// app runs from a transient location.
pub fn register_bundled() -> Result<Option<String>, String> {
    let app_exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let Some(mut cli) = bundled_cli(&app_exe) else {
        return Ok(None);
    };
    if cfg!(target_os = "macos") && is_transient(&cli) {
        return Ok(None);
    }
    if cfg!(target_os = "windows") || std::env::var_os("APPIMAGE").is_some() {
        let data_dir = dirs::data_local_dir().ok_or("no local data directory")?;
        cli = stable_copy(&cli, &data_dir, env!("CARGO_PKG_VERSION"))
            .map_err(|err| format!("could not copy the bundled cutready-cli: {err}"))?;
    }
    run_register(&cli).map(Some)
}

/// Registers the bundled sidecar on a background thread, logging the outcome.
/// Release builds only, so a dev build never replaces a user's registered
/// install.
pub fn register_bundled_in_background() {
    if cfg!(debug_assertions) {
        return;
    }
    let spawned =
        crate::util::spawn::spawn_thread_named("cli-register", || match register_bundled() {
            Ok(Some(output)) => tracing::info!(%output, "registered bundled cutready-cli"),
            Ok(None) => tracing::debug!("no bundled cutready-cli to register"),
            Err(error) => tracing::warn!(%error, "could not register bundled cutready-cli"),
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not start cutready-cli registration");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_is_found_beside_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("cutready");
        assert_eq!(bundled_cli(&app), None);
        let cli = dir.path().join(sidecar_file_name());
        std::fs::write(&cli, b"cli").unwrap();
        assert_eq!(bundled_cli(&app), Some(cli));
    }

    #[test]
    fn a_stable_copy_is_versioned_and_refreshed_only_when_it_differs() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let cli = src.path().join(sidecar_file_name());
        std::fs::write(&cli, b"one").unwrap();

        let copy = stable_copy(&cli, data.path(), "1.2.3").unwrap();
        assert_eq!(
            copy,
            data.path()
                .join(COPIES_DIR)
                .join("1.2.3")
                .join(sidecar_file_name())
        );
        assert_eq!(std::fs::read(&copy).unwrap(), b"one");
        let modified = std::fs::metadata(&copy).unwrap().modified().unwrap();

        assert_eq!(stable_copy(&cli, data.path(), "1.2.3").unwrap(), copy);
        assert_eq!(
            std::fs::metadata(&copy).unwrap().modified().unwrap(),
            modified
        );

        std::fs::write(&cli, b"two").unwrap();
        stable_copy(&cli, data.path(), "1.2.3").unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&copy).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
    }

    #[test]
    fn copies_of_other_versions_are_removed() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let cli = src.path().join(sidecar_file_name());
        std::fs::write(&cli, b"cli").unwrap();
        let old = stable_copy(&cli, data.path(), "1.0.0").unwrap();
        let new = stable_copy(&cli, data.path(), "1.1.0").unwrap();
        assert!(new.is_file());
        assert!(!old.exists());
        assert!(!data.path().join(COPIES_DIR).join("1.0.0").exists());
    }

    #[test]
    fn disk_images_and_translocated_apps_are_transient() {
        assert!(is_transient(Path::new(
            "/Volumes/CutReady/CutReady.app/Contents/MacOS/cutready-cli"
        )));
        assert!(is_transient(Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/CutReady.app/Contents/MacOS/cutready-cli"
        )));
        assert!(!is_transient(Path::new(
            "/Applications/CutReady.app/Contents/MacOS/cutready-cli"
        )));
    }

    #[test]
    fn a_failing_cli_reports_why() {
        let dir = tempfile::tempdir().unwrap();
        let err = run_register(&dir.path().join("missing-cli")).unwrap_err();
        assert!(err.contains("could not start"), "{err}");
    }
}
