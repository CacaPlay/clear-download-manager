use std::process::Command;

use url::Url;

use super::media_host_is;

pub(crate) const TIKTOK_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

pub(crate) const TIKTOK_DOWNLOAD_PROFILES: &[&str] = &[
    "",
    "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;app_name=musical_ly;app_version=35.1.3;manifest_app_version=2023501030;aid=0",
    "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com;app_name=musical_ly;app_version=35.1.3;manifest_app_version=2023501030;aid=0",
];

pub(crate) fn normalize_tiktok_source_url(mut parsed: Url) -> Url {
    if media_host_is(&parsed, "tiktok.com") {
        parsed.set_query(None);
        parsed.set_fragment(None);
    }
    parsed
}

pub(crate) fn normalize_tiktok_source_value(value: &str) -> String {
    Url::parse(value)
        .map(normalize_tiktok_source_url)
        .map(|parsed| parsed.to_string())
        .unwrap_or_else(|_| value.to_string())
}

pub(crate) fn configure_tiktok_command(command: &mut Command, parsed: &Url) {
    if !media_host_is(parsed, "tiktok.com") {
        return;
    }
    let referer = normalize_tiktok_source_url(parsed.clone()).to_string();
    command
        .arg("--user-agent")
        .arg(TIKTOK_USER_AGENT)
        .arg("--referer")
        .arg(referer);
}

pub(crate) fn tiktok_primary_format_selector(selector: &str) -> Option<String> {
    let primary = selector.split('/').next()?.trim();
    if primary.is_empty()
        || primary.eq_ignore_ascii_case("best")
        || primary.contains('+')
        || primary.contains('[')
    {
        return None;
    }
    Some(primary.to_string())
}

pub(crate) fn tiktok_same_resolution_format_fallback(selector: &str) -> Option<String> {
    let primary = tiktok_primary_format_selector(selector)?;
    if let Some(prefix) = primary.strip_suffix("-0") {
        return Some(format!("{prefix}-1"));
    }
    if let Some(prefix) = primary.strip_suffix("-1") {
        return Some(format!("{prefix}-0"));
    }
    None
}
