//! Credential vault location for the frontend Stronghold client.

use tauri::{AppHandle, Manager};
use tauri_plugin_auditaur::auditaur_command;

use cutready_desktop_io::secret_vault;

/// Returns the Stronghold vault path, moving a vault left by older builds into place.
#[auditaur_command(skip_all, err)]
pub async fn secret_vault_path(app: AppHandle) -> Result<String, String> {
    let path = if let Some(dir) = secret_vault::drill_vault_dir() {
        log::info!("[secrets] using the drill credential vault folder");
        secret_vault::drill_vault_path(&dir).map_err(|error| error.to_string())?
    } else {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        secret_vault::resolve_and_migrate(&dir).map_err(|error| error.to_string())?
    };
    path.into_os_string()
        .into_string()
        .map_err(|_| "credential vault path is not valid Unicode".to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use cutready_core::Secrets;
    use cutready_desktop_io::{secret_vault, StrongholdSecrets};
    use tauri_plugin_stronghold::{kdf::KeyDerivation, stronghold::Stronghold};

    // Must match VAULT_PASS and CLIENT_NAME in src/hooks/useSecretStore.ts.
    const VAULT_PASS: &str = "com.cutready.app";
    const CLIENT_NAME: &[u8] = b"cutready";
    const KEY: &[u8] = b"fixture.apiKey";
    const VALUE: &[u8] = b"fixture-secret";

    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault")
    }

    fn read_secret(vault: &Path, salt: &Path) -> Option<Vec<u8>> {
        let stronghold = Stronghold::new(vault, KeyDerivation::argon2(VAULT_PASS, salt)).unwrap();
        let client = stronghold.load_client(CLIENT_NAME).unwrap();
        client.store().get(KEY).unwrap()
    }

    /// Opens a vault written by an earlier build through today's path and salt
    /// resolution, for both the current and the legacy (pre-separator) layout.
    #[test]
    fn existing_vaults_still_open() {
        for legacy in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let app_data = root.path().join("roaming").join("com.cutready.app");
            let local_data = root.path().join("local").join("com.cutready.app");
            std::fs::create_dir_all(&app_data).unwrap();
            std::fs::create_dir_all(&local_data).unwrap();
            let placed = if legacy {
                secret_vault::legacy_vault_path(&app_data)
            } else {
                secret_vault::vault_path(&app_data)
            };
            std::fs::copy(fixture_dir().join("vault.hold"), &placed).unwrap();
            let salt = secret_vault::salt_path(&local_data);
            std::fs::copy(fixture_dir().join("salt.txt"), &salt).unwrap();

            let vault = secret_vault::resolve_and_migrate(&app_data).unwrap();
            assert_eq!(vault, app_data.join("vault.hold"));
            assert_eq!(read_secret(&vault, &salt).as_deref(), Some(VALUE));

            // The desktop-io Secrets port reads the plugin's vault, and the plugin
            // reads what the port writes back.
            let port = StrongholdSecrets::open(&vault, &salt).unwrap();
            let value = std::str::from_utf8(VALUE).unwrap();
            let key = std::str::from_utf8(KEY).unwrap();
            assert_eq!(port.get(key).unwrap().as_deref(), Some(value));
            port.set(key, "rotated").unwrap();
            drop(port);
            assert_eq!(read_secret(&vault, &salt).as_deref(), Some(&b"rotated"[..]));
        }
    }

    /// Regenerates the fixture. Run once with `--ignored` and commit the output.
    #[test]
    #[ignore]
    fn write_vault_fixture() {
        let dir = fixture_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("salt.txt"));
        let _ = std::fs::remove_file(dir.join("vault.hold"));
        let key = KeyDerivation::argon2(VAULT_PASS, &dir.join("salt.txt"));
        let stronghold = Stronghold::new(dir.join("vault.hold"), key).unwrap();
        let client = stronghold.create_client(CLIENT_NAME).unwrap();
        client.store().insert(KEY.to_vec(), VALUE.to_vec(), None).unwrap();
        stronghold.save().unwrap();
    }
}
