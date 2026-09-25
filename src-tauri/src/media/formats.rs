use crate::{first_string, json_number, json_number_as_u64, MediaFormatSnapshot};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Copy)]
pub(crate) struct MediaFormatSize {
    pub(crate) bytes: u64,
    pub(crate) estimated: bool,
}

fn media_format_size(value: &Value) -> Option<MediaFormatSize> {
    if let Some(bytes) = json_number_as_u64(value.get("filesize")).filter(|bytes| *bytes > 0) {
        return Some(MediaFormatSize {
            bytes,
            estimated: false,
        });
    }
    json_number_as_u64(value.get("filesize_approx"))
        .filter(|bytes| *bytes > 0)
        .map(|bytes| MediaFormatSize {
            bytes,
            estimated: true,
        })
}

fn merge_media_format_sizes(
    first: Option<MediaFormatSize>,
    second: Option<MediaFormatSize>,
) -> Option<MediaFormatSize> {
    let first = first?;
    let second = second?;
    Some(MediaFormatSize {
        bytes: first.bytes.saturating_add(second.bytes),
        estimated: first.estimated || second.estimated,
    })
}

fn media_format_bitrate(value: &Value) -> f64 {
    json_number(value.get("tbr"))
        .or_else(|| json_number(value.get("abr")))
        .unwrap_or(0.0)
}

