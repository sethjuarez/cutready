use std::{fmt, path::PathBuf, time::Duration};

use keyring::Entry;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri_plugin_auditaur::auditaur_command;

const GITHUB_CLIENT_ID_ENV: &str = "CUTREADY_GITHUB_OAUTH_CLIENT_ID";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER_URL: &str = "https://api.github.com/user";
const GITHUB_DEFAULT_SCOPE: &str = "repo read:user user:email";
const GITHUB_KEYRING_SERVICE: &str = "com.cutready.app.github";
const GITHUB_TOKEN_ACCOUNT: &str = "oauth-token";
const GITHUB_USER_AGENT: &str = "CutReady";

#[derive(Debug, Clone)]
struct GitHubAuthConfig {
    client_id: String,
    device_code_url: String,
    access_token_url: String,
    api_user_url: String,
}

impl GitHubAuthConfig {
    fn from_env() -> Result<Self, String> {
        Ok(Self {
            client_id: github_client_id().ok_or_else(missing_client_id_message)?,
            device_code_url: GITHUB_DEVICE_CODE_URL.to_string(),
            access_token_url: GITHUB_ACCESS_TOKEN_URL.to_string(),
            api_user_url: GITHUB_API_USER_URL.to_string(),
        })
    }
}

trait GitHubTokenStore: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, token: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Debug)]
enum GitHubTokenValidationError {
    InvalidToken,
    Indeterminate(String),
}

impl fmt::Display for GitHubTokenValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidToken => {
                write!(formatter, "GitHub token is no longer valid. Sign in again.")
            }
            Self::Indeterminate(error) => formatter.write_str(error),
        }
    }
}

struct KeyringGitHubTokenStore;

impl GitHubTokenStore for KeyringGitHubTokenStore {
    fn get(&self) -> Option<String> {
        github_token_entry()
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
    }

    fn set(&self, token: &str) -> Result<(), String> {
        github_token_entry()?
            .set_password(token)
            .map_err(|error| format!("Could not store GitHub token in the OS keychain: {error}"))
    }

    fn delete(&self) -> Result<(), String> {
        match github_token_entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) => {
                let text = error.to_string();
                if text.contains("No matching entry") || text.contains("not found") {
                    Ok(())
                } else {
                    Err(format!(
                        "Could not remove GitHub token from the OS keychain: {error}"
                    ))
                }
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDeviceCodeStartResult {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthCompleteResult {
    pub account: GitHubAccount,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthStatus {
    pub client_configured: bool,
    pub connected: bool,
    pub account: Option<GitHubAccount>,
    pub credential_source: Option<String>,
    pub gh_cli: GitHubCliStatus,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
    html_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GitHubCredentialToken {
    pub token: String,
    pub source: &'static str,
}

#[auditaur_command(skip_all, err)]
pub async fn github_device_code_start(
    scope: Option<String>,
) -> Result<GitHubDeviceCodeStartResult, String> {
    let config = GitHubAuthConfig::from_env()?;
    github_device_code_start_with_config(&reqwest::Client::new(), &config, scope.as_deref()).await
}

async fn github_device_code_start_with_config(
    client: &reqwest::Client,
    config: &GitHubAuthConfig,
    scope: Option<&str>,
) -> Result<GitHubDeviceCodeStartResult, String> {
    let scope = scope
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(GITHUB_DEFAULT_SCOPE);

    tracing::info!(scope, "starting GitHub device authorization");
    let response = client
        .post(&config.device_code_url)
        .header("Accept", "application/json")
        .header("User-Agent", GITHUB_USER_AGENT)
        .form(&[("client_id", config.client_id.as_str()), ("scope", scope)])
        .send()
        .await
        .map_err(|error| format!("Could not start GitHub sign-in: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub sign-in setup failed with HTTP {}",
            response.status()
        ));
    }

    let body = response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|error| format!("Could not read GitHub sign-in response: {error}"))?;
    if let Some(error) = body.error {
        return Err(body
            .error_description
            .unwrap_or_else(|| format!("GitHub sign-in setup failed: {error}")));
    }

    Ok(GitHubDeviceCodeStartResult {
        device_code: body.device_code,
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        expires_in: body.expires_in,
        interval: body.interval.unwrap_or(5),
    })
}

#[auditaur_command(skip_all, err)]
pub async fn github_device_code_poll(
    device_code: String,
    interval: u64,
    timeout: u64,
) -> Result<GitHubAuthCompleteResult, String> {
    let config = GitHubAuthConfig::from_env()?;
    github_device_code_poll_with_config(
        &reqwest::Client::new(),
        &config,
        &KeyringGitHubTokenStore,
        device_code,
        interval,
        timeout,
    )
    .await
}

async fn github_device_code_poll_with_config(
    client: &reqwest::Client,
    config: &GitHubAuthConfig,
    token_store: &dyn GitHubTokenStore,
    device_code: String,
    interval: u64,
    timeout: u64,
) -> Result<GitHubAuthCompleteResult, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout.max(1));
    let mut wait = Duration::from_secs(interval.max(1));

    loop {
        if std::time::Instant::now() >= deadline {
            return Err("GitHub sign-in timed out. Try connecting again.".to_string());
        }

        tokio::time::sleep(wait).await;
        let response = client
            .post(&config.access_token_url)
            .header("Accept", "application/json")
            .header("User-Agent", GITHUB_USER_AGENT)
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|error| format!("Could not check GitHub sign-in: {error}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "GitHub sign-in failed with HTTP {}",
                response.status()
            ));
        }

