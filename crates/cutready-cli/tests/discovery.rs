//! Discovery: registration, upgrades and contract checks.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;

use cutready_cli::discovery::{
    compare_versions, discover, register, DiscoveryError, Registered, Registration, REGISTRY_FILE,
};
use cutready_cli::CONTRACT_VERSION;
use serde_json::{json, Value};

/// A stand-in binary that exists on disk.
fn binary(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, b"bin").unwrap();
    path
}

fn install(path: PathBuf, version: &str) -> Registration {
    Registration {
        path,
        version: version.to_string(),
        contract_version: CONTRACT_VERSION,
    }
}

#[test]
fn nothing_registered_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        discover(dir.path(), CONTRACT_VERSION),
        Err(DiscoveryError::NotRegistered)
    );
}

#[test]
fn a_registered_install_is_discovered() {
    let dir = tempfile::tempdir().unwrap();
    let cli = install(binary(dir.path(), "a"), "1.0.0");
    assert_eq!(register(dir.path(), &cli, false).unwrap(), Registered::New);
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(cli));
}

#[test]
fn a_newer_install_replaces_an_older_one() {
    let dir = tempfile::tempdir().unwrap();
    let old = install(binary(dir.path(), "old"), "1.2.0");
    let new = install(binary(dir.path(), "new"), "1.10.0");
    register(dir.path(), &old, false).unwrap();
    assert_eq!(
        register(dir.path(), &new, false).unwrap(),
        Registered::Replaced(old)
    );
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(new));
}

#[test]
fn an_older_install_keeps_a_newer_one() {
    let dir = tempfile::tempdir().unwrap();
    let new = install(binary(dir.path(), "new"), "2.0.0");
    let old = install(binary(dir.path(), "old"), "1.9.9");
    register(dir.path(), &new, false).unwrap();
    assert_eq!(
        register(dir.path(), &old, false).unwrap(),
        Registered::KeptNewer(new.clone())
    );
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(new));
}

#[test]
fn force_registers_an_older_install() {
    let dir = tempfile::tempdir().unwrap();
    let new = install(binary(dir.path(), "new"), "2.0.0");
    let old = install(binary(dir.path(), "old"), "1.0.0");
    register(dir.path(), &new, false).unwrap();
    assert_eq!(
        register(dir.path(), &old, true).unwrap(),
        Registered::Replaced(new)
    );
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(old));
}

#[test]
fn an_older_install_replaces_a_newer_one_that_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let gone = install(dir.path().join("uninstalled"), "2.0.0");
    let old = install(binary(dir.path(), "old"), "1.0.0");
    register(dir.path(), &gone, false).unwrap();
    assert_eq!(
        discover(dir.path(), CONTRACT_VERSION),
        Err(DiscoveryError::Missing(gone.path.clone()))
    );
    assert_eq!(
        register(dir.path(), &old, false).unwrap(),
        Registered::Replaced(gone)
    );
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(old));
}

#[test]
fn another_contract_version_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let mut other = install(binary(dir.path(), "a"), "9.0.0");
    other.contract_version = CONTRACT_VERSION + 1;
    register(dir.path(), &other, false).unwrap();
    let err = discover(dir.path(), CONTRACT_VERSION).unwrap_err();
    assert_eq!(
        err,
        DiscoveryError::ContractMismatch {
            registered: CONTRACT_VERSION + 1,
            expected: CONTRACT_VERSION,
        }
    );
    assert_eq!(err.code(), "contract_mismatch");
}

#[test]
fn a_corrupt_registration_is_unreadable_and_can_be_replaced() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(REGISTRY_FILE), "{not json").unwrap();
    assert!(matches!(
        discover(dir.path(), CONTRACT_VERSION),
        Err(DiscoveryError::Unreadable(_))
    ));
    let cli = install(binary(dir.path(), "a"), "1.0.0");
    assert_eq!(register(dir.path(), &cli, false).unwrap(), Registered::New);
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(cli));
}

#[test]
fn versions_order_numerically_with_prereleases_first() {
    assert_eq!(compare_versions("1.10.0", "1.9.0"), Ordering::Greater);
    assert_eq!(compare_versions("1.2.0-rc.1", "1.2.0"), Ordering::Less);
    assert_eq!(compare_versions("1.2.0", "1.2.0"), Ordering::Equal);
    assert_eq!(compare_versions("2", "1.99.99"), Ordering::Greater);
}

fn cli(config: &Path, args: &[&str]) -> (bool, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_cutready-cli"))
        .args(args)
        .env("CUTREADY_CONFIG_DIR", config)
        .output()
        .expect("cutready-cli runs");
    let value = serde_json::from_slice(&output.stdout).unwrap_or_else(|err| {
        panic!(
            "stdout is not JSON ({err}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    });
    (output.status.success(), value)
}

#[test]
fn the_binary_registers_itself_and_is_discovered() {
    let config = tempfile::tempdir().unwrap();
    let (ok, missing) = cli(config.path(), &["discover"]);
    assert!(!ok);
    assert_eq!(missing["error"]["code"], json!("not_registered"));

    let (ok, registered) = cli(config.path(), &["register"]);
    assert!(ok, "{registered}");
    assert_eq!(registered["outcome"], json!("registered"));

    let (ok, found) = cli(config.path(), &["discover"]);
    assert!(ok, "{found}");
    let exe = std::fs::canonicalize(env!("CARGO_BIN_EXE_cutready-cli")).unwrap();
    let path = std::fs::canonicalize(found["path"].as_str().unwrap()).unwrap();
    assert_eq!(path, exe);
    assert_eq!(found["version"], json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(found["contractVersion"], json!(CONTRACT_VERSION));

    let (ok, again) = cli(config.path(), &["register"]);
    assert!(ok);
    assert_eq!(again["outcome"], json!("replaced"));
}

#[test]
fn the_binary_keeps_a_newer_registration() {
    let config = tempfile::tempdir().unwrap();
    let newer = install(binary(config.path(), "newer"), "999.0.0");
    register(config.path(), &newer, false).unwrap();
    let (ok, out) = cli(config.path(), &["register"]);
    assert!(ok, "{out}");
    assert_eq!(out["outcome"], json!("kept_newer"));
    assert_eq!(out["registered"]["version"], json!("999.0.0"));
}
