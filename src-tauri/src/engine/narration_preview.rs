use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

const NARRATION_PREVIEW_DIR: &str = "narration-previews";
const SAMPLE_VERSION: &str = "cutready-voice-sample-v1";

pub fn cached_voice_preview(
    app_data_dir: &Path,
    voice_name: &str,
    output_format: &str,
) -> anyhow::Result<Option<String>> {
    let path = preview_path(app_data_dir, voice_name, output_format)?;
    Ok(path
        .is_file()
        .then(|| path.to_string_lossy().to_string()))
}

pub fn save_voice_preview(
    app_data_dir: &Path,
    voice_name: &str,
    output_format: &str,
    audio_data: &[u8],
) -> anyhow::Result<String> {
    if audio_data.is_empty() {
        anyhow::bail!("Voice preview audio is empty");
    }

    let path = preview_path(app_data_dir, voice_name, output_format)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Voice preview path has no parent directory"))?;
    fs::create_dir_all(parent)?;
    fs::write(&path, audio_data)?;
    Ok(path.to_string_lossy().to_string())
}

fn preview_path(
    app_data_dir: &Path,
    voice_name: &str,
    output_format: &str,
) -> anyhow::Result<PathBuf> {
    let voice_name = voice_name.trim();
    let output_format = output_format.trim();
    if voice_name.is_empty() || output_format.is_empty() {
        anyhow::bail!("Voice name and output format are required");
    }

    let mut hasher = Sha256::new();
    hasher.update(SAMPLE_VERSION);
    hasher.update([0]);
    hasher.update(voice_name.as_bytes());
    hasher.update([0]);
    hasher.update(output_format.as_bytes());
    let id = format!("{:x}", hasher.finalize());
    let extension = if output_format.contains("mp3") {
        "mp3"
    } else {
        "wav"
    };

    Ok(app_data_dir
        .join(NARRATION_PREVIEW_DIR)
        .join(format!("voice-{}.{extension}", &id[..16])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_voice_previews_by_voice_and_format() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_voice_preview(
            directory.path(),
            "en-US-Harper:MAI-Voice-2",
            "riff-24khz-16bit-mono-pcm",
            &[1, 2, 3],
        )
        .unwrap();
        let cached = cached_voice_preview(
            directory.path(),
            "en-US-Harper:MAI-Voice-2",
            "riff-24khz-16bit-mono-pcm",
        )
        .unwrap();
        let different_format = cached_voice_preview(
            directory.path(),
            "en-US-Harper:MAI-Voice-2",
            "audio-24khz-160kbitrate-mono-mp3",
        )
        .unwrap();

        assert_eq!(cached.as_deref(), Some(first.as_str()));
        assert!(different_format.is_none());
    }
}
