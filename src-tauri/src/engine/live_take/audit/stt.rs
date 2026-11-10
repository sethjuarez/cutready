//! Transcribes the final take's audio with Azure AI Speech fast
//! transcription: a recognizer, independent of the TTS word boundaries the
//! planner used, that returns per-word times.

use super::align::SttWord;
use crate::engine::live_take::sidecar_io::SpeechAuth;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const STT_API_VERSION: &str = "2024-11-15";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub engine: String,
    pub words: Vec<SttWord>,
    /// `true` where a word starts a recognized phrase.
    pub phrase_first: Vec<bool>,
    pub text: String,
    pub audio_sha256: String,
    pub cached: bool,
    /// Wall time of the recognition request (0 when cached).
    pub request_ms: u128,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FastWord {
    text: String,
    offset_milliseconds: f64,
    duration_milliseconds: f64,
}

#[derive(Deserialize)]
struct FastPhrase {
    #[serde(default)]
    words: Vec<FastWord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FastResponse {
    #[serde(default)]
    phrases: Vec<FastPhrase>,
    #[serde(default)]
    combined_phrases: Vec<serde_json::Value>,
}

/// Parses a fast-transcription response into words.
pub fn parse_fast(body: &str) -> Result<(Vec<SttWord>, Vec<bool>, String)> {
    let r: FastResponse = serde_json::from_str(body).context("parse transcription")?;
    let mut words = Vec::new();
    let mut first = Vec::new();
    for p in r.phrases {
        for (i, w) in p.words.into_iter().enumerate() {
            first.push(i == 0);
            words.push(SttWord {
                text: w.text,
                start_ms: w.offset_milliseconds,
                duration_ms: w.duration_milliseconds,
            });
        }
    }
    let text = r
        .combined_phrases
        .first()
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    Ok((words, first, text))
}

fn multipart(boundary: &str, wav: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; \
             filename=\"take.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(wav);
    body.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"definition\"\r\n\
             Content-Type: application/json\r\n\r\n{{\"locales\":[\"en-US\"]}}\r\n--{boundary}--\r\n"
        )
        .as_bytes(),
    );
    body
}

/// Transcribes `wav`, reusing `<cache_dir>/<sha256>.json` when present.
pub async fn transcribe(
    wav: &[u8],
    auth: &SpeechAuth,
    cache_dir: &Path,
) -> Result<(Transcript, String)> {
    let sha = format!("{:x}", Sha256::digest(wav));
    let cache: PathBuf = cache_dir.join(format!("{sha}.json"));
    let (body, cached, request_ms) = if let Ok(body) = std::fs::read_to_string(&cache) {
        (body, true, 0)
    } else {
        let token = auth
            .token
            .as_deref()
            .ok_or_else(|| anyhow!("speech-to-text needs SPEECH_TOKEN (or run with --no-stt)"))?;
        if auth.endpoint.is_empty() {
            bail!("speech-to-text needs SPEECH_ENDPOINT (or run with --no-stt)");
        }
        let url = format!(
            "{}/speechtotext/transcriptions:transcribe?api-version={STT_API_VERSION}",
            auth.endpoint.trim_end_matches('/')
        );
        let boundary = format!("cutready-{}", &sha[..16]);
        let started = std::time::Instant::now();
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth(token)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart(&boundary, wav))
            .send()
            .await
            .context("speech-to-text request")?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            let head: String = body.chars().take(300).collect();
            bail!("speech-to-text returned {status}: {head}");
        }
        std::fs::create_dir_all(cache_dir)?;
        std::fs::write(&cache, &body)?;
        (body, false, started.elapsed().as_millis())
    };
    let (words, phrase_first, text) = parse_fast(&body)?;
    Ok((
        Transcript {
            engine: format!("azure-fast-transcription/{STT_API_VERSION}"),
            words,
            phrase_first,
            text,
            audio_sha256: sha,
            cached,
            request_ms,
        },
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_words_and_phrase_starts() {
        let body = r#"{"durationMilliseconds":2000,
            "combinedPhrases":[{"text":"Open it. Now type."}],
            "phrases":[
              {"offsetMilliseconds":100,"words":[
                {"text":"Open","offsetMilliseconds":100,"durationMilliseconds":200},
                {"text":"it.","offsetMilliseconds":320,"durationMilliseconds":120}]},
              {"offsetMilliseconds":900,"words":[
                {"text":"Now","offsetMilliseconds":900,"durationMilliseconds":150}]}]}"#;
        let (w, first, text) = parse_fast(body).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(first, vec![true, false, true]);
        assert_eq!(w[1].start_ms, 320.0);
        assert_eq!(text, "Open it. Now type.");
    }

    #[test]
    fn multipart_has_both_parts() {
        let body = String::from_utf8_lossy(&multipart("b", b"RIFF")).to_string();
        assert!(body.starts_with("--b\r\n"));
        assert!(body.contains("name=\"audio\""));
        assert!(body.contains("{\"locales\":[\"en-US\"]}"));
        assert!(body.ends_with("--b--\r\n"));
    }
}