        let body = response
            .json::<AccessTokenResponse>()
            .await
            .map_err(|error| format!("Could not read GitHub token response: {error}"))?;

        if let Some(token) = body.access_token {
            let account = github_account_for_token(client, &config.api_user_url, &token)
                .await
                .map_err(|error| error.to_string())?;
            token_store.set(&token)?;
            tracing::info!(login = %account.login, "GitHub account connected");
            return Ok(GitHubAuthCompleteResult { account });
        }

        match body.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                wait += Duration::from_secs(body.interval.unwrap_or(5));
            }
            Some("expired_token") => {
                return Err(
                    "GitHub sign-in code expired. Start again to get a new code.".to_string(),
                )
            }
            Some("access_denied") => {
                return Err("GitHub sign-in was cancelled or denied.".to_string())
            }
            Some(error) => {
                return Err(body
                    .error_description
                    .unwrap_or_else(|| format!("GitHub sign-in failed: {error}")))
            }
            None => return Err("GitHub did not return an access token.".to_string()),
        }
    }
}

#[auditaur_command(skip_all, err)]
pub async fn github_auth_status() -> Result<GitHubAuthStatus, String> {
    let client = reqwest::Client::new();
    let config = GitHubAuthConfig {
        client_id: github_client_id().unwrap_or_default(),
        device_code_url: GITHUB_DEVICE_CODE_URL.to_string(),
        access_token_url: GITHUB_ACCESS_TOKEN_URL.to_string(),
        api_user_url: GITHUB_API_USER_URL.to_string(),
    };
    github_auth_status_with(&client, &config, &KeyringGitHubTokenStore).await
}

