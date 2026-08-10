use std::time::Duration;

use quick_xml::{events::BytesStart, Reader};
use reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
    Url,
};

const SPEECH_PATH: &str = "/tts/cognitiveservices/v1";
const MAX_ERROR_BYTES: usize = 500;
const DISALLOWED_ELEMENTS: &[&str] = &[
    "audio",
    "lexicon",
    "bookmark",
    "backgroundaudio",
    "viseme",
    "voiceconversion",
    "ttsembedding",
];
const MAI_ALLOWED_ELEMENTS: &[&str] = &["speak", "voice", "sub", "say-as", "s", "lang", "break"];
const DRAGON_HD_ALLOWED_ELEMENTS: &[&str] = &[
    "speak", "voice", "lang", "phoneme", "say-as", "sub", "break", "p", "s",
];
const DRAGON_HD_OMNI_ALLOWED_ELEMENTS: &[&str] = &[
    "speak",
    "voice",
    "express-as",
    "lang",
    "say-as",
    "sub",
    "p",
    "s",
];

#[derive(Debug)]
pub struct SpeechAudio {
    pub audio_data: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug)]
pub struct SsmlValidation {
    pub errors: Vec<String>,
}

impl SsmlValidation {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }
}

pub fn validate_ssml(ssml: &str, voice: &str) -> SsmlValidation {
    let voice = voice.trim();
    let ssml = ssml.trim();
    let mut errors = Vec::new();
    if ssml.is_empty() {
        errors.push("SSML is empty".to_string());
        return SsmlValidation { errors };
    }
    if voice.is_empty() {
        errors.push("Voice name is required".to_string());
    }

    let mut reader = Reader::from_str(ssml);
    reader.config_mut().trim_text(true);
    let mut root_seen = false;
    let mut voice_count = 0usize;
    let mut first_parse_error: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(element)) => {
                validate_element(
                    &element,
                    voice,
                    &mut root_seen,
                    &mut voice_count,
                    &mut errors,
                );
            }
            Ok(quick_xml::events::Event::Empty(element)) => {
                validate_element(
                    &element,
                    voice,
                    &mut root_seen,
                    &mut voice_count,
                    &mut errors,
                );
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(err) => {
                first_parse_error = Some(format!("SSML XML parse error: {err}"));
                break;
            }
            _ => {}
        }
    }

    if let Some(error) = first_parse_error {
        errors.push(error);
    }
    if !root_seen {
        errors.push("SSML must have a <speak> root".to_string());
    }
    if voice_count != 1 {
        errors.push(format!(
            "SSML must contain exactly one <voice> element; found {voice_count}"
        ));
    }

    SsmlValidation { errors }
}

pub async fn synthesize_speech_audio(
    access_token: &str,
    speech_endpoint: &str,
    voice: &str,
    ssml: &str,
    output_format: &str,
) -> anyhow::Result<SpeechAudio> {
    let access_token = access_token.trim();
    let ssml = ssml.trim();
    let output_format = output_format.trim();

    if access_token.is_empty() {
        anyhow::bail!("Azure Speech access token is required");
    }
    if ssml.is_empty() {
        anyhow::bail!("Narration SSML is required");
    }
    if output_format.is_empty() {
        anyhow::bail!("Azure Speech output format is required");
    }
    let validation = validate_ssml(ssml, voice);
    if !validation.is_valid() {
        anyhow::bail!(
            "Narration SSML failed validation: {}",
            validation.errors.join("; ")
        );
    }

    let mut url = Url::parse(speech_endpoint.trim())
        .map_err(|e| anyhow::anyhow!("Invalid Azure Speech endpoint: {e}"))?;
    url.set_path(SPEECH_PATH);
    url.set_query(None);
    url.set_fragment(None);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;
    let response = client
        .post(url)
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header(CONTENT_TYPE, "application/ssml+xml")
        .header("X-Microsoft-OutputFormat", output_format)
        .header(USER_AGENT, "cutready")
        .body(ssml.to_string())
        .send()
        .await?;

    let status = response.status();
    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("audio/x-wav")
        .to_string();
    let body = response.bytes().await?;

    if !status.is_success() {
        let details = String::from_utf8_lossy(&body[..body.len().min(MAX_ERROR_BYTES)])
            .trim()
            .to_string();
        if details.is_empty() {
            anyhow::bail!("Azure Speech returned {status}");
        }
        anyhow::bail!("{details}");
    }
    if body.is_empty() {
        anyhow::bail!("Azure Speech returned empty audio");
    }

    Ok(SpeechAudio {
        audio_data: body.to_vec(),
        mime_type,
    })
}

fn validate_element(
    element: &BytesStart<'_>,
    expected_voice: &str,
    root_seen: &mut bool,
    voice_count: &mut usize,
    errors: &mut Vec<String>,
) {
    let name = local_name(element.name().as_ref());
    if !*root_seen {
        if name != "speak" {
            errors.push("SSML root must be <speak>".to_string());
        }
        *root_seen = true;
    }

    if DISALLOWED_ELEMENTS.contains(&name.as_str()) {
        errors.push(format!("<{name}> is not supported for generated narration"));
    }
    if !is_allowed_for_voice_family(&name, expected_voice) {
        errors.push(format!(
            "<{name}> is not supported for voice `{expected_voice}`"
        ));
    }
    if is_mai_voice(expected_voice)
        && name == "say-as"
        && attribute_value(element, b"interpret-as").as_deref() == Some("name")
    {
        errors.push(
            r#"<say-as interpret-as="name"> is not supported by OpenAI/MAI voices"#.to_string(),
        );
    }
    if name == "voice" {
        *voice_count += 1;
        let actual_voice = attribute_value(element, b"name").unwrap_or_default();
        if !expected_voice.is_empty() && actual_voice != expected_voice {
            errors.push(format!(
                "Expected voice `{expected_voice}`, but SSML uses `{actual_voice}`"
            ));
        }
    }
}

