//! Resolves who is acting in CutReady, for snapshot authorship and chat promotion.
//!
//! Each field is taken from the first layer that supplies it:
//! the CutReady profile, `GIT_AUTHOR_*`, git config, then the OS username.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Name used when no layer supplies one.
pub const FALLBACK_NAME: &str = "CutReady User";

/// Values older CutReady and Draftline builds wrote when no identity was known.
const PLACEHOLDER_NAMES: &[&str] = &["cutready", "cutready user", "draftline"];
const PLACEHOLDER_EMAILS: &[&str] = &["app@cutready.local", "draftline@example.invalid"];

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

struct Layer {
    source: IdentitySource,
    name: Option<String>,
    email: Option<String>,
}

/// Resolve the acting identity for a project (or for no project).
pub fn resolve(project_root: Option<&Path>, profile: Option<Identity>) -> ResolvedIdentity {
    resolve_with(profile, |key| std::env::var(key).ok(), || {
        git_config_identity(project_root)
    })
}

fn resolve_with(
    profile: Option<Identity>,
    env: impl Fn(&str) -> Option<String>,
    git_config: impl FnOnce() -> (Option<String>, Option<String>),
) -> ResolvedIdentity {
    let raw_profile = profile;
    let profile = raw_profile.clone().and_then(normalize_profile);
    let (git_name, git_email) = git_config();
    // Clean each candidate on its own so a placeholder in one field never hides
    // a usable value in the other, and USER still counts when USERNAME is junk.
    let layers = [
        Layer {
            source: IdentitySource::Profile,
            name: raw_profile.as_ref().map(|p| p.name.clone()),
            email: raw_profile.as_ref().and_then(|p| p.email.clone()),
        },
        Layer {
            source: IdentitySource::Environment,
            name: env("GIT_AUTHOR_NAME"),
            email: env("GIT_AUTHOR_EMAIL"),
        },
        Layer {
            source: IdentitySource::GitConfig,
            name: git_name,
            email: git_email,
        },
        Layer {
            source: IdentitySource::System,
            name: clean_name(env("USERNAME").as_deref())
                .or_else(|| clean_name(env("USER").as_deref())),
            email: None,
        },
    ];

    let (name, name_source) = layers
        .iter()
        .find_map(|layer| clean_name(layer.name.as_deref()).map(|name| (name, layer.source)))
        .unwrap_or_else(|| (FALLBACK_NAME.to_string(), IdentitySource::Fallback));
    let email = layers
        .iter()
        .find_map(|layer| clean_email(layer.email.as_deref()).map(|email| (email, layer.source)));

    ResolvedIdentity {
        name,
        needs_setup: email.is_none(),
        email_source: email.as_ref().map(|(_, source)| *source),
        email: email.map(|(email, _)| email),
        name_source,
        profile,
    }
}

/// Validate a name and email the user entered for their CutReady profile.
pub fn validate_profile(name: &str, email: &str) -> Result<Identity, String> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() {
        return Err("Enter your name.".into());
    }
    if name.chars().count() > 200 || name.contains(['<', '>', '\n', '\r']) {
        return Err("Names can't contain angle brackets or line breaks.".into());
    }
    if clean_name(Some(name)).is_none() {
        return Err(format!("\"{name}\" is a placeholder; enter your own name."));
    }
    let valid_email = email
        .split_once('@')
        .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty() && !domain.contains('@'))
        && !email.contains(|ch: char| ch.is_whitespace() || ch == '<' || ch == '>');
    if !valid_email {
        return Err("Enter an email like you@example.com.".into());
    }
    if clean_email(Some(email)).is_none() {
        return Err(format!("{email} is a placeholder; enter your own email."));
    }
    Ok(Identity {
        name: name.to_string(),
        email: Some(email.to_string()),
    })
}

fn normalize_profile(profile: Identity) -> Option<Identity> {
    Some(Identity {
        name: clean_name(Some(&profile.name))?,
        email: clean_email(profile.email.as_deref()),
    })
}

fn clean_name(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty() && !PLACEHOLDER_NAMES.contains(&value.to_lowercase().as_str()))
        .then(|| value.to_string())
}

fn clean_email(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty() && !PLACEHOLDER_EMAILS.contains(&value.to_lowercase().as_str()))
        .then(|| value.to_string())
}

