use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Metadata for a recorded video/audio capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: Uuid,
    pub video_path: PathBuf,
    pub narration_path: Option<PathBuf>,
    pub system_audio_path: Option<PathBuf>,
    /// Duration in milliseconds.
    pub duration_ms: u64,
    pub tracks: Vec<TrackInfo>,
}

/// Information about a single track in a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackInfo {
    pub index: u32,
    pub track_type: TrackType,
    pub title: String,
    pub codec: String,
}

/// Type of media track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrackType {
    Video,
    Audio,
}

/// Configuration for a recording session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    /// Output file path.
    pub output_path: PathBuf,
    /// Frame rate (e.g., 30).
    pub frame_rate: u32,
    /// Capture region (None = full desktop).
    pub capture_region: Option<super::action::ScreenRegion>,
    /// Microphone device name for narration.
    pub mic_device: Option<String>,
    /// System audio device name.
    pub system_audio_device: Option<String>,
}

/// Progress update during recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingProgress {
    pub frame: u64,
    pub elapsed_secs: f64,
    pub file_size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_roundtrip() {
        let recording = Recording {
            id: Uuid::new_v4(),
            video_path: "recordings/session_1.mkv".into(),
            narration_path: Some("recordings/narration_1.wav".into()),
            system_audio_path: None,
            duration_ms: 120000,
            tracks: vec![
                TrackInfo {
                    index: 0,
                    track_type: TrackType::Video,
                    title: "Screen".into(),
                    codec: "ffv1".into(),
                },
                TrackInfo {
                    index: 1,
                    track_type: TrackType::Audio,
                    title: "Narration".into(),
                    codec: "pcm_s16le".into(),
                },
            ],
        };
        let json = serde_json::to_string(&recording).unwrap();
        let parsed: Recording = serde_json::from_str(&json).unwrap();
        assert_eq!(recording.id, parsed.id);
        assert_eq!(recording.duration_ms, parsed.duration_ms);
        assert_eq!(recording.tracks.len(), parsed.tracks.len());
    }

    #[test]
    fn recording_config_roundtrip() {
        let config = RecordingConfig {
            output_path: "output/demo.mkv".into(),
            frame_rate: 30,
            capture_region: None,
            mic_device: Some("Microphone (USB Audio)".into()),
            system_audio_device: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: RecordingConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.output_path.to_str(), parsed.output_path.to_str());
        assert_eq!(config.frame_rate, parsed.frame_rate);
    }

    #[test]
    fn recording_config_with_capture_region_roundtrip() {
        use super::super::action::ScreenRegion;

        let config = RecordingConfig {
            output_path: "output/region.mkv".into(),
            frame_rate: 60,
            capture_region: Some(ScreenRegion {
                x: 100,
                y: 50,
                width: 1280,
                height: 720,
            }),
            mic_device: None,
            system_audio_device: Some("Stereo Mix (Realtek)".into()),
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: RecordingConfig = serde_json::from_str(&json).unwrap();
        assert!(parsed.capture_region.is_some());
        assert!(parsed.mic_device.is_none());
        assert!(parsed.system_audio_device.is_some());
    }

    #[test]
    fn recording_progress_roundtrip() {
        let progress = RecordingProgress {
            frame: 1800,
            elapsed_secs: 60.0,
            file_size_bytes: 52_428_800,
        };
        let json = serde_json::to_string(&progress).unwrap();
        let parsed: RecordingProgress = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.frame, 1800);
        assert!((parsed.elapsed_secs - 60.0).abs() < f64::EPSILON);
        assert_eq!(parsed.file_size_bytes, 52_428_800);
    }

    #[test]
    fn track_type_serde_values() {
        let json = serde_json::to_string(&TrackType::Video).unwrap();
        assert_eq!(json, "\"video\"");
        let json = serde_json::to_string(&TrackType::Audio).unwrap();
        assert_eq!(json, "\"audio\"");
    }

    #[test]
    fn track_info_roundtrip() {
        let track = TrackInfo {
            index: 0,
            track_type: TrackType::Video,
            title: "Screen Capture".into(),
            codec: "ffv1".into(),
        };
        let json = serde_json::to_string(&track).unwrap();
        let parsed: TrackInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.index, 0);
        assert_eq!(parsed.track_type, TrackType::Video);
        assert_eq!(parsed.title, "Screen Capture");
    }

    #[test]
    fn recording_with_no_optional_paths() {
        let recording = Recording {
            id: Uuid::new_v4(),
            video_path: "video.mkv".into(),
            narration_path: None,
            system_audio_path: None,
            duration_ms: 0,
            tracks: vec![],
        };
        let json = serde_json::to_string(&recording).unwrap();
        let parsed: Recording = serde_json::from_str(&json).unwrap();
        assert!(parsed.narration_path.is_none());
        assert!(parsed.system_audio_path.is_none());
        assert!(parsed.tracks.is_empty());
    }
}
