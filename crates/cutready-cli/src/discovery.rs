//! How clients (the canvas, agent hosts) find an installed `cutready-cli`.
//!
//! `cutready-cli register` records the running binary in a per-user file,
//! `<config dir>/cutready/cli.json`:
//!
//! ```json
//! { "path": "/abs/cutready-cli", "version": "1.37.0", "contract_version": 1 }
//! ```
//!
//! A newer install replaces an older one; an older one never replaces a newer
//! one whose binary is still there. A client reads the file, checks the binary
//! exists and its `contract_version` is the one it speaks, then starts
//! `cutready-cli mcp`, whose handshake checks the contract again. Any mismatch
//! fails closed. `CUTREADY_CONFIG_DIR` overrides the directory. The file
//! and the `register`/`discover` output are the contract's `CliInstall`.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};

use cutready_core::contracts::{
    CliInstall, CliRegistration, CmdError, CmdErrorCode, LoadContext, RegistrationOutcome,
    SaveContext,
};
use serde_json::Value;

/// The registration file name inside the discovery directory.
pub const REGISTRY_FILE: &str = "cli.json";

/// Environment variable that replaces the per-user discovery directory.
pub const DIR_ENV: &str = "CUTREADY_CONFIG_DIR";

/// One registered install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub path: PathBuf,
    pub version: String,
    pub contract_version: u32,
}

impl Registration {
    /// The running binary.
    pub fn current() -> std::io::Result<Self> {
        Ok(Self {
            path: std::env::current_exe()?,
            version: env!("CARGO_PKG_VERSION").to_string(),
            contract_version: crate::CONTRACT_VERSION,
        })
    }

    pub fn to_install(&self) -> CliInstall {
        CliInstall {
            path: self.path.to_string_lossy().into_owned(),
            version: self.version.clone(),
            contract_version: self.contract_version,
        }
    }

    fn from_install(install: CliInstall) -> Self {
        Self {
            path: PathBuf::from(install.path),
            version: install.version,
            contract_version: install.contract_version,
        }
    }
}
/// The per-user discovery directory: `CUTREADY_CONFIG_DIR`, else
/// `<config dir>/cutready`.
pub fn default_dir() -> Option<PathBuf> {
    match std::env::var_os(DIR_ENV) {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::config_dir().map(|dir| dir.join("cutready")),
    }
}

/// What `register` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Registered {
    /// Nothing usable was registered.
    New,
    /// Replaced an older, equal or missing install.
    Replaced(Registration),
    /// A newer install is registered and still present; left as is.
    KeptNewer(Registration),
}

impl Registered {
    /// What `register` prints, after recording `install`.
    pub fn to_registration(&self, install: &Registration) -> CliRegistration {
        match self {
            Self::New => CliRegistration {
                outcome: RegistrationOutcome::Registered,
                registered: install.to_install(),
                previous: None,
            },
            Self::Replaced(previous) => CliRegistration {
                outcome: RegistrationOutcome::Replaced,
                registered: install.to_install(),
                previous: Some(previous.to_install()),
            },
            Self::KeptNewer(existing) => CliRegistration {
                outcome: RegistrationOutcome::KeptNewer,
                registered: existing.to_install(),
                previous: None,
            },
        }
    }
}

/// Records `install` in `dir` unless a newer install whose binary exists is
/// registered (`force` records it anyway). A registration whose version isn't
/// SemVer counts as older. Concurrent registrations serialize on a lock file,
/// so the newest install wins whatever order installers finish in.
pub fn register(dir: &Path, install: &Registration, force: bool) -> std::io::Result<Registered> {
    std::fs::create_dir_all(dir)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(format!("{REGISTRY_FILE}.lock")))?;
    lock.lock()?;
    let file = dir.join(REGISTRY_FILE);
    let outcome = match read(&file).ok() {
        None => Registered::New,
        Some(existing) => {
            let newer =
                compare_versions(&existing.version, &install.version) == Some(Ordering::Greater);
            if newer && existing.path.is_file() && !force {
                return Ok(Registered::KeptNewer(existing));
            }
            Registered::Replaced(existing)
        }
    };
    let tmp = dir.join(format!("{REGISTRY_FILE}.{}.tmp", std::process::id()));
    let mut bytes =
        serde_json::to_vec_pretty(&install.to_install().to_value(&SaveContext::default()))
            .map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    {
        let mut out = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut out, &bytes)?;
        out.sync_all()?;
    }
    if let Err(err) = std::fs::rename(&tmp, &file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(outcome)
}

/// Why no usable install was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    NotRegistered,
    Unreadable(String),
    Missing(PathBuf),
    ContractMismatch { registered: u32, expected: u32 },
}

impl DiscoveryError {
    pub fn code(&self) -> CmdErrorCode {
        match self {
            Self::NotRegistered => CmdErrorCode::NotRegistered,
            Self::Unreadable(_) => CmdErrorCode::UnreadableRegistration,
            Self::Missing(_) => CmdErrorCode::MissingBinary,
            Self::ContractMismatch { .. } => CmdErrorCode::ContractMismatch,
        }
    }

    pub fn to_cmd_error(&self) -> CmdError {
        CmdError {
            code: self.code(),
            message: self.to_string(),
            details: None,
        }
    }
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRegistered => write!(f, "No cutready-cli is registered; run `cutready-cli register`"),
            Self::Unreadable(reason) => write!(f, "The cutready-cli registration is unreadable: {reason}"),
            Self::Missing(path) => write!(
                f,
                "The registered cutready-cli is gone: {}; reinstall or run `cutready-cli register`",
                path.display()
            ),
            Self::ContractMismatch { registered, expected } => write!(
                f,
                "The registered cutready-cli speaks edit contract {registered}, not {expected}; install matching versions"
            ),
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// The install registered in `dir`, if its binary exists and it speaks
/// `contract_version`.
pub fn discover(dir: &Path, contract_version: u32) -> Result<Registration, DiscoveryError> {
    let file = dir.join(REGISTRY_FILE);
    let found = read(&file)?;
    if !found.path.is_file() {
        return Err(DiscoveryError::Missing(found.path));
    }
    if found.contract_version != contract_version {
        return Err(DiscoveryError::ContractMismatch {
            registered: found.contract_version,
            expected: contract_version,
        });
    }
    Ok(found)
}

fn read(file: &Path) -> Result<Registration, DiscoveryError> {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(DiscoveryError::NotRegistered)
        }
        Err(err) => return Err(DiscoveryError::Unreadable(err.to_string())),
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| DiscoveryError::Unreadable(e.to_string()))?;
    let complete = value.get("path").and_then(Value::as_str).is_some()
        && value.get("version").and_then(Value::as_str).is_some()
        && value
            .get("contract_version")
            .and_then(Value::as_u64)
            .is_some_and(|v| u32::try_from(v).is_ok());
    let install = CliInstall::try_load_from_value(&value, &LoadContext::default())
        .ok()
        .filter(|install| complete && !install.path.is_empty() && !install.version.is_empty());
    install.map(Registration::from_install).ok_or_else(|| {
        DiscoveryError::Unreadable(
            "expected a CliInstall {path, version, contract_version}".to_string(),
        )
    })
}

/// Orders two SemVer versions (prerelease identifiers compare per SemVer);
/// `None` when either isn't valid SemVer.
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let a = semver::Version::parse(a).ok()?;
    let b = semver::Version::parse(b).ok()?;
    Some(a.cmp_precedence(&b))
}
