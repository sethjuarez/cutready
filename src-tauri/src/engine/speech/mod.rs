//! CutReady-owned speech-synthesis (TTS) capability seam.
//!
//! A *speech synthesizer* is the pluggable runtime that turns narration text
//! into audio. This is the first capability provider beyond the agent harness
//! (issue #256, epic #250): it mirrors the `AgentHarness` seam so the same
//! discipline applies. CutReady owns the host boundary around synthesis — the
//! request/result DTOs, honest capability metadata, credentials, and
//! **artifact placement** all live on this side of the seam and never change
//! when the synthesizer implementation changes.
//!
//! Provider-native details (HTTP endpoints, request bodies, SDK types) must
//! stay inside the concrete adapter for that provider. Nothing provider-specific
//! may appear in this module or leak past [`SpeechSynthesizer::synthesize`].
//!
//! Adapters return audio *bytes*; the **host** decides where they land (under
//! path confinement / project-owned placement), so an adapter never writes to
//! disk itself. This is the capability analogue of the harness rule that the
//! host owns persistence policy.

pub mod azure_speech;

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;

use self::azure_speech::AzureSpeechSynthesizer;

// ---------------------------------------------------------------------------
// Stable host boundary types (CutReady-owned)
// ---------------------------------------------------------------------------

/// Connection + auth a synthesizer needs for one request.
///
/// Host-owned; the adapter translates it into provider-native calls behind the
/// seam. The access token is already scoped for the provider's speech API — the
/// host refreshes credentials, the adapter never touches OAuth.
#[derive(Debug, Clone)]
pub struct TtsConnection {
    /// Provider resource endpoint (for example the Foundry/Azure endpoint URL).
    pub endpoint: String,
    /// Entra access token already scoped for the provider's speech API.
    pub access_token: String,
}

/// Everything a synthesizer needs to render one clip. All CutReady-owned types.
#[derive(Debug, Clone)]
pub struct SynthesisRequest {
    /// Plain narration text to speak (adapters build any SSML themselves).
    pub text: String,
    /// Provider voice identifier (for example `en-US-Harper:MAI-Voice-2`).
    pub voice_name: String,
    /// Provider output-format token (for example `riff-24khz-16bit-mono-pcm`).
    pub output_format: String,
    /// Connection/auth for this request.
    pub connection: TtsConnection,
}

/// Rendered audio in host terms.
///
/// The adapter returns bytes; the *host* decides where they land, so no adapter
/// ever writes to disk. This is what lets synthesis run entirely backend-side
/// without marshaling audio across the IPC boundary.
#[derive(Debug, Clone)]
pub struct SynthesisResult {
    /// Raw synthesized audio bytes.
    pub audio: Vec<u8>,
    /// MIME type reported by the provider (best-effort).
    pub mime_type: String,
}

/// Declarative, honest capability metadata for a synthesizer.
///
/// Differences are represented explicitly rather than silently downgraded — a
/// backend that cannot emit word-level timestamps advertises
/// `word_timestamps = false` instead of faking teleprompter/FCPXML alignment.
/// This is the same discipline `HarnessCapabilities` holds for the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TtsCapabilities {
    /// Canonical synthesizer identifier (matches [`SpeechSynthesizer::id`]).
    pub id: String,
    /// Human-readable name for settings/diagnostics surfaces.
    pub display_name: String,
    /// Emits word-level timestamps (required to drive teleprompter pacing and
    /// FCPXML markers). Advertised, never faked.
    pub word_timestamps: bool,
    /// Accepts SSML input.
    pub ssml: bool,
    /// Streams audio incrementally while synthesizing.
    pub streaming: bool,
    /// Runs without a network connection.
    pub offline: bool,
}

/// A pluggable text-to-speech runtime behind the CutReady host boundary.
#[async_trait]
pub trait SpeechSynthesizer: Send + Sync {
    /// Canonical, stable identifier for this synthesizer.
    fn id(&self) -> &str;

    /// Capability metadata describing what this synthesizer supports.
    fn capabilities(&self) -> TtsCapabilities;

