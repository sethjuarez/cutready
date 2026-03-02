//! Azure Entra ID OAuth for keyless Azure OpenAI authentication.
//!
//! Primary: Authorization Code flow with PKCE (browser-based, works with Conditional Access).
//! Fallback: Device code flow (for headless environments).

use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

const AZURE_OPENAI_SCOPE: &str = "https://cognitiveservices.azure.com/.default offline_access";

/// VS Code client ID — first-party, pre-consented in virtually all Azure AD tenants.
const DEFAULT_CLIENT_ID: &str = "aebc6443-996d-45c2-90f0-388ff96faa56";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

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

/// Returned to the frontend so it can open the browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthCodeFlowInit {
    /// The full authorization URL to open in the browser.
    pub auth_url: String,
    /// The localhost port the callback server is listening on.
    pub port: u16,
}

// ---------------------------------------------------------------------------
// Authorization Code + PKCE flow  (browser-based)
// ---------------------------------------------------------------------------

/// Generate a cryptographic random code_verifier (43-128 chars, unreserved URI chars).
fn generate_code_verifier() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::rng();
    (0..64)
        .map(|_| {
            let idx = rng.random_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// Derive the S256 code_challenge from a code_verifier.
fn code_challenge(verifier: &str) -> String {
    use base64::Engine;
    let hash = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

/// Start a localhost HTTP server that waits for the OAuth redirect callback.
/// Returns (auth_url, code_verifier, port). The caller should:
///   1. Open `auth_url` in the browser
///   2. Call `wait_for_auth_code(port, ...)` to get the authorization code
pub async fn start_auth_code_flow(
    tenant_id: &str,
    client_id: Option<&str>,
) -> Result<(AuthCodeFlowInit, String), String> {
    let cid = client_id.unwrap_or(DEFAULT_CLIENT_ID);

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind localhost listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {e}"))?
        .port();

    let redirect_uri = format!("http://localhost:{port}");
    let verifier = generate_code_verifier();
    let challenge = code_challenge(&verifier);

    let auth_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/authorize?\
         client_id={}&response_type=code&redirect_uri={}&scope={}&\
         code_challenge={}&code_challenge_method=S256&prompt=select_account",
        tenant_id,
        cid,
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(AZURE_OPENAI_SCOPE),
        challenge,
    );

    // Keep the listener alive by leaking it into a shared handle
    // that wait_for_auth_code will consume.
    let init = AuthCodeFlowInit {
        auth_url,
        port,
    };

    // We need to keep the listener alive. Store it in a global map keyed by port.
    {
        let mut map = pending_listeners().lock().await;
        map.insert(port, listener);
    }

    Ok((init, verifier))
}

/// Global map of pending TCP listeners keyed by port.
fn pending_listeners() -> &'static tokio::sync::Mutex<std::collections::HashMap<u16, TcpListener>> {
    static INSTANCE: std::sync::OnceLock<tokio::sync::Mutex<std::collections::HashMap<u16, TcpListener>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Wait for the browser to redirect back to our localhost server.
/// Extracts the authorization code from the query string and returns it.
/// Responds with a success page so the user sees confirmation in the browser.
pub async fn wait_for_auth_code(port: u16, timeout_secs: u64) -> Result<String, String> {
    let listener = {
        let mut map = pending_listeners().lock().await;
        map.remove(&port)
            .ok_or_else(|| format!("No pending listener on port {port}"))?
    };

    let accept_fut = listener.accept();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    let (mut stream, _addr): (tokio::net::TcpStream, _) = tokio::time::timeout(timeout, accept_fut)
        .await
        .map_err(|_| "Timed out waiting for browser redirect".to_string())?
        .map_err(|e| format!("Accept failed: {e}"))?;

    // Read the HTTP request
    let mut buf = vec![0u8; 4096];
    let n = tokio::io::AsyncReadExt::read(&mut stream, &mut buf)
        .await
        .map_err(|e| format!("Failed to read request: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Extract the code from "GET /?code=...&... HTTP/1.1"
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    // Check for error
    if path.contains("error=") {
        let error_desc = extract_query_param(path, "error_description")
            .unwrap_or_else(|| extract_query_param(path, "error").unwrap_or_default());
        let error_page = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
<!DOCTYPE html>\
<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>CutReady — Sign-in Failed</title>\
<style>\
  *{{margin:0;padding:0;box-sizing:border-box}}\
  body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\
    display:flex;align-items:center;justify-content:center;min-height:100vh;\
    background:#f8f9fa;color:#1a1a1a}}\
  @media(prefers-color-scheme:dark){{body{{background:#1a1a1a;color:#e8e8e8}}}}\
  .card{{text-align:center;padding:48px 40px;max-width:420px;\
    background:#fff;border-radius:16px;box-shadow:0 2px 24px rgba(0,0,0,.08)}}\
  @media(prefers-color-scheme:dark){{.card{{background:#2a2a2a;box-shadow:0 2px 24px rgba(0,0,0,.3)}}}}\
  .icon{{font-size:48px;margin-bottom:16px}}\
  h1{{font-size:20px;font-weight:600;margin-bottom:8px}}\
  p{{font-size:14px;opacity:.7;line-height:1.5}}\
  .detail{{margin-top:12px;font-size:12px;opacity:.5;word-break:break-word}}\
  .fade{{animation:fadeIn .4s ease}}\
  @keyframes fadeIn{{from{{opacity:0;transform:translateY(8px)}}to{{opacity:1;transform:none}}}}\
</style></head>\
<body><div class=\"card fade\">\
  <div class=\"icon\">❌</div>\
  <h1>Sign-in failed</h1>\
  <p>Something went wrong during authentication.</p>\
  <p class=\"detail\">{}</p>\
</div></body></html>",
            error_desc
        );
        let _ = stream.write_all(error_page.as_bytes()).await;
        let _ = stream.shutdown().await;
        return Err(format!("Auth error: {}", error_desc));
    }

    let code = extract_query_param(path, "code")
        .ok_or_else(|| format!("No authorization code in redirect: {path}"))?;

    // Send a polished success page
    let success_page = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
<!DOCTYPE html>\
<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>CutReady — Signed In</title>\
<style>\
  *{margin:0;padding:0;box-sizing:border-box}\
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\
    display:flex;align-items:center;justify-content:center;min-height:100vh;\
    background:#f8f9fa;color:#1a1a1a}\
  @media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e8e8e8}}\
  .card{text-align:center;padding:48px 40px;max-width:420px;\
    background:#fff;border-radius:16px;box-shadow:0 2px 24px rgba(0,0,0,.08)}\
  @media(prefers-color-scheme:dark){.card{background:#2a2a2a;box-shadow:0 2px 24px rgba(0,0,0,.3)}}\
  .icon{font-size:48px;margin-bottom:16px}\
  h1{font-size:20px;font-weight:600;margin-bottom:8px}\
  p{font-size:14px;opacity:.7;line-height:1.5}\
  .fade{animation:fadeIn .4s ease}\
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}\
</style></head>\
<body><div class=\"card fade\">\
  <div class=\"icon\">✅</div>\
  <h1>Signed in to CutReady</h1>\
  <p>You can close this tab and return to the app.</p>\
</div>\
<script>setTimeout(()=>window.close(),3000)</script>\
</body></html>";
    let _ = stream.write_all(success_page.as_bytes()).await;
    let _ = stream.shutdown().await;

    Ok(code)
}

/// Exchange an authorization code for tokens.
pub async fn exchange_code_for_token(
    tenant_id: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
    client_id: Option<&str>,
) -> Result<TokenResponse, String> {
    let cid = client_id.unwrap_or(DEFAULT_CLIENT_ID);
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    );

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .form(&[
            ("client_id", cid),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", code_verifier),
            ("scope", AZURE_OPENAI_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange error: {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))
}

/// Extract a query parameter value from a URL path like "/?code=abc&state=xyz".
fn extract_query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == key {
            let val = kv.next().unwrap_or("");
            return Some(urlencoding::decode(val).unwrap_or_default().into_owned());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Refresh token (shared between flows)
// ---------------------------------------------------------------------------

/// Refresh an access token using a refresh token.
pub async fn refresh_token(
    tenant_id: &str,
    refresh_token: &str,
    client_id: Option<&str>,
) -> Result<TokenResponse, String> {
    let cid = client_id.unwrap_or(DEFAULT_CLIENT_ID);
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    );

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .form(&[
            ("client_id", cid),
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

// ---------------------------------------------------------------------------
// Device Code flow (fallback)
// ---------------------------------------------------------------------------

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

/// Error during token polling.
#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    error: String,
    #[allow(dead_code)]
    error_description: Option<String>,
}

/// Request a device code from Azure Entra ID.
pub async fn request_device_code(
    tenant_id: &str,
    client_id: Option<&str>,
) -> Result<DeviceCodeResponse, String> {
    let cid = client_id.unwrap_or(DEFAULT_CLIENT_ID);
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
        tenant_id
    );

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .form(&[("client_id", cid), ("scope", AZURE_OPENAI_SCOPE)])
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
pub async fn poll_for_token(
    tenant_id: &str,
    device_code: &str,
    interval_secs: u64,
    timeout_secs: u64,
    client_id: Option<&str>,
) -> Result<TokenResponse, String> {
    let cid = client_id.unwrap_or(DEFAULT_CLIENT_ID);
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    );

    let http = reqwest::Client::new();
    let interval = std::time::Duration::from_secs(interval_secs.max(5));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        if std::time::Instant::now() > deadline {
            return Err("Device code flow timed out".into());
        }
        tokio::time::sleep(interval).await;

        let resp = http
            .post(&url)
            .form(&[
                ("client_id", cid),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device_code),
            ])
            .send()
            .await
            .map_err(|e| format!("Token poll failed: {e}"))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("Read error: {e}"))?;

        if status.is_success() {
            return serde_json::from_str(&body)
                .map_err(|e| format!("Failed to parse token: {e}"));
        }

        if let Ok(err) = serde_json::from_str::<TokenErrorResponse>(&body) {
            match err.error.as_str() {
                "authorization_pending" => continue,
                "slow_down" => {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
                "expired_token" => return Err("Device code expired".into()),
                other => return Err(format!("Token error: {other}")),
            }
        }
        return Err(format!("Unexpected response ({status}): {body}"));
    }
}
