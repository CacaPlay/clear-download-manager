use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct MediaFormatSnapshot {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) ext: String,
    pub(crate) resolution: String,
    pub(crate) audio_only: bool,
    pub(crate) filesize: Option<u64>,
    pub(crate) filesize_estimated: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) audio_codec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bitrate_kbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sample_rate_hz: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) channels: Option<u32>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) container: String,
    pub(crate) lossless: bool,
}

#[derive(Serialize)]
pub(crate) struct MediaItemSnapshot {
    pub(crate) source_id: String,
    pub(crate) source_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) metadata_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) selected_source_url: String,
    pub(crate) title: String,
    pub(crate) creator: String,
    pub(crate) duration_label: String,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) thumbnail: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) playlist_position: Option<u32>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) resolution_state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) resolution_message: String,
}

#[derive(Serialize)]
pub(crate) struct MediaAnalysisSnapshot {
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) creator: String,
    pub(crate) thumbnail: String,
    pub(crate) duration_label: String,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) formats: Vec<MediaFormatSnapshot>,
    pub(crate) items: Vec<MediaItemSnapshot>,
    pub(crate) resolver: String,
}

#[derive(Default, Serialize)]
pub(crate) struct PlayerStreamTechnicalSnapshot {
    pub(crate) codec: String,
    pub(crate) bitrate_kbps: Option<f64>,
    pub(crate) sample_rate_hz: Option<u32>,
    pub(crate) channels: Option<u32>,
}

#[derive(Default, Serialize)]
pub(crate) struct PlayerTechnicalSnapshot {
    pub(crate) container: String,
    pub(crate) bitrate_kbps: Option<f64>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) audio: Option<PlayerStreamTechnicalSnapshot>,
    pub(crate) video: Option<PlayerStreamTechnicalSnapshot>,
}

#[derive(Serialize)]
pub(crate) struct PlayerMediaSnapshot {
    pub(crate) job_id: i64,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) detail: String,
    pub(crate) progress: f64,
    pub(crate) thumbnail: String,
    pub(crate) output_mode: String,
    pub(crate) kind: String,
    pub(crate) playable: bool,
    pub(crate) local_path: String,
    pub(crate) state_title: String,
    pub(crate) message: String,
    pub(crate) converted: Option<bool>,
    pub(crate) technical: Option<PlayerTechnicalSnapshot>,
}

#[derive(Serialize)]
pub(crate) struct PlayerOnlinePreviewSnapshot {
    pub(crate) title: String,
    pub(crate) creator: String,
    pub(crate) thumbnail: String,
    pub(crate) stream_url: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) qualities: Vec<PlayerOnlineQualitySnapshot>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) audio_stream_url: String,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    pub(crate) max_height: Option<u32>,
    pub(crate) quality_limited: bool,
    pub(crate) technical: PlayerTechnicalSnapshot,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) progressive_stream_url: String,
    pub(crate) progressive_width: Option<u32>,
    pub(crate) progressive_height: Option<u32>,
    pub(crate) progressive_technical: Option<PlayerTechnicalSnapshot>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) low_progressive_stream_url: String,
    pub(crate) low_progressive_width: Option<u32>,
    pub(crate) low_progressive_height: Option<u32>,
    pub(crate) low_progressive_technical: Option<PlayerTechnicalSnapshot>,
}

#[derive(Serialize)]
pub(crate) struct PlayerOnlineEmbedSnapshot {
    pub(crate) url: String,
    pub(crate) platform: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct PlayerOnlineQualitySnapshot {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) audio_url: String,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    pub(crate) fps: Option<f64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) container: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) video_codec: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) audio_codec: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bitrate_kbps: Option<f64>,
    #[serde(default)]
    pub(crate) candidate_rank: u32,
    pub(crate) has_audio: bool,
}

#[derive(Serialize)]
pub(crate) struct PlayerPlaylistQueueItem {
    pub(crate) job_id: Option<i64>,
    pub(crate) position: i64,
    pub(crate) title: String,
    pub(crate) creator: String,
    pub(crate) thumbnail: String,
    pub(crate) status: String,
    pub(crate) playable: bool,
}

#[derive(Serialize)]
pub(crate) struct PlayerPlaylistQueueSnapshot {
    pub(crate) batch_id: i64,
    pub(crate) title: String,
    pub(crate) items: Vec<PlayerPlaylistQueueItem>,
}
