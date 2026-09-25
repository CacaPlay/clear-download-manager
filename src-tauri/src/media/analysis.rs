use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;

use super::{
    duration_label, first_string, media_formats, resolver, thumbnail_from,
    validate_media_session_options, MediaAnalysisSnapshot, MediaItemSnapshot, MediaSessionOptions,
};
use crate::WindowOperation;

pub(super) fn snapshot_from_json(json: Value) -> MediaAnalysisSnapshot {
    let entries = json.get("entries").and_then(Value::as_array);
    let kind = if entries.is_some() || json.get("_type").and_then(Value::as_str) == Some("playlist")
    {
        "playlist"
    } else {
        "video"
    };
    let items = entries
        .map(|values| {
            values
                .iter()
                .take(500)
                .enumerate()
                .map(|(index, item)| {
                    let source_id = {
                        let value = first_string(item, &["id", "url", "webpage_url"]);
                        if value.is_empty() {
                            format!("item-{}", index + 1)
                        } else {
                            value
                        }
                    };
                    let raw_url = first_string(item, &["webpage_url", "url"]);
                    let extractor = first_string(item, &["ie_key", "extractor_key", "extractor"])
                        .to_ascii_lowercase();
                    let source_url =
                        if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
                            raw_url
                        } else if extractor.contains("youtube")
                            || (source_id.len() == 11
                                && source_id
                                    .chars()
                                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                        {
                            format!("https://www.youtube.com/watch?v={source_id}")
                        } else {
                            raw_url
                        };
                    MediaItemSnapshot {
                        source_id,
                        source_url: source_url.clone(),
                        metadata_url: String::new(),
                        selected_source_url: String::new(),
                        title: {
                            let value = first_string(item, &["title", "fulltitle"]);
                            if value.is_empty() {
                                format!("Elemento {}", index + 1)
                            } else {
                                value
                            }
                        },
                        creator: first_string(item, &["uploader", "channel", "creator", "artist"]),
                        duration_label: duration_label(
                            item.get("duration").and_then(Value::as_f64),
                        ),
                        duration_seconds: item.get("duration").and_then(Value::as_f64),
                        thumbnail: thumbnail_from(item),
                        provider: String::new(),
                        playlist_position: Some(index as u32 + 1),
                        resolution_state: if source_url.is_empty() {
                            "not_found"
                        } else {
                            "ready"
                        }
                        .into(),
                        resolution_message: String::new(),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    MediaAnalysisSnapshot {
        kind: kind.into(),
        title: first_string(&json, &["title", "fulltitle"]),
        creator: first_string(&json, &["uploader", "channel", "creator", "artist"]),
        thumbnail: thumbnail_from(&json),
        duration_label: duration_label(json.get("duration").and_then(Value::as_f64)),
        duration_seconds: json.get("duration").and_then(Value::as_f64),
        formats: media_formats(&json),
        items,
        resolver: "yt-dlp local".into(),
    }
}
pub(crate) fn analyze_media_url(
    url: String,
    app: AppHandle,
) -> Result<MediaAnalysisSnapshot, String> {
    analyze_media_url_with_session_options(url, app, MediaSessionOptions::default(), None)
}

pub(crate) fn analyze_media_url_with_session(
    url: String,
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    app: AppHandle,
) -> Result<MediaAnalysisSnapshot, String> {
    let session = validate_media_session_options(use_brave_cookies, cookies_path)?;
    analyze_media_url_with_session_options(url, app, session, None)
}

pub(crate) fn analyze_media_url_with_session_for_window(
    url: String,
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    app: AppHandle,
    operation: Arc<WindowOperation>,
) -> Result<MediaAnalysisSnapshot, String> {
    let session = validate_media_session_options(use_brave_cookies, cookies_path)?;
    analyze_media_url_with_session_options(url, app, session, Some(operation))
}

pub(crate) fn analyze_media_url_with_session_options(
    url: String,
    app: AppHandle,
    session: MediaSessionOptions,
    operation: Option<Arc<WindowOperation>>,
) -> Result<MediaAnalysisSnapshot, String> {
    let resolved = resolver::resolve_analysis(url, app, session, operation)?;
    Ok(snapshot_from_json(resolved.json))
}
