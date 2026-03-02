//! Azure Entra ID device code flow for keyless Azure OpenAI authentication.
//!
//! Flow: app requests a device code → user visits URL and enters code →
//! app polls for token → receives access_token + refresh_token.

use serde::{Deserialize, Serialize};

const AZURE_OPENAI_SCOPE: &str = "https://cognitiveservices.azure.com/.default offline_access";

/// Default client ID for Azure CLI (public client, works without app registration).
const AZURE_CLI_CLIENT_ID: &str = "04b07795-a710-4532-9dff-59ee8e8e6d36";

/// Initial response from the device code endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

/// Token response from the token endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

/// Error during token polling (expected while user hasn't completed auth).
#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    error: String,
    #[allow(dead_code)]
    error_description: Option<String>,
}

/// Request a device code from Azure Entra ID.
pub async fn request_device_code(
    tenant_id: &str,
) -> Result<DeviceCodeResponse, String> {
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
        tenant_id
    );

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .form(&[
            ("client_id", AZURE_CLI_CLIENT_ID),
            ("scope", AZURE_OPENAI_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("Device code request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Device code endpoint error: {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse device code response: {e}"))
}

/// Poll the token endpoint until the user completes authentication.
/// Returns Ok(token) on success, Err on timeout/failure.
pub async fn poll_for_token(
    tenant_id: &str,
    device_code: &str,
    interval_secs: u64,
    timeout_secs: u64,
) -> Result<TokenResponse, String> {
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    );

    let http = reqwest::Client::new();
    let interval = std::time::Duration::from_secs(interval_secs.max(5));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        if std::time::Instant::now() > deadline {
            return Err("Device code flow timed out — user did not complete sign-in".into());
        }

        tokio::time::sleep(interval).await;

        let resp = http
            .post(&url)
            .form(&[
                ("client_id", AZURE_CLI_CLIENT_ID),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device_code),
            ])
            .send()
            .await
            .map_err(|e| format!("Token poll failed: {e}"))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read token response: {e}"))?;

        if status.is_success() {
            let token: TokenResponse = serde_json::from_str(&body)
                .map_err(|e| format!("Failed to parse token: {e}"))?;
            return Ok(token);
        }

        // Check if the error is "authorization_pending" (expected — keep polling)
        if let Ok(err) = serde_json::from_str::<TokenErrorResponse>(&body) {
            match err.error.as_str() {
                "authorization_pending" => continue,
                "slow_down" => {
                    // Wait extra before retrying
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
                "expired_token" => return Err("Device code expired before sign-in completed".into()),
                other => return Err(format!("Token error: {other}")),
            }
        }

        return Err(format!("Unexpected token response ({status}): {body}"));
    }
}

/// Refresh an access token using a refresh token.
pub async fn refresh_token(
    tenant_id: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    );

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .form(&[
            ("client_id", AZURE_CLI_CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", AZURE_OPENAI_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token refresh error: {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {e}"))
}
