use url::Url;

pub(crate) fn is_supported_media_host(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    [
        "youtube.com",
        "youtu.be",
        "vimeo.com",
        "tiktok.com",
        "instagram.com",
        "pinterest.com",
        "pin.it",
        "x.com",
        "twitter.com",
        "facebook.com",
        "reddit.com",
        "v.redd.it",
        "soundcloud.com",
        "twitch.tv",
        "dailymotion.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

pub(crate) fn is_html_content_type_for_queue(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("text/html") || lower.contains("application/xhtml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_accepts_supported_media_hosts_only() {
        assert!(is_supported_media_host(
            &Url::parse("https://youtu.be/abc").unwrap()
        ));
        assert!(is_supported_media_host(
            &Url::parse("https://www.tiktok.com/@a/video/1").unwrap()
        ));
        assert!(!is_supported_media_host(
            &Url::parse("https://example.com/index.html").unwrap()
        ));
        assert!(!is_supported_media_host(
            &Url::parse("https://youtube.com.attacker.example/file").unwrap()
        ));
    }

    #[test]
    fn queue_html_content_type_is_classified_without_platform_assumptions() {
        assert!(is_html_content_type_for_queue("text/html; charset=utf-8"));
        assert!(is_html_content_type_for_queue("application/xhtml+xml"));
        assert!(!is_html_content_type_for_queue("application/octet-stream"));
        assert!(!is_html_content_type_for_queue("video/mp4"));
    }
}
