//! Azure AI Speech synthesizer adapter.
//!
//! Ports the former frontend `narrationSpeech.ts` path (endpoint inference,
//! SSML construction, and the `tts/cognitiveservices/v1` POST) into the Rust
//! backend. All provider-native HTTP details are confined to this module and
//! never cross the [`super`] seam DTOs.

use async_trait::async_trait;

use super::{SpeechSynthesizer, SynthesisRequest, SynthesisResult, TtsCapabilities, AZURE_SPEECH_ID};

/// Entra scope for the Cognitive Services Speech API.
pub const SPEECH_TOKEN_SCOPE: &str = "https://cognitiveservices.azure.com/.default";

/// Synthesizer backed by Azure AI Speech (`tts/cognitiveservices/v1`).
pub struct AzureSpeechSynthesizer;

impl AzureSpeechSynthesizer {
    pub fn new() -> Self {
        Self
    }

    /// Honest capability metadata for this backend.
    pub fn static_capabilities() -> TtsCapabilities {
        TtsCapabilities {
            id: AZURE_SPEECH_ID.to_string(),
            display_name: "Azure AI Speech".to_string(),
            // `tts/cognitiveservices/v1` returns audio only — no word boundaries,
            // so this cannot drive teleprompter/FCPXML alignment. Advertised, not
            // faked.
            word_timestamps: false,
            ssml: true,
            streaming: false,
            offline: false,
        }
    }
}

/// Derive the `*.cognitiveservices.azure.com` speech host from a resource
/// endpoint, mirroring the former `inferSpeechEndpoint` in `narrationSpeech.ts`.
pub fn infer_speech_endpoint(endpoint: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(endpoint)
        .map_err(|e| format!("Invalid speech endpoint '{endpoint}': {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Could not infer Azure AI resource name from endpoint.".to_string())?;
    let resource = host
        .split('.')
        .next()
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| "Could not infer Azure AI resource name from endpoint.".to_string())?;
    Ok(format!(
        "{}://{resource}.cognitiveservices.azure.com",
        parsed.scheme()
    ))
}

fn escape_ssml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Build a minimal SSML document for a single voice, mirroring the former
/// `buildPlainSsml` in `narrationSpeech.ts`.
pub fn build_plain_ssml(text: &str, voice_name: &str) -> String {
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='{}'>{}</voice></speak>",
        voice_name,
        escape_ssml_text(text)
    )
}

#[async_trait]
impl SpeechSynthesizer for AzureSpeechSynthesizer {
    fn id(&self) -> &str {
        AZURE_SPEECH_ID
    }

    fn capabilities(&self) -> TtsCapabilities {
        Self::static_capabilities()
    }

    async fn synthesize(&self, request: SynthesisRequest) -> Result<SynthesisResult, String> {
        let speech_endpoint = infer_speech_endpoint(&request.connection.endpoint)?;
        let ssml = match request.ssml {
            Some(ref markup) if !markup.trim().is_empty() => markup.clone(),
            _ => build_plain_ssml(&request.text, &request.voice_name),
        };
        let url = format!("{speech_endpoint}/tts/cognitiveservices/v1");

        let auth_value = ["Bearer ", request.connection.access_token.as_str()].concat();
        let response = reqwest::Client::new()
            .post(&url)
            .header(reqwest::header::AUTHORIZATION, auth_value)
            .header(reqwest::header::CONTENT_TYPE, "application/ssml+xml")
            .header("X-Microsoft-OutputFormat", &request.output_format)
            .header(reqwest::header::USER_AGENT, "cutready")
            .body(ssml)
            .send()
            .await
            .map_err(|e| format!("Azure Speech request failed: {e}"))?;

        let status = response.status();
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("audio/x-wav")
            .to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read Azure Speech response: {e}"))?;

        if !status.is_success() {
            let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(500)]);
            let trimmed = preview.trim();
            return Err(if trimmed.is_empty() {
                format!("Azure Speech returned {status}")
            } else {
                trimmed.to_string()
            });
        }

        Ok(SynthesisResult {
            audio: bytes.to_vec(),
            mime_type,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_cognitive_services_host_from_resource_endpoint() {
        assert_eq!(
            infer_speech_endpoint("https://cutready-eastus.services.ai.azure.com").unwrap(),
            "https://cutready-eastus.cognitiveservices.azure.com"
        );
    }

    #[test]
    fn rejects_endpoints_without_a_resource_name() {
        assert!(infer_speech_endpoint("not-a-url").is_err());
    }

    #[test]
    fn escapes_ssml_special_characters() {
        let ssml = build_plain_ssml("Plan & ship <confidently>", "en-US-Harper:MAI-Voice-2");
        assert!(ssml.contains("Plan &amp; ship &lt;confidently&gt;"));
        assert!(ssml.contains("name='en-US-Harper:MAI-Voice-2'"));
    }
}