    /// Render one clip, returning audio bytes for the host to place.
    async fn synthesize(&self, request: SynthesisRequest) -> Result<SynthesisResult, String>;
}

// ---------------------------------------------------------------------------
// Registry / factory
// ---------------------------------------------------------------------------

/// Canonical id of the Azure AI Speech synthesizer (the first adapter).
pub const AZURE_SPEECH_ID: &str = "azure-speech";

/// Synthesizer selected when the host requests no specific one.
#[allow(dead_code)]
pub const DEFAULT_TTS_ID: &str = AZURE_SPEECH_ID;

/// Resolves synthesizer identifiers to concrete [`SpeechSynthesizer`] instances.
///
/// This is the single place synthesizer selection happens; hosts must not branch
/// on synthesizer ids themselves. New adapters register a new arm here — exactly
/// like `HarnessRegistry`.
pub struct TtsRegistry;

impl TtsRegistry {
    /// Map a requested synthesizer id (or `None`) to a canonical id, rejecting
    /// unknown ids with a clear message.
    pub fn canonical_id(requested: Option<&str>) -> Result<&'static str, String> {
        match requested.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some(AZURE_SPEECH_ID) => Ok(AZURE_SPEECH_ID),
            Some(other) => Err(unsupported_synthesizer_error(other)),
        }
    }

    /// Resolve a requested synthesizer id to a ready-to-use instance.
    pub fn resolve(requested: Option<&str>) -> Result<Arc<dyn SpeechSynthesizer>, String> {
        match Self::canonical_id(requested)? {
            AZURE_SPEECH_ID => Ok(Arc::new(AzureSpeechSynthesizer::new())),
            other => Err(unsupported_synthesizer_error(other)),
        }
    }

    /// Report capability metadata for a requested synthesizer id without building
    /// it. Consumed by conformance tests and diagnostics surfaces.
    #[allow(dead_code)]
    pub fn capabilities(requested: Option<&str>) -> Result<TtsCapabilities, String> {
        match Self::canonical_id(requested)? {
            AZURE_SPEECH_ID => Ok(AzureSpeechSynthesizer::static_capabilities()),
            other => Err(unsupported_synthesizer_error(other)),
        }
    }

    /// Enumerate every known synthesizer with its capabilities.
    #[allow(dead_code)]
    pub fn available() -> Vec<TtsCapabilities> {
        vec![AzureSpeechSynthesizer::static_capabilities()]
    }
}

fn unsupported_synthesizer_error(id: &str) -> String {
    format!("Unsupported speech synthesizer '{id}'. Known synthesizers: {AZURE_SPEECH_ID}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_resolves_to_azure_speech() {
        assert_eq!(TtsRegistry::canonical_id(None).unwrap(), AZURE_SPEECH_ID);
        assert_eq!(TtsRegistry::canonical_id(Some("   ")).unwrap(), AZURE_SPEECH_ID);
        assert_eq!(TtsRegistry::resolve(None).unwrap().id(), AZURE_SPEECH_ID);
    }

    #[test]
    fn unknown_synthesizer_is_reported_clearly() {
        let err = TtsRegistry::canonical_id(Some("totally-unknown")).unwrap_err();
        assert!(err.contains("totally-unknown"));
        assert!(err.contains(AZURE_SPEECH_ID));
        assert!(TtsRegistry::resolve(Some("totally-unknown")).is_err());
    }

    #[test]
    fn azure_speech_advertises_honest_capabilities() {
        let caps = TtsRegistry::capabilities(Some(AZURE_SPEECH_ID)).unwrap();
        assert_eq!(caps.id, AZURE_SPEECH_ID);
        // tts/cognitiveservices/v1 returns audio only — no word boundaries. This
        // must stay false so callers never assume teleprompter alignment.
        assert!(!caps.word_timestamps);
        assert!(caps.ssml);
        assert!(!caps.offline);
    }

    #[test]
    fn available_lists_every_known_synthesizer() {
        let ids: Vec<_> = TtsRegistry::available().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec![AZURE_SPEECH_ID.to_string()]);
    }
}
