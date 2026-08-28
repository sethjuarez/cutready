use tauri::Manager;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::narration_preview;
use crate::engine::speech::azure_speech::SPEECH_TOKEN_SCOPE;
use crate::engine::speech::{SynthesisRequest, TtsConnection, TtsRegistry};
use prompty_foundry::oauth;

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))
}

#[auditaur_command(skip_all, err)]
pub fn get_narration_voice_preview(
    voice_name: String,
    output_format: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    narration_preview::cached_voice_preview(&app_data_dir(&app)?, &voice_name, &output_format)
        .map_err(|e| e.to_string())
}

#[auditaur_command(skip_all, err)]
pub fn save_narration_voice_preview(
    voice_name: String,
    output_format: String,
    audio_data: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    narration_preview::save_voice_preview(
        &app_data_dir(&app)?,
        &voice_name,
        &output_format,
        &audio_data,
    )
    .map_err(|e| e.to_string())
}

/// Request to synthesize (and cache) a narration voice preview entirely in the
/// backend.
///
/// Moving synthesis behind the [`crate::engine::speech`] seam means the audio
/// bytes never cross the IPC boundary, the Entra token is refreshed server-side,
/// and cache-check + refresh + synthesis + disk write collapse into one command
/// (issue #256).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationVoicePreviewRequest {
    voice_name: String,
    output_format: String,
    text: String,
    endpoint: String,
    #[serde(default)]
    tenant_id: String,
    client_id: Option<String>,
    refresh_token: String,
    #[serde(default)]
    force: bool,
    /// Optional synthesizer id; defaults to the registry default when omitted.
    synthesizer_id: Option<String>,
}

/// Result of a backend voice-preview synthesis.
///
/// `access_token`/`refresh_token` are returned only when a fresh token was
/// obtained (i.e. on a cache miss) so the frontend can persist rotated
/// credentials; token *storage* stays a frontend concern (settings/secret
/// store), while the network work moves to the backend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationVoicePreviewResult {
    path: String,
    generated: bool,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

#[auditaur_command(skip_all, err)]
pub async fn synthesize_narration_voice_preview(
    request: NarrationVoicePreviewRequest,
    app: tauri::AppHandle,
) -> Result<NarrationVoicePreviewResult, String> {
    let dir = app_data_dir(&app)?;

    if !request.force {
        if let Some(path) =
            narration_preview::cached_voice_preview(&dir, &request.voice_name, &request.output_format)
                .map_err(|e| e.to_string())?
        {
            return Ok(NarrationVoicePreviewResult {
                path,
                generated: false,
                access_token: None,
                refresh_token: None,
            });
        }
    }

    let tenant = if request.tenant_id.trim().is_empty() {
        "organizations"
    } else {
        request.tenant_id.trim()
    };
    let token = oauth::refresh_token(
        tenant,
        &request.refresh_token,
        request.client_id.as_deref(),
        Some(SPEECH_TOKEN_SCOPE),
    )
    .await?;
    if token.access_token.is_empty() {
        return Err("Azure Speech token refresh did not return an access token.".to_string());
    }

    let synthesizer = TtsRegistry::resolve(request.synthesizer_id.as_deref())?;
    let result = synthesizer
        .synthesize(SynthesisRequest {
            text: request.text,
            voice_name: request.voice_name.clone(),
            output_format: request.output_format.clone(),
            connection: TtsConnection {
                endpoint: request.endpoint,
                access_token: token.access_token.clone(),
            },
        })
        .await?;

    let path = narration_preview::save_voice_preview(
        &dir,
        &request.voice_name,
        &request.output_format,
        &result.audio,
    )
    .map_err(|e| e.to_string())?;

    Ok(NarrationVoicePreviewResult {
        path,
        generated: true,
        access_token: Some(token.access_token),
        refresh_token: token.refresh_token,
    })
}