async fn github_auth_status_with(
    client: &reqwest::Client,
    config: &GitHubAuthConfig,
    token_store: &dyn GitHubTokenStore,
) -> Result<GitHubAuthStatus, String> {
    let client_configured = !config.client_id.trim().is_empty();
    if let Some(token) = token_store.get() {
        match github_account_for_token(client, &config.api_user_url, &token).await {
            Ok(account) => {
                return Ok(GitHubAuthStatus {
                    client_configured,
                    connected: true,
                    account: Some(account),
                    credential_source: Some("cutready".to_string()),
                    gh_cli: gh_cli_status(),
                });
            }
            Err(GitHubTokenValidationError::InvalidToken) => {
                tracing::warn!("stored GitHub token is no longer valid");
                token_store.delete().map_err(|delete_error| {
                    format!(
                        "Stored GitHub token is invalid, but CutReady could not remove it from the OS keychain: {delete_error}"
                    )
                })?;
                tracing::info!("removed invalid stored GitHub token");
            }
            Err(GitHubTokenValidationError::Indeterminate(error)) => {
                tracing::warn!(error = %error, "stored GitHub token validation failed");
                return Err(error);
            }
        }
    }

    let gh_cli = gh_cli_status();
    Ok(GitHubAuthStatus {
        client_configured,
        connected: gh_cli.authenticated,
        account: None,
        credential_source: gh_cli.authenticated.then(|| "gh_cli".to_string()),
        gh_cli,
    })
}

#[auditaur_command(skip_all, err)]
pub async fn github_sign_out() -> Result<(), String> {
    KeyringGitHubTokenStore.delete()
}

pub fn github_credential_token() -> Option<GitHubCredentialToken> {
    if let Some(token) = stored_github_token() {
        return Some(GitHubCredentialToken {
            token,
            source: "cutready",
        });
    }
    gh_token().map(|token| GitHubCredentialToken {
        token,
        source: "gh_cli",
    })
}

pub fn stored_github_token() -> Option<String> {
    KeyringGitHubTokenStore.get()
}

fn github_token_entry() -> Result<Entry, String> {
    Entry::new(GITHUB_KEYRING_SERVICE, GITHUB_TOKEN_ACCOUNT)
        .map_err(|error| format!("Could not open the OS keychain: {error}"))
}

async fn github_account_for_token(
    client: &reqwest::Client,
    api_user_url: &str,
    token: &str,
) -> Result<GitHubAccount, GitHubTokenValidationError> {
    let response = client
        .get(api_user_url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", GITHUB_USER_AGENT)
        .send()
        .await
        .map_err(|error| {
            GitHubTokenValidationError::Indeterminate(format!(
                "Could not validate GitHub account: {error}"
            ))
        })?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(GitHubTokenValidationError::InvalidToken);
    }
    if !response.status().is_success() {
        return Err(GitHubTokenValidationError::Indeterminate(format!(
            "GitHub account validation failed with HTTP {}",
            response.status()
        )));
    }

    let user = response
        .json::<GitHubUserResponse>()
        .await
        .map_err(|error| {
            GitHubTokenValidationError::Indeterminate(format!(
                "Could not read GitHub account: {error}"
            ))
        })?;
    Ok(GitHubAccount {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
    })
}

fn github_client_id() -> Option<String> {
    std::env::var(GITHUB_CLIENT_ID_ENV)
        .ok()
        .or_else(|| option_env!("CUTREADY_GITHUB_OAUTH_CLIENT_ID").map(ToString::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn missing_client_id_message() -> String {
    format!("GitHub OAuth is not configured. Set {GITHUB_CLIENT_ID_ENV} for this build.")
}

fn gh_cli_status() -> GitHubCliStatus {
    let installed = gh_command_candidates()
        .into_iter()
        .find_map(|path| command_exists(&path).then_some(path));
    let Some(path) = installed else {
        return GitHubCliStatus {
            installed: false,
            authenticated: false,
            path: None,
        };
    };

    GitHubCliStatus {
        installed: true,
        authenticated: gh_token_from(&path).is_some(),
        path: Some(path.display().to_string()),
    }
}

pub fn gh_token() -> Option<String> {
    gh_command_candidates()
        .into_iter()
        .find_map(|candidate| gh_token_from(&candidate))
}

fn gh_token_from(candidate: &PathBuf) -> Option<String> {
    let mut cmd = std::process::Command::new(candidate);
    cmd.args(["auth", "token"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!token.is_empty()).then_some(token)
        }
        Ok(output) => {
            tracing::debug!(
                gh = %candidate.display(),
                status = ?output.status.code(),
                "GitHub CLI token lookup failed"
            );
            None
        }
        Err(error) => {
            tracing::debug!(
                gh = %candidate.display(),
                error = %error,
                "GitHub CLI token lookup could not start"
            );
            None
        }
    }
}

fn gh_command_candidates() -> Vec<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    {
        vec![PathBuf::from("gh")]
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("gh"),
            PathBuf::from("/opt/homebrew/bin/gh"),
            PathBuf::from("/usr/local/bin/gh"),
            PathBuf::from("/usr/bin/gh"),
        ]
    }
}

