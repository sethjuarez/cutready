//! Who is acting in CutReady, as plain data. Hosts resolve it (the desktop
//! reads the CutReady profile, `GIT_AUTHOR_*`, git config, then the OS user);
//! versioning reads it to author saves.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentitySource {
    Profile,
    Environment,
    GitConfig,
    System,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedIdentity {
    pub name: String,
    pub email: Option<String>,
    pub name_source: IdentitySource,
    pub email_source: Option<IdentitySource>,
    /// The identity saved in CutReady, if any.
    pub profile: Option<Identity>,
    /// True when no email is known, so attribution would be anonymous.
    pub needs_setup: bool,
}
