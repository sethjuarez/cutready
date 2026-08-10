use serde::Serialize;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::narration_speech;

#[derive(Serialize)]
pub struct SpeechSynthesisResult {
    audio_data: Vec<u8>,
    mime_type: String,
}

#[derive(Serialize)]
pub struct SsmlValidationResult {
    valid: bool,
    errors: Vec<String>,
}

#[auditaur_command(skip_all, err)]
pub fn validate_narration_ssml(
    ssml: String,
    voice: String,
) -> Result<SsmlValidationResult, String> {
    let validation = narration_speech::validate_ssml(&ssml, &voice);
    Ok(SsmlValidationResult {
        valid: validation.is_valid(),
        errors: validation.errors,
    })
}

#[auditaur_command(skip_all, err)]
pub async fn synthesize_speech_audio(
    access_token: String,
    speech_endpoint: String,
    voice: String,
    ssml: String,
    output_format: String,
) -> Result<SpeechSynthesisResult, String> {
    let audio = narration_speech::synthesize_speech_audio(
        &access_token,
        &speech_endpoint,
        &voice,
        &ssml,
        &output_format,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(SpeechSynthesisResult {
        audio_data: audio.audio_data,
        mime_type: audio.mime_type,
    })
}
