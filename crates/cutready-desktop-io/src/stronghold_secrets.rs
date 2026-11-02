//! Stronghold-backed `Secrets` port. Opens the same vault the app's Stronghold
//! plugin uses (`useSecretStore.ts`): same snapshot file, Argon2 key derived
//! from the same password and 32-byte salt file, same client, UTF-8 values.
//!
//! The vault is one encrypted snapshot, so every mutation rewrites the whole
//! file. Don't let two processes write it at once; today only the app does.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cutready_core::{PortError, PortErrorKind, Secrets};
use iota_stronghold::{Client, KeyProvider, SnapshotPath, Stronghold};
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use zeroize::Zeroizing;

/// Password and client name shared with `src/hooks/useSecretStore.ts`.
pub const VAULT_PASS: &str = "com.cutready.app";
pub const CLIENT_NAME: &[u8] = b"cutready";
const SALT_LEN: usize = 32;

pub struct StrongholdSecrets {
    inner: Mutex<Vault>,
}

struct Vault {
    stronghold: Stronghold,
    client: Client,
    path: SnapshotPath,
    key: KeyProvider,
}

fn vault_error(context: &str, err: impl std::fmt::Display) -> PortError {
    PortError::new(PortErrorKind::Io, format!("{context}: {err}"))
}

/// Derives the vault key exactly like `tauri_plugin_stronghold::kdf::KeyDerivation::argon2`,
/// creating the salt file on first use.
pub fn derive_key(password: &str, salt_path: &Path) -> Result<Zeroizing<Vec<u8>>, PortError> {
    let mut salt = [0u8; SALT_LEN];
    if salt_path.is_file() {
        let bytes = std::fs::read(salt_path).map_err(|e| crate::io_error("read vault salt", e))?;
        if bytes.len() != SALT_LEN {
            return Err(vault_error(
                "read vault salt",
                format!("expected {SALT_LEN} bytes, found {}", bytes.len()),
            ));
        }
        salt.copy_from_slice(&bytes);
    } else {
        ChaCha20Rng::from_os_rng().fill_bytes(&mut salt);
        std::fs::write(salt_path, salt).map_err(|e| crate::io_error("write vault salt", e))?;
    }
    argon2::hash_raw(password.as_bytes(), &salt, &argon2::Config::default())
        .map(Zeroizing::new)
        .map_err(|e| vault_error("derive vault key", e))
}

impl StrongholdSecrets {
    /// Opens (or prepares to create) the vault at `vault_path` with the key
    /// derived from `salt_path`. Resolve both with [`crate::secret_vault`].
    pub fn open(vault_path: &Path, salt_path: &Path) -> Result<Self, PortError> {
        let key = KeyProvider::try_from(derive_key(VAULT_PASS, salt_path)?)
            .map_err(|e| vault_error("load vault key", e))?;
        let path = SnapshotPath::from_path(vault_path);
        let stronghold = Stronghold::default();
        let client = if path.exists() {
            stronghold
                .load_snapshot(&key, &path)
                .map_err(|e| vault_error("open vault", e))?;
            match stronghold.load_client(CLIENT_NAME) {
                Ok(client) => client,
                Err(_) => stronghold
                    .create_client(CLIENT_NAME)
                    .map_err(|e| vault_error("create vault client", e))?,
            }
        } else {
            stronghold
                .create_client(CLIENT_NAME)
                .map_err(|e| vault_error("create vault client", e))?
        };
        Ok(Self {
            inner: Mutex::new(Vault {
                stronghold,
                client,
                path,
                key,
            }),
        })
    }

    fn with_vault<T>(
        &self,
        f: impl FnOnce(&Vault) -> Result<T, PortError>,
    ) -> Result<T, PortError> {
        let vault = self
            .inner
            .lock()
            .map_err(|_| vault_error("lock vault", "poisoned"))?;
        f(&vault)
    }
}

impl Vault {
    fn save(&self) -> Result<(), PortError> {
        self.stronghold
            .commit_with_keyprovider(&self.path, &self.key)
            .map_err(|e| vault_error("save vault", e))
    }

    fn path_buf(&self) -> PathBuf {
        self.path.as_path().to_path_buf()
    }
}

impl Secrets for StrongholdSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        self.with_vault(|vault| {
            let bytes = vault
                .client
                .store()
                .get(key.as_bytes())
                .map_err(|e| vault_error("read secret", e))?;
            bytes
                .map(|b| String::from_utf8(b).map_err(|e| vault_error("decode secret", e)))
                .transpose()
        })
    }

    fn set(&self, key: &str, value: &str) -> Result<(), PortError> {
        self.with_vault(|vault| {
            vault
                .client
                .store()
                .insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
                .map_err(|e| vault_error("write secret", e))?;
            vault.save()
        })
    }

    fn delete(&self, key: &str) -> Result<(), PortError> {
        self.with_vault(|vault| {
            vault
                .client
                .store()
                .delete(key.as_bytes())
                .map_err(|e| vault_error("delete secret", e))?;
            // The plugin saves after every remove, even a missing key.
            vault.save()
        })
    }
}

impl std::fmt::Debug for StrongholdSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let path = self.with_vault(|v| Ok(v.path_buf())).ok();
        f.debug_struct("StrongholdSecrets")
            .field("path", &path)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_delete_survive_reopen() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("vault.hold");
        let salt = root.path().join("salt.txt");

        let secrets = StrongholdSecrets::open(&vault, &salt).unwrap();
        assert_eq!(secrets.get("a").unwrap(), None);
        secrets.set("a", "one").unwrap();
        secrets.set("b", "two").unwrap();
        secrets.delete("missing").unwrap();
        drop(secrets);
        assert_eq!(std::fs::read(&salt).unwrap().len(), SALT_LEN);

        let secrets = StrongholdSecrets::open(&vault, &salt).unwrap();
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("one"));
        secrets.delete("a").unwrap();
        drop(secrets);

        let secrets = StrongholdSecrets::open(&vault, &salt).unwrap();
        assert_eq!(secrets.get("a").unwrap(), None);
        assert_eq!(secrets.get("b").unwrap().as_deref(), Some("two"));
    }

    #[test]
    fn rejects_a_truncated_salt() {
        let root = tempfile::tempdir().unwrap();
        let salt = root.path().join("salt.txt");
        std::fs::write(&salt, b"short").unwrap();
        assert!(StrongholdSecrets::open(&root.path().join("vault.hold"), &salt).is_err());
    }
}
