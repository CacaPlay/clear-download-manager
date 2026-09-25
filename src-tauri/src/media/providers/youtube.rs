use std::path::PathBuf;

use url::Url;

use super::media_host_is;

pub(crate) const YOUTUBE_DOWNLOAD_PROFILES: &[&str] = &[
    "",
    "youtube:player_client=web,android_vr",
    "youtube:player_client=tv_embedded",
    "youtube:player_client=android_vr,web",
    // Last-resort progressive fallback. Current YouTube GVS DASH URLs may
    // require a PO Token and return 403 after the first ranged block; mweb
    // still exposes a complete progressive MP4 that can finish reliably.
    "youtube:player_client=mweb",
];

pub(crate) const YOUTUBE_WEB_SAFARI_HLS_PROFILE: &str = "youtube:player_client=web_safari";
pub(crate) const YOUTUBE_WEB_SAFARI_HLS_SELECTOR: &str = "best[protocol*=m3u8]";
pub(crate) const YOUTUBE_POT_PROVIDER_ENV: &str = "CACATOOLS_YOUTUBE_POT_PROVIDER";
pub(crate) const YOUTUBE_POT_PLUGIN_DIR_ENV: &str = "CACATOOLS_YOUTUBE_POT_PLUGIN_DIR";
pub(crate) const YOUTUBE_POT_BASE_URL_ENV: &str = "CACATOOLS_YOUTUBE_POT_BASE_URL";
pub(crate) const YOUTUBE_POT_PROVIDER_NAME: &str = "bgutil-http";
pub(crate) const YOUTUBE_POT_PROFILE: &str = "youtube:player_client=mweb";

pub(crate) fn youtube_pot_plugin_root_is_valid(directory: &std::path::Path) -> bool {
    std::fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| entry.path().join("yt_dlp_plugins").is_dir())
}

pub(crate) fn youtube_pot_plugin_dir(parsed: &Url) -> Option<PathBuf> {
    if !(media_host_is(parsed, "youtube.com") || media_host_is(parsed, "youtu.be"))
        || !std::env::var(YOUTUBE_POT_PROVIDER_ENV)
            .map(|value| value.trim().eq_ignore_ascii_case(YOUTUBE_POT_PROVIDER_NAME))
            .unwrap_or(false)
    {
        return None;
    }
    let directory = std::env::var_os(YOUTUBE_POT_PLUGIN_DIR_ENV).map(PathBuf::from)?;
    // yt-dlp's --plugin-dirs scans package directories below the supplied
    // root. A direct `root/yt_dlp_plugins` layout is therefore not enough for
    // the PyInstaller binary; require `root/<package>/yt_dlp_plugins`.
    if !directory.is_absolute() || !youtube_pot_plugin_root_is_valid(&directory) {
        return None;
    }
    Some(directory)
}

pub(crate) fn youtube_pot_provider_enabled(parsed: &Url) -> bool {
    youtube_pot_plugin_dir(parsed).is_some()
}
