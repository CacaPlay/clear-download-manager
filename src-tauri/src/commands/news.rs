use reqwest::header::{
    CONTENT_LENGTH, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, USER_AGENT,
};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const NEWS_FEED_URL: &str =
    "https://raw.githubusercontent.com/CacaPlay/clear-download-manager/main/news.json";
const RELEASE_API_BASE: &str =
    "https://api.github.com/repos/CacaPlay/clear-download-manager/releases/tags/v";
const MAX_NEWS_BYTES: u64 = 256 * 1024;
const MAX_RELEASE_BYTES: u64 = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteNewsFeedResponse {
    pub(crate) not_modified: bool,
    pub(crate) body: Option<String>,
    pub(crate) etag: Option<String>,
    pub(crate) last_modified: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseMetadataResponse {
    pub(crate) name: Option<String>,
    pub(crate) body: Option<String>,
    pub(crate) published_at: Option<String>,
    pub(crate) html_url: Option<String>,
}

fn bounded_header(value: Option<&reqwest::header::HeaderValue>, max: usize) -> Option<String> {
    value
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(max).collect())
}

fn response_size_is_safe(response: &reqwest::Response, max: u64) -> Result<(), String> {
    if let Some(length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > max {
            return Err("El recurso remoto excede el tamaño máximo permitido".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn fetch_remote_news_feed(
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<RemoteNewsFeedResponse, String> {
    let client = reqwest::Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("No se pudo preparar el feed de novedades: {error}"))?;
    let mut request = client
        .get(NEWS_FEED_URL)
        .header(USER_AGENT, "CacaTools-Desktop-News/0.45");
    if let Some(value) = etag.filter(|value| !value.trim().is_empty()) {
        request = request.header(IF_NONE_MATCH, value.chars().take(300).collect::<String>());
    }
    if let Some(value) = last_modified.filter(|value| !value.trim().is_empty()) {
        request = request.header(
            IF_MODIFIED_SINCE,
            value.chars().take(120).collect::<String>(),
        );
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("No se pudo consultar el feed de novedades: {error}"))?;
    let headers = response.headers().clone();
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(RemoteNewsFeedResponse {
            not_modified: true,
            body: None,
            etag: bounded_header(headers.get(ETAG), 300),
            last_modified: bounded_header(headers.get(LAST_MODIFIED), 120),
        });
    }
    if !response.status().is_success() {
        return Err(format!(
            "El feed de novedades respondió HTTP {}",
            response.status()
        ));
    }
    response_size_is_safe(&response, MAX_NEWS_BYTES)?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("No se pudo leer el feed de novedades: {error}"))?;
    if bytes.len() as u64 > MAX_NEWS_BYTES {
        return Err("El feed de novedades excede el tamaño máximo permitido".into());
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "El feed de novedades no está codificado como UTF-8".to_string())?;
    Ok(RemoteNewsFeedResponse {
        not_modified: false,
        body: Some(body),
        etag: bounded_header(headers.get(ETAG), 300),
        last_modified: bounded_header(headers.get(LAST_MODIFIED), 120),
    })
}

#[tauri::command]
pub(crate) async fn fetch_release_metadata(
    version: String,
) -> Result<Option<ReleaseMetadataResponse>, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty()
        || version.len() > 80
        || !version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err("La versión de release no es válida".into());
    }
    let client = reqwest::Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("No se pudo preparar metadata de release: {error}"))?;
    let response = client
        .get(format!("{RELEASE_API_BASE}{version}"))
        .header(USER_AGENT, "CacaTools-Desktop-Updater/0.45")
        .send()
        .await
        .map_err(|error| format!("No se pudo consultar metadata de release: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub Release respondió HTTP {}",
            response.status()
        ));
    }
    response_size_is_safe(&response, MAX_RELEASE_BYTES)?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("No se pudo leer metadata de release: {error}"))?;
    if bytes.len() as u64 > MAX_RELEASE_BYTES {
        return Err("La metadata de release excede el tamaño máximo permitido".into());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("La metadata de release no es JSON válido: {error}"))?;
    Ok(Some(ReleaseMetadataResponse {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(180).collect()),
        body: value
            .get("body")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(1200).collect()),
        published_at: value
            .get("published_at")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(80).collect()),
        html_url: value
            .get("html_url")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(500).collect()),
    }))
}