fn command_exists(command: &PathBuf) -> bool {
    let mut cmd = std::process::Command::new(command);
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.status().map(|status| status.success()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct MemoryGitHubTokenStore {
        token: Mutex<Option<String>>,
    }

    impl MemoryGitHubTokenStore {
        fn new() -> Self {
            Self {
                token: Mutex::new(None),
            }
        }

        fn with_token(token: &str) -> Self {
            Self {
                token: Mutex::new(Some(token.to_string())),
            }
        }
    }

    impl GitHubTokenStore for MemoryGitHubTokenStore {
        fn get(&self) -> Option<String> {
            self.token.lock().ok().and_then(|token| token.clone())
        }

        fn set(&self, token: &str) -> Result<(), String> {
            *self
                .token
                .lock()
                .map_err(|error| format!("test token store lock failed: {error}"))? =
                Some(token.to_string());
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            *self
                .token
                .lock()
                .map_err(|error| format!("test token store lock failed: {error}"))? = None;
            Ok(())
        }
    }

    fn test_config(server: &MockServer) -> GitHubAuthConfig {
        GitHubAuthConfig {
            client_id: "test-client-id".to_string(),
            device_code_url: server.url("/login/device/code"),
            access_token_url: server.url("/login/oauth/access_token"),
            api_user_url: server.url("/user"),
        }
    }

    #[test]
    fn missing_client_id_message_names_expected_env() {
        assert!(missing_client_id_message().contains(GITHUB_CLIENT_ID_ENV));
    }

    #[tokio::test]
    async fn device_code_start_posts_client_and_scope_to_github() {
        let server = MockServer::start();
        let device_code = server.mock(|when, then| {
            when.method(POST)
                .path("/login/device/code")
                .header("accept", "application/json")
                .header("user-agent", GITHUB_USER_AGENT)
                .body_contains("client_id=test-client-id")
                .body_contains("scope=repo+read%3Auser");
            then.status(200).json_body(json!({
                "device_code": "device-123",
                "user_code": "ABCD-1234",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900
            }));
        });

        let result = github_device_code_start_with_config(
            &reqwest::Client::new(),
            &test_config(&server),
            Some("repo read:user"),
        )
        .await
        .expect("device code start should parse mock GitHub response");

        assert_eq!(result.device_code, "device-123");
        assert_eq!(result.user_code, "ABCD-1234");
        assert_eq!(result.verification_uri, "https://github.com/login/device");
        assert_eq!(result.expires_in, 900);
        assert_eq!(result.interval, 5);
        device_code.assert();
    }

    #[tokio::test]
    async fn device_code_poll_stores_token_and_returns_account() {
        let server = MockServer::start();
        let token_exchange = server.mock(|when, then| {
            when.method(POST)
                .path("/login/oauth/access_token")
                .header("accept", "application/json")
                .header("user-agent", GITHUB_USER_AGENT)
                .body_contains("client_id=test-client-id")
                .body_contains("device_code=device-123")
                .body_contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
            then.status(200).json_body(json!({
                "access_token": "gho_mock_token",
                "token_type": "bearer",
                "scope": "repo,read:user"
            }));
        });
        let user_lookup = server.mock(|when, then| {
            when.method(GET)
                .path("/user")
                .header("authorization", "Bearer gho_mock_token")
                .header("accept", "application/vnd.github+json")
                .header("user-agent", GITHUB_USER_AGENT);
            then.status(200).json_body(json!({
                "login": "octomarketer",
                "name": "Octo Marketer",
                "avatar_url": "https://avatars.example/octo.png",
                "html_url": "https://github.com/octomarketer"
            }));
        });
        let token_store = MemoryGitHubTokenStore::new();

        let result = github_device_code_poll_with_config(
            &reqwest::Client::new(),
            &test_config(&server),
            &token_store,
            "device-123".to_string(),
            1,
            5,
        )
        .await
        .expect("device code poll should store token and return account");

        assert_eq!(result.account.login, "octomarketer");
        assert_eq!(result.account.name.as_deref(), Some("Octo Marketer"));
        assert_eq!(token_store.get().as_deref(), Some("gho_mock_token"));
        token_exchange.assert();
        user_lookup.assert();
    }

    #[tokio::test]
    async fn device_code_poll_does_not_store_token_when_account_validation_fails() {
        let server = MockServer::start();
        let token_exchange = server.mock(|when, then| {
            when.method(POST)
                .path("/login/oauth/access_token")
                .header("accept", "application/json")
                .header("user-agent", GITHUB_USER_AGENT)
                .body_contains("client_id=test-client-id")
                .body_contains("device_code=device-123")
                .body_contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
            then.status(200).json_body(json!({
                "access_token": "gho_invalid_token",
                "token_type": "bearer",
                "scope": "repo,read:user"
            }));
        });
        let user_lookup = server.mock(|when, then| {
            when.method(GET)
                .path("/user")
                .header_exists("authorization")
                .header("accept", "application/vnd.github+json")
                .header("user-agent", GITHUB_USER_AGENT);
            then.status(401).json_body(json!({
                "message": "Bad credentials"
            }));
        });
        let token_store = MemoryGitHubTokenStore::new();

        let error = github_device_code_poll_with_config(
            &reqwest::Client::new(),
            &test_config(&server),
            &token_store,
            "device-123".to_string(),
            1,
            5,
        )
        .await
        .expect_err("invalid exchanged token should fail account validation");

        assert!(error.contains("GitHub token is no longer valid"));
        assert_eq!(token_store.get(), None);
        token_exchange.assert();
        user_lookup.assert();
    }

    #[tokio::test]
    async fn auth_status_deletes_invalid_stored_token() {
        let server = MockServer::start();
        let user_lookup = server.mock(|when, then| {
            when.method(GET)
                .path("/user")
                .header_exists("authorization")
                .header("accept", "application/vnd.github+json")
                .header("user-agent", GITHUB_USER_AGENT);
            then.status(401).json_body(json!({
                "message": "Bad credentials"
            }));
        });
        let token_store = MemoryGitHubTokenStore::with_token("gho_stale_token");

        let _ =
            github_auth_status_with(&reqwest::Client::new(), &test_config(&server), &token_store)
                .await
                .expect("invalid stored token should be removed before fallback status returns");

        assert_eq!(token_store.get(), None);
        user_lookup.assert();
    }

    #[tokio::test]
    async fn auth_status_preserves_stored_token_when_validation_is_indeterminate() {
        let server = MockServer::start();
        let user_lookup = server.mock(|when, then| {
            when.method(GET)
                .path("/user")
                .header_exists("authorization")
                .header("accept", "application/vnd.github+json")
                .header("user-agent", GITHUB_USER_AGENT);
            then.status(500).json_body(json!({
                "message": "GitHub is having a moment"
            }));
        });
        let token_store = MemoryGitHubTokenStore::with_token("gho_valid_but_unreachable");

        let error =
            github_auth_status_with(&reqwest::Client::new(), &test_config(&server), &token_store)
                .await
                .expect_err("indeterminate validation failure should surface without deleting");

        assert!(error.contains("GitHub account validation failed with HTTP 500"));
        assert_eq!(
            token_store.get().as_deref(),
            Some("gho_valid_but_unreachable")
        );
        user_lookup.assert();
    }
}
