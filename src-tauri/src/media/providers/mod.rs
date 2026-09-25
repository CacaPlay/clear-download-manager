use url::Url;

mod http;
mod tiktok;
mod youtube;

pub(crate) use http::STANDARD_DOWNLOAD_PROFILES;
pub(crate) use tiktok::{
    configure_tiktok_command, normalize_tiktok_source_url, normalize_tiktok_source_value,
    tiktok_primary_format_selector, tiktok_same_resolution_format_fallback,
    TIKTOK_DOWNLOAD_PROFILES,
};
#[cfg(test)]
pub(crate) use youtube::youtube_pot_plugin_root_is_valid;
pub(crate) use youtube::{
    youtube_pot_plugin_dir, youtube_pot_provider_enabled, YOUTUBE_DOWNLOAD_PROFILES,
    YOUTUBE_POT_BASE_URL_ENV, YOUTUBE_POT_PROFILE, YOUTUBE_WEB_SAFARI_HLS_PROFILE,
    YOUTUBE_WEB_SAFARI_HLS_SELECTOR,
};

pub(crate) fn media_host_is(parsed: &Url, expected: &str) -> bool {
    parsed
        .host_str()
        .map(|host| {
            host.eq_ignore_ascii_case(expected)
                || host.to_ascii_lowercase().ends_with(&format!(".{expected}"))
        })
        .unwrap_or(false)
}

pub(crate) fn media_download_profiles(parsed: &Url) -> &'static [&'static str] {
    if media_host_is(parsed, "tiktok.com") {
        TIKTOK_DOWNLOAD_PROFILES
    } else if media_host_is(parsed, "youtube.com") || media_host_is(parsed, "youtu.be") {
        // Googlevideo URLs are short-lived and a client profile can be
        // rejected independently of the public page. Re-resolve with a
        // second client before reporting a hard 403 to the user.
        YOUTUBE_DOWNLOAD_PROFILES
    } else {
        STANDARD_DOWNLOAD_PROFILES
    }
}
