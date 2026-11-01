//! How clients (the canvas, agent hosts) find an installed `cutready-cli`.
//!
//! `cutready-cli register` records the running binary in a per-user file,
//! `<config dir>/cutready/cli.json`:
//!
//! ```json
//! { "path": "/abs/cutready-cli", "version": "1.37.0", "contractVersion": 1 }
//! ```
//!
//! A newer install replaces an older one; an older one never replaces a newer
//! one whose binary is still there. A client reads the file, checks the binary
//! exists and its `contractVersion` is the one it speaks, then starts
//! `cutready-cli mcp`, whose handshake checks the contract again. Any mismatch
//! fails closed. `CUTREADY_CONFIG_DIR` overrides the directory.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

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

    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path.to_string_lossy(),
            "version": self.version,
            "contractVersion": self.contract_version,
        })
    }

    fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            path: PathBuf::from(value.get("path")?.as_str()?),
            version: value.get("version")?.as_str()?.to_string(),
            contract_version: u32::try_from(value.get("contractVersion")?.as_u64()?).ok()?,
        })
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
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::New => "registered",
            Self::Replaced(_) => "replaced",
            Self::KeptNewer(_) => "kept_newer",
        }
    }
}

/// Records `install` in `dir` unless a newer install whose binary exists is
/// registered (`force` records it anyway).
pub fn register(dir: &Path, install: &Registration, force: bool) -> std::io::Result<Registered> {
    let file = dir.join(REGISTRY_FILE);
    let existing = read(&file).ok();
    let outcome = match existing {
        None => Registered::New,
        Some(existing) => {
            let newer = compare_versions(&existing.version, &install.version) == Ordering::Greater;
            if newer && existing.path.is_file() && !force {
                return Ok(Registered::KeptNewer(existing));
            }
            Registered::Replaced(existing)
        }
    };
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{REGISTRY_FILE}.tmp"));
    let mut bytes = serde_json::to_vec_pretty(&install.to_json()).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &file)?;
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
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotRegistered => "not_registered",
            Self::Unreadable(_) => "unreadable_registration",
            Self::Missing(_) => "missing_binary",
            Self::ContractMismatch { .. } => "contract_mismatch",
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
    Registration::from_json(&value).ok_or_else(|| {
        DiscoveryError::Unreadable("expected {path, version, contractVersion}".to_string())
    })
}

/// Orders `major.minor.patch[-pre]` versions; a pre-release sorts before its
/// release. Unparsable parts count as 0.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parse(version: &str) -> ([u64; 3], Option<&str>) {
        let (core, pre) = match version.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (version, None),
        };
        let mut parts = [0; 3];
        for (slot, part) in parts.iter_mut().zip(core.split('.')) {
            *slot = part.parse().unwrap_or(0);
        }
        (parts, pre)
    }
    let (a_core, a_pre) = parse(a);
    let (b_core, b_pre) = parse(b);
    a_core.cmp(&b_core).then_with(|| match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => a.cmp(b),
    })
}
