use crate::url_has_public_http_target;
use serde_json::Value;
use url::Url;

pub(crate) fn duration_label(seconds: Option<f64>) -> String {
    let total = seconds.unwrap_or(0.0).max(0.0).round() as u64;
    if total == 0 {
        return "—".into();
    }
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

pub(crate) fn first_string(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(crate) fn json_exposes_reproducible_stream(value: &Value) -> bool {
    let candidate = value
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| entries.first())
        .unwrap_or(value);
    let is_public_http = |stream: &str| {
        Url::parse(stream.trim())
            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
            .unwrap_or(false)
    };
    candidate
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(is_public_http)
        || candidate
            .get("formats")
            .and_then(Value::as_array)
            .is_some_and(|formats| {
                formats.iter().any(|format| {
                    format
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(is_public_http)
                })
            })
}

pub(crate) fn safe_remote_thumbnail_url(value: &str) -> String {
    let Ok(mut parsed) = Url::parse(value.trim()) else {
        return String::new();
    };
    if parsed.scheme() != "https" || !url_has_public_http_target(&parsed) {
        return String::new();
    }
    parsed.set_fragment(None);
    parsed.to_string()
}

fn presentation_thumbnail_url(value: &str) -> String {
    safe_remote_thumbnail_url(value)
}

fn thumbnail_dimension_score(value: &Value) -> u64 {
    let width = value_u32(value, "width").unwrap_or(0) as u64;
    let height = value_u32(value, "height").unwrap_or(0) as u64;
    width.saturating_mul(height)
}

pub(crate) fn thumbnail_from(value: &Value) -> String {
    let listed = value
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let candidate = presentation_thumbnail_url(
                        item.get("url").and_then(Value::as_str).unwrap_or_default(),
                    );
                    (!candidate.is_empty()).then_some((thumbnail_dimension_score(item), candidate))
                })
                .max_by_key(|(score, _)| *score)
                .map(|(_, candidate)| candidate)
        })
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    presentation_thumbnail_url(&first_string(value, &["thumbnail"]))
}

pub(crate) fn youtube_thumbnail_from_id(value: &str) -> String {
    let id = value.trim();
    if id.len() == 11
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg");
    }
    String::new()
}

fn value_u32(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(|entry| {
            entry
                .as_u64()
                .or_else(|| entry.as_f64().map(|number| number as u64))
        })
        .and_then(|number| u32::try_from(number).ok())
}

fn is_youtube_source(value: &str) -> bool {
    let Ok(parsed) = Url::parse(value) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtu.be"
        || host == "music.youtube.com"
}

pub(crate) fn youtube_thumbnail_for_source(value: &str) -> String {
    let Ok(parsed) = Url::parse(value.trim()) else {
        return String::new();
    };
    if !is_youtube_source(value) {
        return String::new();
    }
    let path_id = parsed
        .path_segments()
        .and_then(|segments| {
            let parts = segments.collect::<Vec<_>>();
            match parts.first().copied() {
                Some("shorts") | Some("embed") | Some("live") => parts.get(1).copied(),
                _ => None,
            }
        })
        .unwrap_or_default();
    let query_id = parsed
        .query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    let id = if parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("youtu.be"))
    {
        parsed
            .path_segments()
            .and_then(|mut segments| segments.find(|part| !part.is_empty()))
            .unwrap_or_default()
            .to_string()
    } else if !query_id.is_empty() {
        query_id
    } else {
        path_id.to_string()
    };
    youtube_thumbnail_from_id(&id)
}
