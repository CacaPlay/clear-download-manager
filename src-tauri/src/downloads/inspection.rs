use serde::Serialize;
use std::path::Path;
use url::Url;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct DownloadUrlInspection {
    pub(crate) normalized_url: String,
    pub(crate) kind: String,
    pub(crate) host: String,
    pub(crate) suggested_filename: String,
    pub(crate) content_type: Option<String>,
    pub(crate) content_length: Option<u64>,
    pub(crate) requires_media_resolver: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct PageDownloadCandidate {
    pub(crate) url: String,
    pub(crate) filename: String,
    pub(crate) extension: String,
    pub(crate) kind: String,
    pub(crate) host: String,
    pub(crate) source_attribute: String,
    pub(crate) embedded: bool,
    pub(crate) same_origin: bool,
    pub(crate) confidence: u8,
}

#[derive(Serialize)]
pub(crate) struct PageDownloadDiscovery {
    pub(crate) page_url: String,
    pub(crate) page_title: String,
    pub(crate) candidates: Vec<PageDownloadCandidate>,
    pub(crate) truncated: bool,
    pub(crate) inspected_bytes: usize,
}

fn decode_html_attribute(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}

pub(crate) fn html_attribute_values(html: &str, attribute: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let attribute_bytes = attribute.as_bytes();
    let mut values = Vec::new();
    let mut cursor = 0;

    while cursor + attribute_bytes.len() < bytes.len() {
        let Some(relative) = lower[cursor..].find(attribute) else {
            break;
        };
        let start = cursor + relative;
        let before_ok = start == 0
            || !bytes[start - 1].is_ascii_alphanumeric()
                && !matches!(bytes[start - 1], b'-' | b'_');
        let mut position = start + attribute_bytes.len();
        let after_ok = position >= bytes.len()
            || !bytes[position].is_ascii_alphanumeric() && !matches!(bytes[position], b'-' | b'_');
        if !before_ok || !after_ok {
            cursor = position;
            continue;
        }
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        if position >= bytes.len() || bytes[position] != b'=' {
            cursor = position;
            continue;
        }
        position += 1;
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        if position >= bytes.len() {
            break;
        }
        let quote = bytes[position];
        let quoted = matches!(quote, b'\'' | b'"');
        if quoted {
            position += 1;
        }
        let value_start = position;
        while position < bytes.len() {
            let current = bytes[position];
            if (quoted && current == quote)
                || (!quoted && (current.is_ascii_whitespace() || current == b'>'))
            {
                break;
            }
            position += 1;
        }
        if value_start < position {
            values.push(decode_html_attribute(&html[value_start..position]));
        }
        cursor = position.saturating_add(1);
    }
    values
}

pub(crate) fn html_page_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(open_start) = lower.find("<title") else {
        return String::new();
    };
    let Some(open_end_relative) = lower[open_start..].find('>') else {
        return String::new();
    };
    let content_start = open_start + open_end_relative + 1;
    let Some(close_relative) = lower[content_start..].find("</title>") else {
        return String::new();
    };
    let title = decode_html_attribute(&html[content_start..content_start + close_relative]);
    let compact = title.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(180).collect()
}

fn page_candidate_kind(extension: &str) -> &'static str {
    match extension {
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "ts" => "video",
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" => "audio",
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif" | "svg" => "image",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" | "epub" => {
            "document"
        }
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" => "archive",
        "exe" | "msi" | "msix" | "appx" | "apk" | "deb" | "rpm" | "dmg" | "iso" => "software",
        "torrent" => "torrent",
        _ => "file",
    }
}

pub(crate) fn page_candidate_score(
    parsed: &Url,
    source_attribute: &str,
) -> Option<(String, String, u8)> {
    let path = parsed.path().to_ascii_lowercase();
    let extension = Path::new(parsed.path())
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    const EXTENSIONS: &[&str] = &[
        "zip", "7z", "rar", "tar", "gz", "bz2", "xz", "zst", "exe", "msi", "msix", "appx", "apk",
        "deb", "rpm", "dmg", "iso", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
        "csv", "epub", "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "svg", "mp3", "m4a",
        "aac", "wav", "flac", "ogg", "opus", "mp4", "mkv", "webm", "mov", "avi", "m4v", "ts",
        "srt", "vtt", "ass", "ttf", "otf", "woff", "woff2", "torrent",
    ];
    if EXTENSIONS.contains(&extension.as_str()) {
        let kind = page_candidate_kind(&extension).to_string();
        let embedded = source_attribute != "href" && source_attribute != "data-href";
        let confidence = if embedded {
            match kind.as_str() {
                "video" | "audio" => 86,
                "image" => 74,
                _ => 80,
            }
        } else {
            96
        };
        return Some((extension, kind, confidence));
    }
    if matches!(
        extension.as_str(),
        "html" | "htm" | "php" | "asp" | "aspx" | "jsp"
    ) {
        return None;
    }
    let query = parsed.query().unwrap_or_default().to_ascii_lowercase();
    let combined = format!("{path}?{query}");
    let strong_signal = [
        "/download",
        "download=",
        "download?",
        "/attachment",
        "attachment=",
        "/export",
        "export=",
        "/raw/",
        "raw=1",
        "file=",
        "filename=",
    ]
    .iter()
    .any(|signal| combined.contains(signal));
    strong_signal.then(|| {
        let confidence = if source_attribute == "href" || source_attribute == "data-href" {
            72
        } else {
            60
        };
        (String::new(), "file".to_string(), confidence)
    })
}