fn best_audio_format<'a>(entries: &'a [Value], requested_ext: Option<&str>) -> Option<&'a Value> {
    entries
        .iter()
        .filter(|entry| {
            let acodec = first_string(entry, &["acodec"]);
            let vcodec = first_string(entry, &["vcodec"]);
            let extension = first_string(entry, &["ext"]);
            acodec != "none"
                && vcodec == "none"
                && requested_ext.is_none_or(|requested| extension == requested)
        })
        .max_by(|left, right| {
            media_format_bitrate(left)
                .partial_cmp(&media_format_bitrate(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn best_video_format(entries: &[Value], max_height: u64) -> Option<&Value> {
    entries
        .iter()
        .filter(|entry| {
            let vcodec = first_string(entry, &["vcodec"]);
            let acodec = first_string(entry, &["acodec"]);
            let height = entry.get("height").and_then(Value::as_u64).unwrap_or(0);
            vcodec != "none" && acodec == "none" && height > 0 && height <= max_height
        })
        .max_by(|left, right| {
            let left_height = left.get("height").and_then(Value::as_u64).unwrap_or(0);
            let right_height = right.get("height").and_then(Value::as_u64).unwrap_or(0);
            left_height.cmp(&right_height).then_with(|| {
                media_format_bitrate(left)
                    .partial_cmp(&media_format_bitrate(right))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
}

fn best_combined_format(entries: &[Value], max_height: u64) -> Option<&Value> {
    entries
        .iter()
        .filter(|entry| {
            let vcodec = first_string(entry, &["vcodec"]);
            let acodec = first_string(entry, &["acodec"]);
            let height = entry.get("height").and_then(Value::as_u64).unwrap_or(0);
            vcodec != "none" && acodec != "none" && height > 0 && height <= max_height
        })
        .max_by(|left, right| {
            let left_height = left.get("height").and_then(Value::as_u64).unwrap_or(0);
            let right_height = right.get("height").and_then(Value::as_u64).unwrap_or(0);
            left_height.cmp(&right_height).then_with(|| {
                media_format_bitrate(left)
                    .partial_cmp(&media_format_bitrate(right))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
}

pub(crate) fn video_selection_size(entries: &[Value], max_height: u64) -> Option<MediaFormatSize> {
    let separated = merge_media_format_sizes(
        best_video_format(entries, max_height).and_then(media_format_size),
        best_audio_format(entries, None).and_then(media_format_size),
    );
    separated.or_else(|| best_combined_format(entries, max_height).and_then(media_format_size))
}

fn media_format_id(value: &Value) -> Option<String> {
    let id = first_string(value, &["format_id"]);
    (!id.trim().is_empty()).then_some(id)
}

fn bounded_video_selector(max_height: u64) -> String {
    format!(
        "bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best[height<={max_height}]"
    )
}

pub(crate) fn video_selection_selector(entries: &[Value], max_height: u64) -> Option<String> {
    let video = best_video_format(entries, max_height);
    let audio = best_audio_format(entries, None);
    if let (Some(video_id), Some(audio_id)) = (
        video.and_then(media_format_id),
        audio.and_then(media_format_id),
    ) {
        return Some(format!(
            "{video_id}+{audio_id}/best[height<={max_height}]/best[height<={max_height}]"
        ));
    }
    best_combined_format(entries, max_height)
        .and_then(media_format_id)
        .map(|format_id| {
            format!("{format_id}/best[height<={max_height}]/best[height<={max_height}]")
        })
}

fn media_format_snapshot(
    id: String,
    label: String,
    ext: String,
    resolution: String,
    audio_only: bool,
    size: Option<MediaFormatSize>,
    technical_source: Option<&Value>,
) -> MediaFormatSnapshot {
    let audio_codec = technical_source
        .map(|value| first_string(value, &["acodec"]))
        .filter(|value| value != "none")
        .unwrap_or_default();
    let bitrate_kbps = technical_source
        .and_then(|value| json_number(value.get("abr")).or_else(|| json_number(value.get("tbr"))))
        .filter(|value| value.is_finite() && *value > 0.0);
    let sample_rate_hz = technical_source
        .and_then(|value| json_number_as_u64(value.get("asr")))
        .filter(|value| *value > 0)
        .and_then(|value| u32::try_from(value).ok());
    let channels = technical_source
        .and_then(|value| json_number_as_u64(value.get("audio_channels")))
        .filter(|value| *value > 0)
        .and_then(|value| u32::try_from(value).ok());
    let detected_container = technical_source
        .map(|value| first_string(value, &["ext", "container"]))
        .unwrap_or_default();
    let container = if ext == "auto" || ext == "audio" {
        detected_container
    } else {
        ext.clone()
    };
    let lossless = matches!(
        audio_codec.to_ascii_lowercase().as_str(),
        "flac" | "alac" | "wavpack" | "ape" | "pcm_s16le" | "pcm_s24le" | "pcm_f32le"
    ) || matches!(
        container.to_ascii_lowercase().as_str(),
        "flac" | "wav" | "alac"
    );
    MediaFormatSnapshot {
        id,
        label,
        ext,
        resolution,
        audio_only,
        filesize: size.map(|value| value.bytes),
        filesize_estimated: size.is_some_and(|value| value.estimated),
        audio_codec,
        bitrate_kbps,
        sample_rate_hz,
        channels,
        container,
        lossless,
    }
}

pub(crate) fn media_formats(value: &Value) -> Vec<MediaFormatSnapshot> {
    let Some(entries) = value.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut video_heights = entries
        .iter()
        .filter_map(|entry| {
            let vcodec = first_string(entry, &["vcodec"]);
            let height = entry.get("height").and_then(Value::as_u64).unwrap_or(0);
            (vcodec != "none" && height > 0).then_some(height)
        })
        .collect::<Vec<_>>();
    video_heights.sort_unstable_by(|left, right| right.cmp(left));
    video_heights.dedup();

    let best_audio = best_audio_format(entries, None);
    let mut formats = Vec::new();
    let progressive_video = entries.iter().find(|entry| {
        let url = first_string(entry, &["url"]).to_ascii_lowercase();
        let ext = first_string(entry, &["ext", "container"]).to_ascii_lowercase();
        url.contains("mime_type=video") || ext == "mp4"
    });
    if video_heights.is_empty() {
        if let Some(entry) = progressive_video {
            formats.push(media_format_snapshot(
                "best".into(),
                "Mejor disponible · vídeo".into(),
                "mp4".into(),
                String::new(),
                false,
                media_format_size(entry),
                Some(entry),
            ));
        }
    }
    if let Some(max_height) = video_heights.first().copied() {
        formats.push(media_format_snapshot(
            video_selection_selector(entries, max_height)
                .unwrap_or_else(|| bounded_video_selector(max_height)),
            format!("Mejor disponible · hasta {max_height}p"),
            "auto".into(),
            format!("{max_height}p"),
            false,
            video_selection_size(entries, max_height),
            best_audio,
        ));
    }

    for height in video_heights.into_iter().take(10) {
        formats.push(media_format_snapshot(
            video_selection_selector(entries, height)
                .unwrap_or_else(|| bounded_video_selector(height)),
            format!("{height}p · vídeo + audio"),
            "auto".into(),
            format!("{height}p"),
            false,
            video_selection_size(entries, height),
            best_audio,
        ));
    }

    formats.push(media_format_snapshot(
        best_audio
            .and_then(media_format_id)
            .map(|format_id| format!("{format_id}/bestaudio/best"))
            .unwrap_or_else(|| "bestaudio/best".into()),
        "Original / mejor audio disponible".into(),
        "audio".into(),
        String::new(),
        true,
        best_audio.and_then(media_format_size),
        best_audio,
    ));
    let m4a_audio = best_audio_format(entries, Some("m4a")).or(best_audio);
    formats.push(media_format_snapshot(
        m4a_audio
            .and_then(media_format_id)
            .map(|format_id| format!("{format_id}/bestaudio[ext=m4a]/bestaudio/best"))
            .unwrap_or_else(|| "bestaudio[ext=m4a]/bestaudio/best".into()),
        "Audio · M4A".into(),
        "m4a".into(),
        String::new(),
        true,
        m4a_audio.and_then(media_format_size),
        m4a_audio,
    ));

    // Lossless choices are exposed only when yt-dlp reports an actual
    // lossless source and a real sample rate.  YouTube's usual Opus/AAC
    // streams therefore do not accidentally appear as FLAC or Hi-Res.
    let mut lossless_sources = entries
        .iter()
        .filter(|entry| first_string(entry, &["vcodec"]) == "none")
        .filter(|entry| {
            let codec = first_string(entry, &["acodec"]).to_ascii_lowercase();
            let ext = first_string(entry, &["ext", "container"]).to_ascii_lowercase();
            matches!(
                codec.as_str(),
                "flac" | "alac" | "wavpack" | "ape" | "pcm_s16le" | "pcm_s24le" | "pcm_f32le"
            ) || matches!(ext.as_str(), "flac" | "wav" | "alac")
        })
        .filter_map(|entry| {
            let sample_rate = json_number_as_u64(entry.get("asr"))?;
            (sample_rate >= 44_100).then_some((sample_rate, entry))
        })
        .collect::<Vec<_>>();
    lossless_sources.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut emitted_lossless = HashSet::new();
    for (sample_rate, entry) in lossless_sources {
        let (mode, label) = if sample_rate >= 176_400 {
            ("audio_flac_max", "Hi-Res FLAC Max — Máxima calidad")
        } else if sample_rate > 48_000 {
            ("audio_flac_hires", "Hi-Res FLAC — Alta resolución")
        } else {
            ("audio_flac", "FLAC — Calidad CD")
        };
        if !emitted_lossless.insert(mode) {
            continue;
        }
        let Some(format_id) = media_format_id(entry) else {
            continue;
        };
        formats.push(media_format_snapshot(
            format_id,
            format!("{label} · {} Hz", sample_rate),
            first_string(entry, &["ext", "container"]),
            "audio".into(),
            true,
            media_format_size(entry),
            Some(entry),
        ));
    }

    formats
}