fn attribute_value(element: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| local_name_bytes(attribute.key.as_ref()) == key)
        .map(|attribute| String::from_utf8_lossy(attribute.value.as_ref()).to_string())
}

fn local_name(name: &[u8]) -> String {
    String::from_utf8_lossy(local_name_bytes(name))
        .to_ascii_lowercase()
        .to_string()
}

fn local_name_bytes(name: &[u8]) -> &[u8] {
    name.iter()
        .position(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name)
}

fn is_mai_voice(voice: &str) -> bool {
    voice.contains(":MAI-Voice-")
}

fn is_dragon_hd_voice(voice: &str) -> bool {
    voice.contains(":DragonHD") && !voice.contains(":DragonHDOmni")
}

fn is_dragon_hd_omni_voice(voice: &str) -> bool {
    voice.contains(":DragonHDOmni")
}

fn is_allowed_for_voice_family(element: &str, voice: &str) -> bool {
    if voice.is_empty() {
        return true;
    }
    if is_mai_voice(voice) {
        return MAI_ALLOWED_ELEMENTS.contains(&element);
    }
    if is_dragon_hd_omni_voice(voice) {
        return DRAGON_HD_OMNI_ALLOWED_ELEMENTS.contains(&element);
    }
    if is_dragon_hd_voice(voice) {
        return DRAGON_HD_ALLOWED_ELEMENTS.contains(&element);
    }
    true
}

#[cfg(test)]
mod tests {
    use httpmock::{Method::POST, MockServer};

    use super::*;

    #[tokio::test]
    async fn posts_ssml_to_speech_endpoint() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path(SPEECH_PATH)
                .header("authorization", "Bearer token")
                .header("content-type", "application/ssml+xml")
                .header("x-microsoft-outputformat", "riff-24khz-16bit-mono-pcm")
                .body(r#"<speak><voice name="en-US-Harper:MAI-Voice-2">hello</voice></speak>"#);
            then.status(200)
                .header("content-type", "audio/wav")
                .body(vec![1, 2, 3]);
        });

        let audio = synthesize_speech_audio(
            "token",
            &server.base_url(),
            "en-US-Harper:MAI-Voice-2",
            r#"<speak><voice name="en-US-Harper:MAI-Voice-2">hello</voice></speak>"#,
            "riff-24khz-16bit-mono-pcm",
        )
        .await
        .unwrap();

        mock.assert();
        assert_eq!(audio.audio_data, vec![1, 2, 3]);
        assert_eq!(audio.mime_type, "audio/wav");
    }

    #[tokio::test]
    async fn surfaces_speech_error_body() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path(SPEECH_PATH);
            then.status(401).body("bad token");
        });

        let err = synthesize_speech_audio(
            "token",
            &server.base_url(),
            "en-US-Harper:MAI-Voice-2",
            r#"<speak><voice name="en-US-Harper:MAI-Voice-2">hello</voice></speak>"#,
            "riff-24khz-16bit-mono-pcm",
        )
        .await
        .unwrap_err();

        assert!(err.to_string().contains("bad token"));
    }

    #[test]
    fn validates_safe_ssml() {
        let validation = validate_ssml(
            r#"<speak version="1.0"><voice name="en-US-Harper:MAI-Voice-2">Hello.</voice></speak>"#,
            "en-US-Harper:MAI-Voice-2",
        );

        assert!(validation.is_valid(), "{:?}", validation.errors);
    }

    #[test]
    fn rejects_expressive_tags_for_mai_voice() {
        let validation = validate_ssml(
            r#"<speak version="1.0" xmlns:mstts="https://www.w3.org/2001/mstts"><voice name="en-US-Harper:MAI-Voice-2"><mstts:express-as style="narration-professional">Hello.</mstts:express-as></voice></speak>"#,
            "en-US-Harper:MAI-Voice-2",
        );

        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("express-as")));
    }

    #[test]
    fn rejects_prosody_for_mai_voice() {
        let validation = validate_ssml(
            r#"<speak version="1.0"><voice name="en-US-Harper:MAI-Voice-2"><prosody rate="slow">Hello.</prosody></voice></speak>"#,
            "en-US-Harper:MAI-Voice-2",
        );

        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("prosody")));
    }

    #[test]
    fn allows_express_as_for_dragon_hd_omni_voice() {
        let validation = validate_ssml(
            r#"<speak version="1.0" xmlns:mstts="https://www.w3.org/2001/mstts"><voice name="en-US-Ava:DragonHDOmniLatestNeural"><mstts:express-as style="confident">Hello.</mstts:express-as></voice></speak>"#,
            "en-US-Ava:DragonHDOmniLatestNeural",
        );

        assert!(validation.is_valid(), "{:?}", validation.errors);
    }

    #[test]
    fn rejects_unexpected_voice() {
        let validation = validate_ssml(
            r#"<speak><voice name="en-US-OtherNeural">Hello.</voice></speak>"#,
            "en-US-Harper:MAI-Voice-2",
        );

        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("Expected voice")));
    }
}
