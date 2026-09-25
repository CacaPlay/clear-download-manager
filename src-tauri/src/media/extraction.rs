use std::process::Output;

#[allow(clippy::too_many_arguments)]
pub(super) fn run_analysis_attempt<F>(
    binary: &std::path::Path,
    parsed: &Url,
    extractor_args: &str,
    session: &MediaSessionOptions,
    likely_playlist: bool,
    is_tiktok: bool,
    analysis_retries: &str,
    extractor_retries: &str,
    analysis_timeout: u64,
    should_cancel: F,
) -> Result<Output, String>
where
    F: Fn() -> bool,
{
    let mut command = background_command(binary);
    enable_available_js_runtime(&mut command);
    configure_extractor_attempt(&mut command, parsed, extractor_args);
    configure_session_arguments(&mut command, session);
    command
        .arg("--ignore-config")
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--socket-timeout")
        .arg(if is_tiktok { "15" } else { "10" })
        .arg("--retries")
        .arg(analysis_retries)
        .arg("--extractor-retries")
        .arg(extractor_retries);
    if likely_playlist {
        command
            .arg("--flat-playlist")
            .arg("--playlist-end")
            .arg("500");
    } else {
        command.arg("--no-playlist");
    }
    command.arg(parsed.as_str());
    command_output_with_timeout_cancelable_owned(
        &mut command,
        Duration::from_secs(analysis_timeout),
        "el análisis multimedia",
        should_cancel,
        None,
    )
}

pub(super) fn run_tiktok_embed_attempt<F>(
    binary: &std::path::Path,
    embed_source: &str,
    session: &MediaSessionOptions,
    should_cancel: F,
) -> Result<Output, String>
where
    F: Fn() -> bool,
{
    let mut command = background_command(binary);
    enable_available_js_runtime(&mut command);
    let embed_parsed = Url::parse(embed_source).map_err(|_| "URL de embed inválida".to_string())?;
    configure_extractor_attempt(&mut command, &embed_parsed, "");
    configure_session_arguments(&mut command, session);
    command
        .arg("--ignore-config")
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--socket-timeout")
        .arg("15")
        .arg("--retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg(embed_source);
    command_output_with_timeout_cancelable_owned(
        &mut command,
        Duration::from_secs(45),
        "el análisis multimedia alternativo",
        should_cancel,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_preview_attempt(
    binary: &std::path::Path,
    parsed: &Url,
    extractor_args: &str,
    socket_timeout: &str,
    retries: &str,
    extractor_retries: &str,
    timeout_seconds: u64,
    operation: Option<&Arc<WindowOperation>>,
) -> Result<Output, String> {
    let mut command = background_command(binary);
    enable_available_js_runtime(&mut command);
    configure_extractor_attempt(&mut command, parsed, extractor_args);
    command
        .arg("--ignore-config")
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--socket-timeout")
        .arg(socket_timeout)
        .arg("--retries")
        .arg(retries)
        .arg("--extractor-retries")
        .arg(extractor_retries)
        .arg("--format")
        .arg("bestvideo[ext=mp4][vcodec^=avc1][protocol^=http]+bestaudio[ext=m4a][protocol^=http]/bestvideo[ext=mp4][protocol^=http]+bestaudio[protocol^=http]/bestvideo[ext=mp4][vcodec^=avc1][protocol^=http]+bestaudio[protocol^=http]/best[ext=mp4][protocol^=http][vcodec!=none][acodec!=none]/best[ext=webm][protocol^=http][vcodec!=none][acodec!=none]/best[protocol^=http][vcodec!=none][acodec!=none]")
        .arg(parsed.as_str());
    command_output_with_timeout_cancelable_owned(
        &mut command,
        Duration::from_secs(timeout_seconds),
        "la vista previa multimedia",
        || false,
        operation,
    )
}
use std::sync::Arc;
use std::time::Duration;

use url::Url;

use super::{configure_extractor_attempt, configure_session_arguments, MediaSessionOptions};
use crate::{
    background_command, command_output_with_timeout_cancelable_owned, enable_available_js_runtime,
    WindowOperation,
};
