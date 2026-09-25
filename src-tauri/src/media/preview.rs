use std::collections::HashMap;
use std::sync::Arc;
use url::Url;

use crate::{
    ensure_public_network_resolution, first_string, media_host_is, normalize_tiktok_source_url,
    parse_public_http_url, thumbnail_from, validate_media_url, AppHandle,
    PlayerOnlineEmbedSnapshot, PlayerOnlinePreviewSnapshot, PlayerOnlineQualitySnapshot,
    PlayerStreamTechnicalSnapshot, PlayerTechnicalSnapshot, Value, WindowOperation,
};

use super::{
    instagram_post_id, pinterest_pin_id, player_number, player_u32, resolve_pinterest_short_link,
    resolver, tiktok_video_id, youtube_preview_thumbnail,
};

fn player_preview_requested_entries(value: &Value) -> Option<&Vec<Value>> {
    for key in ["requested_formats", "requested_downloads"] {
        if let Some(entries) = value.get(key).and_then(Value::as_array) {
            if entries
                .iter()
                .any(|entry| !first_string(entry, &["url"]).is_empty())
            {
                return Some(entries);
            }
        }
    }

    value
        .get("requested_formats")
        .and_then(Value::as_array)
        .or_else(|| value.get("requested_downloads").and_then(Value::as_array))
}

pub(crate) fn player_preview_selected_entry(value: &Value) -> &Value {
    player_preview_requested_entries(value)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| first_string(entry, &["vcodec"]) != "none")
                .or_else(|| entries.first())
        })
        .unwrap_or(value)
}

pub(crate) fn player_preview_audio_entry(value: &Value) -> Option<&Value> {
    player_preview_requested_entries(value).and_then(|entries| {
        entries.iter().find(|entry| {
            first_string(entry, &["acodec"]) != "none" && first_string(entry, &["vcodec"]) == "none"
        })
    })
}

fn player_preview_progressive_score(value: &Value) -> (u32, u8, u8, i64) {
    let height = value
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_default();
    let container = match first_string(value, &["ext", "container"]).as_str() {
        "mp4" => 2,
        "webm" => 1,
        _ => 0,
    };
    let codec = first_string(value, &["vcodec"]);
    let h264 = u8::from(codec.starts_with("avc1") || codec.starts_with("avc3"));
    let bitrate = player_number(value.get("tbr")).unwrap_or_default().round() as i64;
    (height, container, h264, bitrate)
}

pub(crate) fn player_preview_progressive_entry(value: &Value) -> Option<&Value> {
    value
        .get("formats")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    let url = first_string(entry, &["url"]);
                    let ext = first_string(entry, &["ext", "container"]);
                    !url.is_empty()
                        && matches!(ext.as_str(), "mp4" | "webm")
                        && first_string(entry, &["vcodec"]) != "none"
                        && first_string(entry, &["acodec"]) != "none"
                        && Url::parse(&url)
                            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
                            .unwrap_or(false)
                })
                .max_by_key(|entry| player_preview_progressive_score(entry))
        })
}

fn player_preview_quality_score(
    container: &str,
    video_codec: &str,
    audio_codec: &str,
    protocol: &str,
    has_audio: bool,
    bitrate: Option<f64>,
) -> (u8, u8, u8, u8, u8, i64) {
    let container_score = match container.to_ascii_lowercase().as_str() {
        "mp4" => 3,
        "webm" => 2,
        _ => 0,
    };
    let codec_score = if video_codec.starts_with("avc1") || video_codec.starts_with("avc3") {
        4
    } else if video_codec.starts_with("vp9") {
        3
    } else if video_codec.starts_with("av01") {
        2
    } else if !video_codec.is_empty() && video_codec != "none" {
        1
    } else {
        0
    };
    let audio_score = u8::from(has_audio || (!audio_codec.is_empty() && audio_codec != "none"));
    let protocol_score = u8::from(protocol.eq_ignore_ascii_case("https"));
    let startup_score = u8::from(has_audio);
    let bitrate_score = bitrate.unwrap_or_default().round() as i64;
    (
        container_score,
        codec_score,
        audio_score,
        protocol_score,
        startup_score,
        bitrate_score,
    )
}

