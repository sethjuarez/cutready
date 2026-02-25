//! Playwright sidecar process manager.
//!
//! Manages a Node.js child process that drives Playwright for browser
//! observation during interaction recording. Communication happens via
//! newline-delimited JSON over stdin/stdout.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::models::session::CapturedAction;

// ── Protocol Types ──────────────────────────────────────────────────────────

/// A request sent to the Playwright sidecar.
#[derive(Debug, Serialize)]
struct SidecarRequest {
    id: u64,
    method: String,
    params: serde_json::Value,
}

/// A response message from the sidecar.
#[derive(Debug, Deserialize)]
struct SidecarResponse {
    id: u64,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<SidecarErrorDetail>,
}

/// An event message from the sidecar (unsolicited, no request ID).
#[derive(Debug, Deserialize)]
struct SidecarEvent {
    event: String,
    data: serde_json::Value,
}

/// Error detail in a sidecar response.
#[derive(Debug, Deserialize)]
struct SidecarErrorDetail {
    message: String,
}

/// Map of pending request IDs to their response channels.
type PendingMap = HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>;

// ── SidecarManager ──────────────────────────────────────────────────────────

/// Manages the Playwright Node.js sidecar process.
///
/// Provides request-response communication (with ID correlation) and
/// streams captured action events from the browser observer.
pub struct SidecarManager {
    child: Mutex<Child>,
    stdin: Mutex<BufWriter<ChildStdin>>,
    next_id: Mutex<u64>,
    pending: Arc<Mutex<PendingMap>>,
    _reader_handle: JoinHandle<()>,
}

impl SidecarManager {
    /// Spawn the Playwright sidecar process.
    ///
    /// Returns the manager and a receiver for captured action events.
    /// The receiver yields `CapturedAction` objects as the user interacts
    /// with the browser.
    pub async fn spawn(
        sidecar_dir: &Path,
    ) -> anyhow::Result<(Self, mpsc::UnboundedReceiver<CapturedAction>)> {
        let mut child = Command::new("node")
            .arg("index.js")
            .current_dir(sidecar_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().expect("stdin not captured");
        let stdout = child.stdout.take().expect("stdout not captured");

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));

        let reader_pending = pending.clone();
        let reader_handle = tokio::spawn(async move {
            Self::reader_loop(stdout, reader_pending, event_tx).await;
        });

        let manager = Self {
            child: Mutex::new(child),
            stdin: Mutex::new(BufWriter::new(stdin)),
            next_id: Mutex::new(1),
            pending,
            _reader_handle: reader_handle,
        };

        Ok((manager, event_rx))
    }

    /// Background task that reads the sidecar's stdout and routes messages.
    ///
    /// Responses (with `id`) are dispatched to pending request channels.
    /// Events (with `event`) are forwarded to the event sender.
    async fn reader_loop(
        stdout: ChildStdout,
        pending: Arc<Mutex<PendingMap>>,
        event_tx: mpsc::UnboundedSender<CapturedAction>,
    ) {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }

            // Parse as generic JSON first, then dispatch by shape
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("Failed to parse sidecar JSON: {e}");
                    tracing::debug!("Raw line: {line}");
                    continue;
                }
            };

            if value.get("event").is_some() {
                // Event message
                match serde_json::from_value::<SidecarEvent>(value) {
                    Ok(evt) if evt.event == "action_captured" => {
                        match serde_json::from_value::<CapturedAction>(evt.data) {
                            Ok(action) => {
                                let _ = event_tx.send(action);
                            }
                            Err(e) => {
                                tracing::warn!("Failed to parse CapturedAction: {e}");
                            }
                        }
                    }
                    Ok(evt) => {
                        tracing::debug!("Unknown sidecar event: {}", evt.event);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse sidecar event: {e}");
                    }
                }
            } else if value.get("id").is_some() {
                // Response message
                match serde_json::from_value::<SidecarResponse>(value) {
                    Ok(resp) => {
                        let mut map = pending.lock().await;
                        if let Some(tx) = map.remove(&resp.id) {
                            let result = if let Some(err) = resp.error {
                                Err(err.message)
                            } else {
                                Ok(resp.result.unwrap_or(serde_json::Value::Null))
                            };
                            let _ = tx.send(result);
                        } else {
                            tracing::warn!("Received response for unknown request id: {}", resp.id);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse sidecar response: {e}");
                    }
                }
            } else {
                tracing::debug!("Unrecognized sidecar message: {line}");
            }
        }

        tracing::info!("Sidecar stdout reader ended");
    }

    /// Send a request to the sidecar and wait for the response.
    ///
    /// Times out after 30 seconds.
    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = {
            let mut next = self.next_id.lock().await;
            let current = *next;
            *next += 1;
            current
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().await;
            map.insert(id, tx);
        }

        let request = SidecarRequest {
            id,
            method: method.to_string(),
            params,
        };

        let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to sidecar stdin: {e}"))?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write newline: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush sidecar stdin: {e}"))?;
        }

        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Sidecar response channel dropped".to_string()),
            Err(_) => {
                // Remove the pending entry on timeout
                let mut map = self.pending.lock().await;
                map.remove(&id);
                Err("Sidecar request timed out after 30s".to_string())
            }
        }
    }

    /// Send a ping and verify the sidecar is responsive.
    pub async fn ping(&self) -> Result<(), String> {
        let result = self.request("ping", serde_json::json!({})).await?;
        if result.get("status").and_then(|s| s.as_str()) == Some("pong") {
            Ok(())
        } else {
            Err(format!("Unexpected ping response: {result}"))
        }
    }

    /// Shut down the sidecar process.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_request_serialization() {
        let req = SidecarRequest {
            id: 1,
            method: "ping".to_string(),
            params: serde_json::json!({}),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"method\":\"ping\""));
    }

    #[test]
    fn sidecar_response_deserialization() {
        let json = r#"{"id":1,"result":{"status":"pong"}}"#;
        let resp: SidecarResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, 1);
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn sidecar_error_response_deserialization() {
        let json = r#"{"id":2,"error":{"message":"Browser already launched"}}"#;
        let resp: SidecarResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, 2);
        assert!(resp.result.is_none());
        assert_eq!(resp.error.unwrap().message, "Browser already launched");
    }

    #[test]
    fn sidecar_event_deserialization() {
        let json = r##"{"event":"action_captured","data":{"action":{"type":"BrowserClick","selectors":[{"strategy":"CssSelector","value":"#btn"}]},"metadata":{"captured_screenshot":null,"selector_strategies":[],"timestamp_ms":1000,"confidence":0.85,"context_snapshot":null},"raw_event":null}}"##;
        let evt: SidecarEvent = serde_json::from_str(json).unwrap();
        assert_eq!(evt.event, "action_captured");

        let action: CapturedAction = serde_json::from_value(evt.data).unwrap();
        assert!(matches!(
            action.action,
            crate::models::action::Action::BrowserClick { .. }
        ));
    }

    #[test]
    fn dispatch_by_json_shape() {
        // Response has "id"
        let response_json = r#"{"id":5,"result":{"status":"ok"}}"#;
        let val: serde_json::Value = serde_json::from_str(response_json).unwrap();
        assert!(val.get("id").is_some());
        assert!(val.get("event").is_none());

        // Event has "event"
        let event_json = r#"{"event":"action_captured","data":{}}"#;
        let val: serde_json::Value = serde_json::from_str(event_json).unwrap();
        assert!(val.get("event").is_some());
    }
}
