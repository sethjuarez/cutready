//! Discovery: registration, upgrades and contract checks.

// Test helpers are test code; a failed unwrap is a failed test.
#![allow(clippy::unwrap_used)]

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;

use cutready_cli::discovery::{
    compare_versions, discover, register, DiscoveryError, Registered, Registration, REGISTRY_FILE,
};
use cutready_cli::CONTRACT_VERSION;
use cutready_core::contracts::{
    CliInstall, CliRegistration, CmdErrorCode, CommandFailure, LoadContext, RegistrationOutcome,
};
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
    assert_eq!(err.code(), CmdErrorCode::ContractMismatch);
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
fn versions_order_by_semver() {
    assert_eq!(compare_versions("1.10.0", "1.9.0"), Some(Ordering::Greater));
    assert_eq!(
        compare_versions("1.2.0-rc.1", "1.2.0"),
        Some(Ordering::Less)
    );
    assert_eq!(
        compare_versions("1.2.0-rc.10", "1.2.0-rc.2"),
        Some(Ordering::Greater)
    );
    assert_eq!(
        compare_versions("1.2.0-alpha", "1.2.0-1"),
        Some(Ordering::Greater)
    );
    assert_eq!(
        compare_versions("1.2.0+build.5", "1.2.0"),
        Some(Ordering::Equal)
    );
    assert_eq!(compare_versions("1.2", "1.2.0"), None);
}

#[test]
fn a_registration_with_an_invalid_version_counts_as_older() {
    let dir = tempfile::tempdir().unwrap();
    let odd = install(binary(dir.path(), "odd"), "latest");
    let cli = install(binary(dir.path(), "a"), "1.0.0");
    register(dir.path(), &odd, false).unwrap();
    assert_eq!(
        register(dir.path(), &cli, false).unwrap(),
        Registered::Replaced(odd)
    );
    assert_eq!(discover(dir.path(), CONTRACT_VERSION), Ok(cli));
}

#[test]
fn concurrent_registrations_leave_the_newest() {
    let dir = tempfile::tempdir().unwrap();
    let versions = [
        "1.0.0", "3.0.0", "2.0.0", "1.5.0", "2.9.9", "0.1.0", "2.5.0", "1.1.0",
    ];
    let installs: Vec<Registration> = versions
        .iter()
        .map(|v| install(binary(dir.path(), v), v))
        .collect();
    std::thread::scope(|scope| {
        for cli in &installs {
            let path = dir.path();
            scope.spawn(move || register(path, cli, false).unwrap());
        }
    });
    assert_eq!(
        discover(dir.path(), CONTRACT_VERSION).unwrap().version,
        "3.0.0"
    );
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
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
    let ctx = LoadContext::default();
    let (ok, missing) = cli(config.path(), &["discover"]);
    assert!(!ok);
    let missing = CommandFailure::try_load_from_value(&missing, &ctx).unwrap();
    assert_eq!(missing.error.code, CmdErrorCode::NotRegistered);

    let (ok, registered) = cli(config.path(), &["register"]);
    assert!(ok, "{registered}");
    let registered = CliRegistration::try_load_from_value(&registered, &ctx).unwrap();
    assert_eq!(registered.outcome, RegistrationOutcome::Registered);

    let on_disk: Value =
        serde_json::from_slice(&std::fs::read(config.path().join(REGISTRY_FILE)).unwrap()).unwrap();
    assert_eq!(
        CliInstall::try_load_from_value(&on_disk, &ctx).unwrap(),
        registered.registered
    );

    let (ok, found) = cli(config.path(), &["discover"]);
    assert!(ok, "{found}");
    let found = CliInstall::try_load_from_value(&found, &ctx).unwrap();
    let exe = std::fs::canonicalize(env!("CARGO_BIN_EXE_cutready-cli")).unwrap();
    assert_eq!(std::fs::canonicalize(&found.path).unwrap(), exe);
    assert_eq!(found.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(found.contract_version, CONTRACT_VERSION);

    let (ok, again) = cli(config.path(), &["register"]);
    assert!(ok);
    let again = CliRegistration::try_load_from_value(&again, &ctx).unwrap();
    assert_eq!(again.outcome, RegistrationOutcome::Replaced);
    assert_eq!(again.previous, Some(found));
}

#[test]
fn the_binary_keeps_a_newer_registration() {
    let config = tempfile::tempdir().unwrap();
    let newer = install(binary(config.path(), "newer"), "999.0.0");
    register(config.path(), &newer, false).unwrap();
    let (ok, out) = cli(config.path(), &["register"]);
    assert!(ok, "{out}");
    let out = CliRegistration::try_load_from_value(&out, &LoadContext::default()).unwrap();
    assert_eq!(out.outcome, RegistrationOutcome::KeptNewer);
    assert_eq!(out.registered.version, "999.0.0");
}

#[test]
fn a_malformed_registration_is_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let path = binary(dir.path(), "cli").to_string_lossy().into_owned();
    for value in [
        json!({ "path": path, "version": "1.0.0" }),
        json!({ "path": path, "version": "1.0.0", "contractVersion": CONTRACT_VERSION }),
        json!({ "path": path, "version": 1, "contract_version": CONTRACT_VERSION }),
        json!({ "path": path, "version": "1.0.0", "contract_version": "1" }),
        json!({ "path": "", "version": "1.0.0", "contract_version": CONTRACT_VERSION }),
    ] {
        std::fs::write(dir.path().join(REGISTRY_FILE), value.to_string()).unwrap();
        let err = discover(dir.path(), CONTRACT_VERSION).unwrap_err();
        assert!(
            matches!(err, DiscoveryError::Unreadable(_)),
            "{value}: {err:?}"
        );
        assert_eq!(
            err.to_cmd_error().code,
            CmdErrorCode::UnreadableRegistration
        );
    }
}
