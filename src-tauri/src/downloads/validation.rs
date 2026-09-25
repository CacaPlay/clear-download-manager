#![allow(clippy::invisible_characters)]

use std::path::Path;
use url::Url;

pub(crate) fn windows_reserved_filename(value: &str) -> bool {
    let stem = Path::new(value)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or(value)
        .trim()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

pub(crate) fn clip_filename_preserving_extension(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let path = Path::new(value);
    let extension = path
        .extension()
        .and_then(|part| part.to_str())
        .filter(|part| !part.is_empty());
    let extension_chars = extension.map(|part| part.chars().count() + 1).unwrap_or(0);
    if extension_chars >= max_chars.saturating_sub(8) {
        return value.chars().take(max_chars).collect();
    }
    let stem_limit = max_chars.saturating_sub(extension_chars);
    let stem = path
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or("descarga")
        .chars()
        .take(stem_limit)
        .collect::<String>()
        .trim_end_matches([' ', '.'])
        .to_string();
    match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}.{extension}"),
        _ => stem,
    }
}

pub(crate) fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim_end().to_string();
    let mut clipped = clip_filename_preserving_extension(&cleaned, 180);
    if clipped.is_empty() {
        clipped = "descarga.bin".into();
    } else if windows_reserved_filename(&clipped) {
        clipped.insert(0, '_');
    }
    clipped
}

pub(crate) fn decode_percent_encoded_filename(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

pub(crate) fn filename_extension(value: &str) -> Option<&str> {
    Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.trim().is_empty())
}

fn is_generic_binary_extension(value: &str) -> bool {
    value
        .trim()
        .trim_start_matches('.')
        .eq_ignore_ascii_case("bin")
}

fn filename_basename(value: &str) -> &str {
    value.split(['/', '\\']).next_back().unwrap_or(value)
}

pub(crate) fn filename_from_url_path(parsed: &Url) -> Option<String> {
    parsed
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .filter(|part| !part.trim().is_empty())
        .map(decode_percent_encoded_filename)
        .map(|value| filename_basename(&value).to_string())
        .map(|value| sanitize_filename(&value))
        .filter(|value| !value.is_empty() && value != "descarga.bin")
}

pub(crate) fn url_path_extension(parsed: &Url) -> Option<String> {
    filename_from_url_path(parsed)
        .and_then(|candidate| filename_extension(&candidate).map(str::to_ascii_lowercase))
}

/// Some direct document endpoints use an opaque path and carry the actual
/// file format only in a query parameter, for example Google Docs export
/// URLs with `?format=pdf` or `?format=docx`.  This is only a fallback: a
/// filename/content-disposition extension remains stronger evidence.
pub(crate) fn extension_from_url_query(parsed: &Url) -> Option<&'static str> {
    parsed.query_pairs().find_map(|(key, value)| {
        if !key.eq_ignore_ascii_case("format") {
            return None;
        }
        match value
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "pdf" => Some("pdf"),
            "doc" => Some("doc"),
            "docx" => Some("docx"),
            "xls" => Some("xls"),
            "xlsx" => Some("xlsx"),
            "ppt" => Some("ppt"),
            "pptx" => Some("pptx"),
            _ => None,
        }
    })
}

/// Google Docs sometimes exposes a short-lived `googleusercontent.com/export`
/// URL. Those signed URLs can return 400 even while the document's canonical
/// public export endpoint remains available. Rebuild only this narrow,
/// recognizable shape; private documents will still be rejected by Google.
pub(crate) fn canonical_google_docs_export_url(parsed: &Url) -> Option<Url> {
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !(host == "googleusercontent.com" || host.ends_with(".googleusercontent.com"))
        || !parsed.path_segments().is_some_and(|mut segments| {
            segments.any(|segment| segment.eq_ignore_ascii_case("export"))
        })
    {
        return None;
    }
    let extension = extension_from_url_query(parsed)?;
    let query_document_id = parsed
        .query_pairs()
        .find_map(|(key, value)| key.eq_ignore_ascii_case("id").then(|| value.into_owned()))
        .filter(|value| value.len() >= 8 && is_google_document_id(value));
    let path_document_id = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back().map(str::to_string))
        .filter(|value| value.len() >= 8 && is_google_document_id(value));
    let document_id = path_document_id.or(query_document_id)?;
    if !is_google_document_id(&document_id) {
        return None;
    }
    Url::parse(&format!(
        "https://docs.google.com/document/d/{document_id}/export?format={extension}"
    ))
    .ok()
}