/// `user.name` / `user.email` from the project's git config (local, global, system),
/// or from the global config when there is no project.
fn git_config_identity(project_root: Option<&Path>) -> (Option<String>, Option<String>) {
    let config = project_root
        .and_then(|root| git2::Repository::discover(root).ok())
        .and_then(|repo| repo.config().ok())
        .or_else(|| git2::Config::open_default().ok());
    let Some(config) = config else {
        return (None, None);
    };
    (
        config.get_string("user.name").ok(),
        config.get_string("user.email").ok(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| vars.get(key).cloned()
    }

    fn git(name: Option<&str>, email: Option<&str>) -> impl FnOnce() -> (Option<String>, Option<String>) {
        let name = name.map(str::to_string);
        let email = email.map(str::to_string);
        move || (name, email)
    }

    fn ada() -> Identity {
        Identity {
            name: "Ada Lovelace".into(),
            email: Some("ada@example.com".into()),
        }
    }

    #[test]
    fn profile_wins_over_every_other_layer() {
        let resolved = resolve_with(
            Some(ada()),
            env(&[("GIT_AUTHOR_NAME", "Env"), ("GIT_AUTHOR_EMAIL", "env@example.com")]),
            git(Some("Git"), Some("git@example.com")),
        );
        assert_eq!(resolved.name, "Ada Lovelace");
        assert_eq!(resolved.email.as_deref(), Some("ada@example.com"));
        assert_eq!(resolved.name_source, IdentitySource::Profile);
        assert_eq!(resolved.email_source, Some(IdentitySource::Profile));
        assert_eq!(resolved.profile, Some(ada()));
        assert!(!resolved.needs_setup);
    }

    #[test]
    fn environment_beats_git_config_per_field() {
        let resolved = resolve_with(
            None,
            env(&[("GIT_AUTHOR_NAME", "Env Name")]),
            git(Some("Git Name"), Some("git@example.com")),
        );
        assert_eq!(resolved.name, "Env Name");
        assert_eq!(resolved.name_source, IdentitySource::Environment);
        assert_eq!(resolved.email.as_deref(), Some("git@example.com"));
        assert_eq!(resolved.email_source, Some(IdentitySource::GitConfig));
    }

    #[test]
    fn placeholders_written_by_older_builds_are_ignored() {
        let resolved = resolve_with(
            None,
            env(&[("USERNAME", "sejuare")]),
            git(Some("CutReady"), Some("app@cutready.local")),
        );
        assert_eq!(resolved.name, "sejuare");
        assert_eq!(resolved.name_source, IdentitySource::System);
        assert_eq!(resolved.email, None);
        assert!(resolved.needs_setup);
    }

    #[test]
    fn falls_back_when_nothing_is_known() {
        let resolved = resolve_with(None, env(&[]), git(None, Some("  ")));
        assert_eq!(resolved.name, FALLBACK_NAME);
        assert_eq!(resolved.name_source, IdentitySource::Fallback);
        assert_eq!(resolved.email_source, None);
        assert!(resolved.needs_setup);
    }

    #[test]
    fn stored_profile_is_trimmed_and_placeholder_profile_is_dropped() {
        let resolved = resolve_with(
            Some(Identity {
                name: "  Grace  ".into(),
                email: Some(" grace@example.com ".into()),
            }),
            env(&[]),
            git(None, None),
        );
        assert_eq!(resolved.name, "Grace");
        assert_eq!(resolved.email.as_deref(), Some("grace@example.com"));

        let resolved = resolve_with(
            Some(Identity {
                name: "CutReady".into(),
                email: Some("app@cutready.local".into()),
            }),
            env(&[("USER", "grace")]),
            git(None, None),
        );
        assert_eq!(resolved.profile, None);
        assert_eq!(resolved.name, "grace");
    }

    #[test]
    fn placeholder_profile_name_keeps_the_profile_email() {
        let resolved = resolve_with(
            Some(Identity {
                name: "CutReady User".into(),
                email: Some("grace@example.com".into()),
            }),
            env(&[]),
            git(Some("Git Name"), None),
        );
        assert_eq!(resolved.name, "Git Name");
        assert_eq!(resolved.name_source, IdentitySource::GitConfig);
        assert_eq!(resolved.email.as_deref(), Some("grace@example.com"));
        assert_eq!(resolved.email_source, Some(IdentitySource::Profile));
        assert!(!resolved.needs_setup);
    }

    #[test]
    fn placeholder_username_falls_through_to_user() {
        let resolved = resolve_with(
            None,
            env(&[("USERNAME", "CutReady"), ("USER", "grace")]),
            git(None, None),
        );
        assert_eq!(resolved.name, "grace");
        assert_eq!(resolved.name_source, IdentitySource::System);
    }

    #[test]
    fn validate_profile_accepts_and_trims_real_identities() {
        assert_eq!(
            validate_profile("  Ada Lovelace ", " ada@example.com "),
            Ok(ada())
        );
    }

    #[test]
    fn validate_profile_rejects_bad_input() {
        for (name, email) in [
            ("", "ada@example.com"),
            ("Ada <x>", "ada@example.com"),
            ("Ada\nLovelace", "ada@example.com"),
            ("CutReady", "ada@example.com"),
            ("Ada", ""),
            ("Ada", "ada"),
            ("Ada", "@example.com"),
            ("Ada", "ada@"),
            ("Ada", "a@b@c"),
            ("Ada", "ada @example.com"),
            ("Ada", "app@cutready.local"),
        ] {
            assert!(
                validate_profile(name, email).is_err(),
                "expected {name:?} / {email:?} to be rejected"
            );
        }
    }

    #[test]
    fn git_config_reads_repository_local_identity() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
        config.set_str("user.name", "Local Name").unwrap();
        config.set_str("user.email", "local@example.com").unwrap();
        let nested = dir.path().join("project");
        std::fs::create_dir_all(&nested).unwrap();

        assert_eq!(
            git_config_identity(Some(&nested)),
            (Some("Local Name".into()), Some("local@example.com".into()))
        );
    }
}