fn player_preview_low_progressive_entry(value: &Value) -> Option<&Value> {
    value
        .get("formats")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    let url = first_string(entry, &["url"]);
                    let ext = first_string(entry, &["ext", "container"]);
                    !url.is_empty()
                        && matches!(ext.as_str(), "mp4" | "webm")
                        && first_string(entry, &["vcodec"]) != "none"
                        && first_string(entry, &["acodec"]) != "none"
                        && Url::parse(&url)
                            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
                            .unwrap_or(false)
                })
                .min_by_key(|entry| {
                    let height = entry
                        .get("height")
                        .and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .unwrap_or(u32::MAX);
                    // Prefer the highest safe progressive stream up to 480p;
                    // if the source exposes only larger streams, use its
                    // smallest compatible stream as the last native fallback.
                    if height <= 480 {
                        (0_u8, 480_u32.saturating_sub(height), height)
                    } else {
                        (1_u8, height.saturating_sub(480), height)
                    }
                })
        })
}

pub(crate) fn player_preview_qualities(
    value: &Value,
    fallback_audio_url: &str,
) -> Vec<PlayerOnlineQualitySnapshot> {
    let Some(entries) = value.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut qualities = entries
        .iter()
        .filter_map(|entry| {
            let url = first_string(entry, &["url"]);
            let id = first_string(entry, &["format_id", "format"]);
            let ext = first_string(entry, &["ext", "container"]).to_ascii_uppercase();
            let video_codec = first_string(entry, &["vcodec"]);
            let audio_codec = first_string(entry, &["acodec"]);
            let height = player_u32(entry.get("height"));
            if url.is_empty()
                || id.is_empty()
                || height.is_none()
                || video_codec.is_empty()
                || video_codec == "none"
                || !Url::parse(&url)
                    .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
                    .unwrap_or(false)
            {
                return None;
            }
            let has_audio = !audio_codec.is_empty() && audio_codec != "none";
            let fps = player_number(entry.get("fps"));
            let protocol = first_string(entry, &["protocol"]);
            let container = first_string(entry, &["ext", "container"]);
            let bitrate = player_number(entry.get("tbr"));
            let fps_label = fps
                .filter(|value| *value >= 50.0)
                .map(|value| format!(" · {:.0}fps", value))
                .unwrap_or_default();
            let label = format!(
                "{}p{} · {}{}",
                height.unwrap_or_default(),
                fps_label,
                if ext.is_empty() { "VIDEO" } else { &ext },
                if has_audio { " · audio" } else { "" }
            );
            Some(PlayerOnlineQualitySnapshot {
                id,
                label,
                url,
                audio_url: if has_audio {
                    String::new()
                } else {
                    fallback_audio_url.to_string()
                },
                width: player_u32(entry.get("width")),
                height,
                fps,
                container,
                video_codec,
                audio_codec,
                protocol,
                bitrate_kbps: bitrate,
                candidate_rank: 0,
                has_audio,
            })
        })
        .collect::<Vec<_>>();

    qualities.sort_by(|left, right| {
        right
            .height
            .cmp(&left.height)
            .then_with(|| {
                let left_score = player_preview_quality_score(
                    &left.container,
                    &left.video_codec,
                    &left.audio_codec,
                    &left.protocol,
                    left.has_audio,
                    left.bitrate_kbps,
                );
                let right_score = player_preview_quality_score(
                    &right.container,
                    &right.video_codec,
                    &right.audio_codec,
                    &right.protocol,
                    right.has_audio,
                    right.bitrate_kbps,
                );
                right_score.cmp(&left_score)
            })
            .then_with(|| {
                right
                    .fps
                    .partial_cmp(&left.fps)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut ranks = HashMap::<u32, u32>::new();
    for quality in &mut qualities {
        let rank = ranks.entry(quality.height.unwrap_or_default()).or_default();
        quality.candidate_rank = *rank;
        *rank = rank.saturating_add(1);
    }
    qualities
}

pub(crate) fn player_preview_max_height(value: &Value) -> Option<u32> {
    value
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| first_string(entry, &["vcodec"]) != "none")
        .filter_map(|entry| entry.get("height").and_then(Value::as_u64))
        .filter_map(|height| u32::try_from(height).ok())
        .max()
}

pub(crate) fn player_preview_quality_limited(
    preview_height: Option<u32>,
    max_height: Option<u32>,
) -> bool {
    match (preview_height, max_height) {
        (Some(preview), Some(maximum)) => {
            preview <= 480 && maximum >= 1080 && maximum.saturating_sub(preview) >= 540
        }
        _ => false,
    }
}

pub(crate) fn player_preview_technical(value: &Value) -> PlayerTechnicalSnapshot {
    let selected = player_preview_selected_entry(value);
    let audio_entry = player_preview_audio_entry(value).unwrap_or(selected);
    player_preview_technical_for_entries(value, selected, audio_entry)
}

fn player_preview_technical_for_entries(
    value: &Value,
    selected: &Value,
    audio_entry: &Value,
) -> PlayerTechnicalSnapshot {
    let audio_codec = first_string(audio_entry, &["acodec"]);
    let video_codec = first_string(selected, &["vcodec"]);
    let bitrate = player_number(selected.get("tbr"));
    let audio_bitrate = player_number(audio_entry.get("abr"))
        .or_else(|| player_number(audio_entry.get("tbr")))
        .or(bitrate);
    let audio = (audio_codec != "none" && !audio_codec.is_empty()).then_some(
        PlayerStreamTechnicalSnapshot {
            codec: audio_codec,
            bitrate_kbps: audio_bitrate,
            sample_rate_hz: audio_entry
                .get("asr")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            channels: audio_entry
                .get("audio_channels")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
        },
    );
    let video = (video_codec != "none" && !video_codec.is_empty()).then_some(
        PlayerStreamTechnicalSnapshot {
            codec: video_codec,
            bitrate_kbps: bitrate,
            sample_rate_hz: None,
            channels: None,
        },
    );
    PlayerTechnicalSnapshot {
        container: first_string(selected, &["ext", "container"]),
        bitrate_kbps: bitrate,
        duration_seconds: player_number(value.get("duration")),
        audio,
        video,
    }
}

pub(crate) fn resolve_online_embed(url: String) -> Result<PlayerOnlineEmbedSnapshot, String> {
    let validated = validate_media_url(&url)?;
    let initial = Url::parse(&validated)
        .map_err(|_| "El enlace de reproducción online no es válido".to_string())?;
    ensure_public_network_resolution(&initial)?;

    if media_host_is(&initial, "tiktok.com") {
        let id = tiktok_video_id(&initial)
            .ok_or_else(|| "No se pudo identificar el video de TikTok".to_string())?;
        return Ok(PlayerOnlineEmbedSnapshot {
            url: format!(
                "https://www.tiktok.com/player/v1/{id}?autoplay=0&controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1"
            ),
            platform: "TikTok".into(),
        });
    }

    if media_host_is(&initial, "instagram.com") {
        let id = instagram_post_id(&initial)
            .ok_or_else(|| "No se pudo identificar la publicación de Instagram".to_string())?;
        return Ok(PlayerOnlineEmbedSnapshot {
            url: format!("https://www.instagram.com/p/{id}/embed/"),
            platform: "Instagram".into(),
        });
    }

    if media_host_is(&initial, "pin.it") {
        let resolved = resolve_pinterest_short_link(&initial)?;
        let id = pinterest_pin_id(&resolved)
            .ok_or_else(|| "No se pudo identificar el Pin de Pinterest".to_string())?;
        return Ok(PlayerOnlineEmbedSnapshot {
            url: format!("https://assets.pinterest.com/ext/embed.html?id={id}"),
            platform: "Pinterest".into(),
        });
    }

    if media_host_is(&initial, "pinterest.com") {
        let id = pinterest_pin_id(&initial)
            .ok_or_else(|| "No se pudo identificar el Pin de Pinterest".to_string())?;
        return Ok(PlayerOnlineEmbedSnapshot {
            url: format!("https://assets.pinterest.com/ext/embed.html?id={id}"),
            platform: "Pinterest".into(),
        });
    }

    Err("Esta plataforma no ofrece un reproductor oficial compatible".into())
}

pub(crate) fn build_player_online_preview_snapshot(
    parsed: Url,
    json: Value,
) -> Result<PlayerOnlinePreviewSnapshot, String> {
    let selected = player_preview_selected_entry(&json);
    let stream_url = first_string(selected, &["url"]);
    if stream_url.is_empty() {
        return Err("La fuente no expuso un flujo directo reproducible".into());
    }
    let stream = parse_public_http_url(&stream_url, "El flujo temporal no es válido")?;
    ensure_public_network_resolution(&stream)?;

    let audio_stream = player_preview_audio_entry(&json)
        .map(|entry| first_string(entry, &["url"]))
        .filter(|url| !url.is_empty())
        .map(|url| parse_public_http_url(&url, "El flujo de audio temporal no es válido"))
        .transpose()?;
    if let Some(audio_stream) = &audio_stream {
        ensure_public_network_resolution(audio_stream)?;
    }

    let progressive = player_preview_progressive_entry(&json);
    let progressive_stream = progressive
        .map(|entry| first_string(entry, &["url"]))
        .filter(|url| !url.is_empty())
        .map(|url| parse_public_http_url(&url, "El flujo progresivo temporal no es válido"))
        .transpose()?;
    if let Some(progressive_stream) = &progressive_stream {
        ensure_public_network_resolution(progressive_stream)?;
    }

    let low_progressive = player_preview_low_progressive_entry(&json);
    let low_progressive_stream = low_progressive
        .map(|entry| first_string(entry, &["url"]))
        .filter(|url| !url.is_empty())
        .map(|url| parse_public_http_url(&url, "El flujo progresivo seguro no es válido"))
        .transpose()?;
    if let Some(low_progressive_stream) = &low_progressive_stream {
        ensure_public_network_resolution(low_progressive_stream)?;
    }

    let fallback_audio_url = audio_stream
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_default();
    let qualities = player_preview_qualities(&json, &fallback_audio_url)
        .into_iter()
        .filter_map(|mut quality| {
            let parsed_video =
                parse_public_http_url(&quality.url, "El flujo de calidad temporal no es valido")
                    .ok()?;
            if ensure_public_network_resolution(&parsed_video).is_err() {
                return None;
            }
            quality.url = parsed_video.to_string();
            if !quality.audio_url.is_empty() {
                let parsed_audio = parse_public_http_url(
                    &quality.audio_url,
                    "El flujo de audio de calidad no es valido",
                )
                .ok()?;
                if ensure_public_network_resolution(&parsed_audio).is_err() {
                    return None;
                }
                quality.audio_url = parsed_audio.to_string();
            }
            Some(quality)
        })
        .collect::<Vec<_>>();

    let width = selected
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let height = selected
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let max_height = player_preview_max_height(&json).or(height);

    Ok(PlayerOnlinePreviewSnapshot {
        title: first_string(&json, &["title", "fulltitle"]),
        creator: first_string(&json, &["uploader", "channel", "creator", "artist"]),
        thumbnail: {
            let stable = youtube_preview_thumbnail(&parsed);
            if stable.is_empty() {
                thumbnail_from(&json)
            } else {
                stable
            }
        },
        stream_url: stream.to_string(),
        qualities,
        audio_stream_url: audio_stream.map(|url| url.to_string()).unwrap_or_default(),
        width,
        height,
        max_height,
        quality_limited: player_preview_quality_limited(height, max_height),
        technical: player_preview_technical(&json),
        progressive_stream_url: progressive_stream
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
        progressive_width: progressive
            .and_then(|entry| entry.get("width"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        progressive_height: progressive
            .and_then(|entry| entry.get("height"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        progressive_technical: progressive
            .map(|entry| player_preview_technical_for_entries(&json, entry, entry)),
        low_progressive_stream_url: low_progressive_stream
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
        low_progressive_width: low_progressive
            .and_then(|entry| entry.get("width"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        low_progressive_height: low_progressive
            .and_then(|entry| entry.get("height"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        low_progressive_technical: low_progressive
            .map(|entry| player_preview_technical_for_entries(&json, entry, entry)),
    })
}
pub(crate) fn player_online_preview_snapshot(
    url: String,
    app: AppHandle,
) -> Result<PlayerOnlinePreviewSnapshot, String> {
    player_online_preview_snapshot_with_operation(url, app, None)
}

pub(crate) fn player_online_preview_snapshot_with_operation(
    url: String,
    app: AppHandle,
    operation: Option<Arc<WindowOperation>>,
) -> Result<PlayerOnlinePreviewSnapshot, String> {
    let validated = validate_media_url(&url)?;
    let parsed = Url::parse(&validated).map_err(|_| "El enlace de vista previa no es válido")?;
    ensure_public_network_resolution(&parsed)?;
    let normalized = normalize_tiktok_source_url(parsed);
    let resolved = resolver::resolve_preview(validated, app, operation)?;
    build_player_online_preview_snapshot(normalized, resolved.json)
}