fn is_google_document_id(value: &str) -> bool {
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(crate) fn extension_from_mime(mime: &str) -> Option<&'static str> {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "application/pdf" => Some("pdf"),
        "application/zip" | "application/x-zip-compressed" => Some("zip"),
        "application/x-7z-compressed" => Some("7z"),
        "application/vnd.rar" | "application/x-rar" | "application/x-rar-compressed" => Some("rar"),
        "application/gzip" | "application/x-gzip" => Some("gz"),
        "application/x-bzip2" => Some("bz2"),
        "application/x-xz" => Some("xz"),
        "application/zstd" | "application/x-zstd" => Some("zst"),
        "application/x-tar" => Some("tar"),
        "application/java-archive" => Some("jar"),
        "application/vnd.ms-cab-compressed" => Some("cab"),
        "application/x-msdownload"
        | "application/vnd.microsoft.portable-executable"
        | "application/x-msdos-program"
        | "application/x-executable" => Some("exe"),
        "application/x-msi" | "application/x-windows-installer" => Some("msi"),
        "application/vnd.ms-appx" => Some("appx"),
        "application/vnd.ms-appx-bundle" => Some("appxbundle"),
        "application/vnd.msix" => Some("msix"),
        "application/vnd.msixbundle" => Some("msixbundle"),
        "application/vnd.android.package-archive" => Some("apk"),
        "application/vnd.debian.binary-package" | "application/x-debian-package" => Some("deb"),
        "application/x-rpm" => Some("rpm"),
        "application/x-apple-diskimage" => Some("dmg"),
        "application/x-iso9660-image" => Some("iso"),
        "application/msword" => Some("doc"),
        "application/vnd.ms-excel" => Some("xls"),
        "application/vnd.ms-powerpoint" => Some("ppt"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        "text/plain" => Some("txt"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/ogg" => Some("ogg"),
        "audio/flac" => Some("flac"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/x-matroska" => Some("mkv"),
        "video/quicktime" => Some("mov"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/avif" => Some("avif"),
        "image/svg+xml" => Some("svg"),
        "application/octet-stream" | "binary/octet-stream" => None,
        _ => None,
    }
}

pub(crate) fn filename_with_extension_hint(filename: &str, extension: Option<&str>) -> String {
    let filename = sanitize_filename(filename.trim());
    let extension = extension
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .map(|extension| extension.trim_start_matches('.').to_ascii_lowercase());
    if let Some(current_extension) = filename_extension(&filename) {
        // Browser/extension captures may synthesize `.bin` for an
        // application/octet-stream response. Replace that placeholder only
        // when a specific extension is available; a standalone `.bin` stays
        // valid when no better evidence exists.
        if is_generic_binary_extension(current_extension)
            && extension
                .as_deref()
                .is_some_and(|value| !is_generic_binary_extension(value))
        {
            let stem = Path::new(&filename)
                .file_stem()
                .and_then(|part| part.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("descarga");
            return sanitize_filename(&format!("{stem}.{}", extension.as_deref().unwrap_or("bin")));
        }
        return filename;
    }
    match extension {
        Some(extension) => sanitize_filename(&format!("{filename}.{extension}")),
        None => filename,
    }
}

pub(crate) fn split_content_disposition_parameters(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quoted {
            escaped = true;
            current.push(character);
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            current.push(character);
            continue;
        }
        if character == ';' && !quoted {
            result.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(character);
        }
    }
    if !current.trim().is_empty() {
        result.push(current.trim().to_string());
    }
    result
}

pub(crate) fn unquote_content_disposition_value(value: &str) -> String {
    let trimmed = value.trim();
    let unquoted = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    unquoted.replace("\\\"", "\"").replace("\\\\", "\\")
}

pub(crate) fn content_disposition_filename(value: &str) -> Option<String> {
    let mut regular = None;
    for segment in split_content_disposition_parameters(value)
        .into_iter()
        .skip(1)
    {
        let Some((key, raw_value)) = segment.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let raw_value = unquote_content_disposition_value(raw_value);
        if raw_value.trim().is_empty() {
            continue;
        }
        if key == "filename*" {
            // RFC 5987: charset'language'percent-encoded-value. UTF-8 is the
            // common form; percent decoding is still useful for legacy labels.
            let encoded = raw_value
                .splitn(3, '\'')
                .nth(2)
                .filter(|value| !value.is_empty())
                .unwrap_or(raw_value.as_str());
            let decoded_value = decode_percent_encoded_filename(encoded);
            let decoded = sanitize_filename(filename_basename(&decoded_value));
            if !decoded.is_empty() && decoded != "descarga.bin" {
                return Some(decoded);
            }
        } else if key == "filename" {
            let decoded_value = decode_percent_encoded_filename(&raw_value);
            let decoded = sanitize_filename(filename_basename(&decoded_value));
            if !decoded.is_empty() && decoded != "descarga.bin" {
                regular = Some(decoded);
            }
        }
    }
    regular
}

pub(crate) fn filename_from_url_query(parsed: &Url) -> Option<String> {
    for (key, value) in parsed.query_pairs() {
        let key = key.to_ascii_lowercase();
        // S3/Azure/GitHub release links commonly carry the response header
        // override in the URL itself.  Treat only the explicit
        // Content-Disposition override as filename evidence, after the same
        // sanitization and basename checks used for an actual response
        // header.  This preserves `.exe`/archive extensions when a probe is
        // unavailable or the signed URL has expired before the first request.
        if matches!(
            key.as_str(),
            "response-content-disposition" | "content-disposition" | "rscd"
        ) {
            let decoded = decode_percent_encoded_filename(value.as_ref());
            if let Some(candidate) = content_disposition_filename(&decoded) {
                return Some(candidate);
            }
            continue;
        }
        if !matches!(key.as_str(), "filename" | "file" | "name" | "download") {
            continue;
        }
        let decoded_value = decode_percent_encoded_filename(value.as_ref());
        let candidate = sanitize_filename(filename_basename(&decoded_value));
        if candidate != "descarga.bin" && candidate.chars().count() >= 3 {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn filename_from_url_candidate(parsed: &Url) -> Option<String> {
    let path_name = filename_from_url_path(parsed);
    let query_name = filename_from_url_query(parsed);
    match (path_name, query_name) {
        // Explicit filename-like query parameters are more informative than
        // extensionless endpoint paths such as /get or opaque redirect IDs.
        // Keep a real path extension authoritative when both sources provide one.
        (Some(path_name), Some(query_name)) => {
            if filename_extension(&path_name).is_none() && filename_extension(&query_name).is_some()
            {
                Some(query_name)
            } else {
                Some(path_name)
            }
        }
        (Some(path_name), None) => Some(path_name),
        (None, query_name) => query_name,
    }
}

pub(crate) fn filename_is_temporary_or_opaque(value: &str) -> bool {
    let basename = value.split(['/', '\\']).next_back().unwrap_or(value).trim();
    if basename.is_empty() {
        return true;
    }
    let lower = basename.to_ascii_lowercase();
    if lower.ends_with(".crdownload") || lower.ends_with(".part") || lower.ends_with(".tmp") {
        return true;
    }
    let stem = Path::new(basename)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or(basename)
        .trim()
        .to_ascii_lowercase();
    let generic_stem = matches!(
        stem.as_str(),
        "download" | "descarga" | "file" | "archivo" | "attachment" | "unknown"
    ) || [
        "download (",
        "descarga (",
        "file (",
        "archivo (",
        "attachment (",
        "unconfirmed ",
    ]
    .iter()
    .any(|prefix| stem.starts_with(prefix));
    if generic_stem {
        return true;
    }
    let compact: String = stem
        .chars()
        .filter(|character| *character != '-' && *character != '_')
        .collect();
    compact.len() >= 24
        && compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

pub(crate) fn resolve_download_filename(
    original_url: &Url,
    final_url: &Url,
    preferred: Option<&str>,
    disposition: Option<&str>,
    mime: Option<&str>,
) -> String {
    let disposition_name = disposition.and_then(content_disposition_filename);
    let final_name = filename_from_url_candidate(final_url);
    let original_name = filename_from_url_candidate(original_url);
    let mime_extension = mime.and_then(extension_from_mime);
    // A real filename from Content-Disposition or either URL is stronger
    // evidence than a generic/misreported MIME type.  Some hosts advertise
    // archives as audio/video while the browser is still resolving the
    // download; trusting that MIME here creates names such as `archivo.mp3`
    // for a `.rar` payload and later enables the media player incorrectly.
    let disposition_extension = disposition_name.as_deref().and_then(filename_extension);
    let final_extension = final_name.as_deref().and_then(filename_extension);
    let original_extension = original_name.as_deref().and_then(filename_extension);
    let final_query_extension = extension_from_url_query(final_url);
    let original_query_extension = extension_from_url_query(original_url);
    let extension_hint = disposition_extension
        .filter(|value| !is_generic_binary_extension(value))
        .or_else(|| final_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| original_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| final_query_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| original_query_extension.filter(|value| !is_generic_binary_extension(value)))
        .or(mime_extension)
        .or(disposition_extension)
        .or(final_extension)
        .or(original_extension)
        .or(final_query_extension)
        .or(original_query_extension);

    if let Some(preferred) = preferred.map(str::trim).filter(|value| !value.is_empty()) {
        let basename = preferred
            .split(['/', '\\'])
            .next_back()
            .unwrap_or(preferred);
        let generic_binary_preferred = filename_extension(basename).is_some_and(|value| {
            is_generic_binary_extension(value)
                && extension_hint.is_some_and(|hint| !is_generic_binary_extension(hint))
        });
        let has_real_extension = filename_extension(basename).is_some()
            && !basename.to_ascii_lowercase().ends_with(".crdownload")
            && !basename.to_ascii_lowercase().ends_with(".part")
            && !basename.to_ascii_lowercase().ends_with(".tmp");
        if has_real_extension
            && !generic_binary_preferred
            && !filename_is_temporary_or_opaque(basename)
        {
            return sanitize_filename(basename);
        }
        if !filename_is_temporary_or_opaque(basename) {
            return filename_with_extension_hint(basename, extension_hint);
        }
    }
    if let Some(name) = disposition_name.as_deref() {
        return filename_with_extension_hint(name, extension_hint);
    }
    if let Some(name) = final_name
        .as_deref()
        .filter(|name| !filename_is_temporary_or_opaque(name))
    {
        return filename_with_extension_hint(name, extension_hint);
    }
    if let Some(name) = original_name
        .as_deref()
        .filter(|name| !filename_is_temporary_or_opaque(name))
    {
        return filename_with_extension_hint(name, extension_hint);
    }
    if let Some(extension) = mime_extension {
        return filename_with_extension_hint("descarga", Some(extension));
    }
    "descarga.bin".into()
}

pub(crate) fn resolve_extension_download_filename(
    original_url: &Url,
    final_url: &Url,
    extension_filename: Option<&str>,
    preferred: Option<&str>,
    disposition: Option<&str>,
    mime: Option<&str>,
    expected_extension: Option<&str>,
) -> String {
    let disposition_name = disposition.and_then(content_disposition_filename);
    let final_name = filename_from_url_candidate(final_url);
    let original_name = filename_from_url_candidate(original_url);
    let expected_extension = expected_extension
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let disposition_extension = disposition_name.as_deref().and_then(filename_extension);
    let final_extension = final_name.as_deref().and_then(filename_extension);
    let original_extension = original_name.as_deref().and_then(filename_extension);
    let final_query_extension = extension_from_url_query(final_url);
    let original_query_extension = extension_from_url_query(original_url);
    let extension_hint = expected_extension
        .filter(|value| !is_generic_binary_extension(value))
        .or_else(|| disposition_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| final_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| original_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| final_query_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| original_query_extension.filter(|value| !is_generic_binary_extension(value)))
        .or_else(|| mime.and_then(extension_from_mime))
        .or(expected_extension)
        .or(disposition_extension)
        .or(final_extension)
        .or(original_extension)
        .or(final_query_extension)
        .or(original_query_extension);
    if let Some(suggested) = extension_filename
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !filename_is_temporary_or_opaque(value))
    {
        return filename_with_extension_hint(suggested, extension_hint);
    }
    resolve_download_filename(original_url, final_url, preferred, disposition, mime)
}

pub(crate) fn filename_from_url(parsed: &Url, preferred: Option<String>) -> String {
    resolve_download_filename(parsed, parsed, preferred.as_deref(), None, None)
}
