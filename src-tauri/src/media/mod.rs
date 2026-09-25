#![allow(clippy::invisible_characters)]

use super::*;
use crate::progress::adapter::{
    shadow_pause_playlist, shadow_resume_playlist, shadow_retry_playlist,
};
use crate::progress::model::JobPhase;
use crate::progress::playlist::PlaylistItemSeed;
use reqwest::blocking::Client;

mod analysis;
mod download;
mod extraction;
mod formats;
mod matching;
mod metadata;
mod models;
mod player;
mod playlist;
mod preview;
mod providers;
mod queue;
mod recovery;
mod resolver;
mod search;
mod session;

pub(crate) use analysis::{
    analyze_media_url, analyze_media_url_with_session, analyze_media_url_with_session_for_window,
    analyze_media_url_with_session_options,
};
pub(crate) use download::*;
pub(crate) use formats::*;
pub(crate) use matching::{
    duration_similarity, match_reasons, title_similarity, token_similarity, MediaSearchResult,
};
pub(crate) use metadata::{
    duration_label, first_string, json_exposes_reproducible_stream, safe_remote_thumbnail_url,
    thumbnail_from, youtube_thumbnail_for_source, youtube_thumbnail_from_id,
};
pub(crate) use models::{
    MediaAnalysisSnapshot, MediaFormatSnapshot, MediaItemSnapshot, PlayerMediaSnapshot,
    PlayerOnlineEmbedSnapshot, PlayerOnlinePreviewSnapshot, PlayerOnlineQualitySnapshot,
    PlayerPlaylistQueueItem, PlayerPlaylistQueueSnapshot, PlayerStreamTechnicalSnapshot,
    PlayerTechnicalSnapshot,
};
pub(crate) use player::{
    open_media_player, open_online_media_player, open_playlist_media_player, player_media_snapshot,
    player_playlist_queue_snapshot, player_resize_for_media, player_start_dragging,
    player_window_action,
};
pub(crate) use player::{player_number, player_u32};
pub(crate) use playlist::{
    playlist_runtime_snapshot, queue_playlist_selection, replace_playlist_item_with_alternative,
    retry_failed_playlist_items, set_playlist_batch_paused,
};
pub(crate) use preview::{player_online_preview_snapshot_with_operation, resolve_online_embed};
pub(crate) use preview::{player_preview_audio_entry, player_preview_selected_entry};
pub(crate) use providers::{
    configure_tiktok_command, media_download_profiles, media_host_is, normalize_tiktok_source_url,
    normalize_tiktok_source_value, tiktok_primary_format_selector,
    tiktok_same_resolution_format_fallback, youtube_pot_plugin_dir, youtube_pot_provider_enabled,
    YOUTUBE_POT_BASE_URL_ENV, YOUTUBE_POT_PROFILE, YOUTUBE_WEB_SAFARI_HLS_PROFILE,
    YOUTUBE_WEB_SAFARI_HLS_SELECTOR,
};
pub(crate) use queue::{
    choose_media_cookies_file, queue_media_download, queue_media_download_named,
    queue_media_download_secure, MediaQueueReceipt,
};
pub(crate) use recovery::{
    failure_diagnosis, recover_media_source, FailureDiagnosisSnapshot, MediaRecoveryRequest,
    MediaRecoverySnapshot,
};
pub(crate) use resolver::media_extraction_profiles;
pub(crate) use search::search_media_internal;
pub(crate) use search::{
    search_media_by_title, search_media_by_title_page, search_video_suggestions,
    search_video_suggestions_page,
};
pub(crate) use session::{
    media_session_settings, save_media_session_settings, saved_media_session_for_db,
    validate_media_session_options, validate_netscape_cookie_file, MediaSessionOptions,
    MediaSessionSettingsSnapshot,
};

#[cfg(test)]
pub(crate) use download::{
    duration_needs_normalization, minimum_acceptable_duration, newest_completed_media,
};
#[cfg(test)]
pub(crate) use player::online_player_query;
#[cfg(test)]
pub(crate) use player::output_mode_conversion_state;
#[cfg(test)]
pub(crate) use preview::{
    player_preview_max_height, player_preview_progressive_entry, player_preview_qualities,
    player_preview_quality_limited, player_preview_technical,
};
#[cfg(test)]
pub(crate) use providers::youtube_pot_plugin_root_is_valid;

pub(crate) fn media_job_batch(db_path: &Path, id: i64) -> Option<i64> {
    Connection::open(db_path)
        .ok()?
        .query_row(
            "SELECT playlist_batch_id FROM media_jobs WHERE job_id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn media_playlist_seeds(db_path: &Path, batch_id: i64) -> Vec<PlaylistItemSeed> {
    let Ok(connection) = Connection::open(db_path) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT id,COALESCE(job_id,0),COALESCE(source_id,''),position,COALESCE(title,''),status FROM playlist_items WHERE batch_id=?1 ORDER BY position",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map(params![batch_id], |row| {
        let status = row.get::<_, String>(5)?;
        Ok(PlaylistItemSeed {
            item_id: row.get(0)?,
            job_id: row.get(1)?,
            source_id: row.get(2)?,
            position: row.get::<_, i64>(3)?.max(0) as usize,
            title: row.get(4)?,
            state: playlist_item_phase(&status),
        })
    }) else {
        return Vec::new();
    };
    rows.flatten().filter(|seed| seed.job_id > 0).collect()
}

fn playlist_item_phase(status: &str) -> JobPhase {
    match status.trim().to_ascii_lowercase().as_str() {
        "running" | "downloading" => JobPhase::Downloading,
        "preparing" | "resolving" => JobPhase::Preparing,
        "processing" | "postprocessing" => JobPhase::PostProcessing,
        "paused" => JobPhase::Paused,
        "completed" => JobPhase::Completed,
        "failed" => JobPhase::Failed,
        "cancelled" | "canceled" => JobPhase::Cancelled,
        "cancelling" | "canceling" => JobPhase::Cancelling,
        _ => JobPhase::Queued,
    }
}

pub(crate) fn fail_media_job(db_path: &Path, id: i64, message: &str) {
    if let Ok(connection) = Connection::open(db_path) {
        let display_message = sanitize_media_error_for_display(message);
        let lower = display_message.to_ascii_lowercase();
        let (display_detail, resolution_state) = if matches!(
            classify_media_process_error(&display_message),
            MediaFailureClass::Captcha
        ) {
            (
                "Intervención Requerida · completa la verificación de la plataforma y vuelve a intentar".to_string(),
                "intervention_required",
            )
        } else if lower.contains("geo")
            || lower.contains("country")
            || lower.contains("region")
            || lower.contains("ubicación")
        {
            (
                "Bloqueo Regional · la plataforma limita este contenido en tu región".to_string(),
                "region_restricted",
            )
        } else if matches!(
            classify_media_process_error(&display_message),
            MediaFailureClass::Forbidden
        ) {
            (
                "Sesión Requerida · el origen rechazó la solicitud o requiere autorización"
                    .to_string(),
                "session_required",
            )
        } else if matches!(
            classify_media_process_error(&display_message),
            MediaFailureClass::TooManyRequests
        ) {
            (
                "Límite Temporal · el servidor recibió demasiadas solicitudes".to_string(),
                "rate_limited",
            )
        } else {
            (display_message, "failed")
        };
        let _ = connection.execute(
            "UPDATE jobs SET status='failed', detail=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![&display_detail, id],
        );
        let _ = connection.execute(
            "UPDATE media_jobs SET error=?1, updated_at=CURRENT_TIMESTAMP WHERE job_id=?2",
            params![&display_detail, id],
        );
        let _ = connection.execute(
            "UPDATE media_jobs SET resolution_state=?1 WHERE job_id=?2",
            params![resolution_state, id],
        );
        let _ = connection.execute(
            "UPDATE playlist_items SET status='failed',resolution_state=?1,last_error=?2 WHERE job_id=?3",
            params![resolution_state, &display_detail, id],
        );
    }
}

pub(crate) fn json_number_as_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|entry| {
        entry
            .as_u64()
            .or_else(|| {
                entry
                    .as_f64()
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(|number| number as u64)
            })
            .or_else(|| {
                entry
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(|number| number as u64)
            })
    })
}

pub(crate) fn json_number_as_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|entry| {
        entry
            .as_f64()
            .or_else(|| {
                entry
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
            .filter(|number| number.is_finite() && *number >= 0.0)
    })
}

fn parse_positive_u64(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("NA") || value.eq_ignore_ascii_case("none") {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(|number| number as u64)
}

pub(crate) fn next_playlist_job(connection: &Connection, batch_id: i64) -> Option<i64> {
    let mut statement = connection
        .prepare(
            "SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status='queued' AND job_id IS NOT NULL ORDER BY position",
        )
        .ok()?;
    let rows = statement
        .query_map(params![batch_id], |row| row.get::<_, i64>(0))
        .ok()?;
    let candidate = rows.flatten().find(|job_id| {
        !crate::job_uses_legacy_removed_provider(connection, *job_id).unwrap_or(true)
    });
    drop(statement);
    candidate
}

pub(crate) fn start_playlist_jobs(
    db_path: &Path,
    runtime: &MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    batch_id: i64,
) {
    let Ok(connection) = Connection::open(db_path) else {
        return;
    };
    let running: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM playlist_items WHERE batch_id=?1 AND status='running'",
            params![batch_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    // The global multimedia dispatcher owns the actual execution slot. Keep
    // playlist selection sequential here so queued items remain visibly queued
    // until the dispatcher atomically claims them.
    if running > 0 {
        return;
    }
    let Some(job_id) = next_playlist_job(&connection, batch_id) else {
        return;
    };
    drop(connection);
    {
        run_media_worker(
            db_path.to_path_buf(),
            runtime.clone(),
            active.clone(),
            external_processes.clone(),
            job_id,
        );
    }
}

pub(crate) fn advance_playlist_batch(
    db_path: &Path,
    runtime: &MediaRuntimePaths,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    external_processes: ExternalProcessRegistry,
    batch_id: i64,
) {
    let Ok(connection) = Connection::open(db_path) else {
        return;
    };
    let batch_status = connection
        .query_row(
            "SELECT status FROM playlist_batches WHERE id=?1",
            params![batch_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "failed".to_string());
    if matches!(batch_status.as_str(), "paused" | "cancelled") {
        return;
    }
    let running: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM playlist_items WHERE batch_id=?1 AND status='running'",
            params![batch_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let queued: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM playlist_items WHERE batch_id=?1 AND status='queued'",
            params![batch_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if queued > 0 && running == 0 {
        drop(connection);
        start_playlist_jobs(db_path, runtime, active, external_processes, batch_id);
    } else if running == 0 {
        let retryable_jobs = {
            let mut statement = match connection.prepare(
                "SELECT pi.job_id,COALESCE(pi.last_error,''),COALESCE(pi.provider_id,'') FROM playlist_items pi WHERE pi.batch_id=?1 AND pi.status='failed' AND pi.job_id IS NOT NULL AND COALESCE(pi.automatic_retries,0)<1 ORDER BY pi.position",
            ) {
                Ok(statement) => statement,
                Err(_) => return,
            };
            let rows = match statement.query_map(params![batch_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }) {
                Ok(rows) => rows,
                Err(_) => return,
            };
            rows.flatten()
                .filter(|(job_id, _, _)| {
                    !crate::job_uses_legacy_removed_provider(&connection, *job_id).unwrap_or(true)
                })
                .filter(|(_, error, provider)| {
                    let diagnosis: FailureDiagnosisSnapshot = failure_diagnosis(error, provider);
                    diagnosis.retryable && diagnosis.likely_temporary
                })
                .map(|(job_id, _, _)| job_id)
                .collect::<Vec<_>>()
        };
        if !retryable_jobs.is_empty() {
            for job_id in &retryable_jobs {
                let _ = connection.execute(
                    "UPDATE jobs SET status='queued',progress=0,detail='Reintento automático de playlist…',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![job_id],
                );
                let _ = connection.execute(
                    "UPDATE media_jobs SET error=NULL,output_path=NULL,resolution_state='download_queued',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                    params![job_id],
                );
                let _ = connection.execute(
                    "UPDATE playlist_items SET status='queued',progress=0,output_path=NULL,last_error=NULL,resolution_state='download_queued',automatic_retries=automatic_retries+1 WHERE job_id=?1",
                    params![job_id],
                );
            }
            let _ = connection.execute(
                "UPDATE playlist_batches SET status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![batch_id],
            );
            drop(connection);
            start_playlist_jobs(db_path, runtime, active, external_processes, batch_id);
            return;
        }
        let failed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM playlist_items WHERE batch_id=?1 AND status='failed'",
                params![batch_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let status = if failed > 0 {
            "completed_with_errors"
        } else {
            "completed"
        };
        let _ = connection.execute(
            "UPDATE playlist_batches SET status=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![status, batch_id],
        );
    }
}

pub(crate) fn media_runtime_status(state: State<'_, LocalState>) -> MediaRuntimeSnapshot {
    match &state.media_runtime {
        Some(runtime) => {
            let ffmpeg = runtime.ffmpeg_dir.join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
            let ffprobe = runtime.ffmpeg_dir.join(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            });
            let yt_dlp_version = runtime_binary_version(&runtime.yt_dlp, "--version");
            let ffmpeg_version = runtime_binary_version(&ffmpeg, "-version");
            let ffprobe_version = runtime_binary_version(&ffprobe, "-version");
            let yt_dlp_available = runtime.yt_dlp.is_file() || !yt_dlp_version.is_empty();
            let ffmpeg_available = ffmpeg.is_file() || !ffmpeg_version.is_empty();
            let ffprobe_available = ffprobe.is_file() || !ffprobe_version.is_empty();
            MediaRuntimeSnapshot {
                available: true,
                yt_dlp: yt_dlp_available,
                yt_dlp_version,
                ffmpeg: ffmpeg_available,
                ffmpeg_version,
                ffprobe: ffprobe_available,
                ffprobe_version,
                detail: "Motor multimedia local disponible".into(),
            }
        }
        None => MediaRuntimeSnapshot {
            available: false,
            yt_dlp: false,
            yt_dlp_version: String::new(),
            ffmpeg: false,
            ffmpeg_version: String::new(),
            ffprobe: false,
            ffprobe_version: String::new(),
            detail: "Faltan los binarios locales de yt-dlp, FFmpeg o FFprobe".into(),
        },
    }
}

fn media_metadata_quality(value: &Value) -> (u32, u32, u32, u32) {
    let Some(entries) = value.get("formats").and_then(Value::as_array) else {
        return (0, 0, 0, 0);
    };
    let mut max_height = 0_u32;
    let mut adaptive_video = 0_u32;
    let mut playable_video = 0_u32;
    for entry in entries {
        if first_string(entry, &["vcodec"]) == "none" {
            continue;
        }
        let Some(height) = entry
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
        else {
            continue;
        };
        max_height = max_height.max(height);
        if first_string(entry, &["acodec"]) == "none" {
            adaptive_video += 1;
        }
        let url = first_string(entry, &["url"]);
        if Url::parse(&url)
            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
            .unwrap_or(false)
        {
            playable_video += 1;
        }
    }
    (
        max_height,
        adaptive_video,
        playable_video,
        u32::try_from(entries.len()).unwrap_or(u32::MAX),
    )
}

fn tiktok_embed_source_url(parsed: &Url) -> Option<String> {
    tiktok_video_id(parsed).map(|id| format!("https://www.tiktok.com/embed/v2/{id}"))
}

fn media_metadata_needs_quality_fallback(value: &Value) -> bool {
    let (max_height, adaptive_video, _, _) = media_metadata_quality(value);
    max_height < 1080 || adaptive_video == 0
}

fn retain_richer_media_metadata(current: &mut Option<Value>, candidate: Value) {
    let should_replace = current
        .as_ref()
        .map(|value| media_metadata_quality(&candidate) > media_metadata_quality(value))
        .unwrap_or(true);
    if should_replace {
        *current = Some(candidate);
    }
}

fn is_youtube_web_safari_hls_attempt(parsed: &Url, extractor_args: &str) -> bool {
    (media_host_is(parsed, "youtube.com") || media_host_is(parsed, "youtu.be"))
        && extractor_args == YOUTUBE_WEB_SAFARI_HLS_PROFILE
}

fn use_ffmpeg_network_downloader(
    safari_hls_attempt: bool,
    bandwidth_policy: &crate::downloads::BandwidthPolicy,
) -> bool {
    safari_hls_attempt && bandwidth_policy.allows_ffmpeg_network_downloader()
}

fn configure_extractor_attempt(command: &mut Command, parsed: &Url, extractor_args: &str) {
    configure_tiktok_command(command, parsed);
    if let Some(plugin_dir) = youtube_pot_plugin_dir(parsed) {
        command.arg("--plugin-dirs").arg(plugin_dir);
        let base_url = std::env::var(YOUTUBE_POT_BASE_URL_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:4416".into());
        command
            .arg("--extractor-args")
            .arg(format!("youtubepot-bgutilhttp:base_url={base_url}"));
    }
    if !extractor_args.is_empty() {
        command.arg("--extractor-args").arg(extractor_args);
    }
}

fn configure_session_arguments(command: &mut Command, session: &MediaSessionOptions) {
    if session.use_brave_cookies {
        command.args(["--cookies-from-browser", "brave"]);
    } else if let Some(path) = session.cookies_path.as_deref() {
        command.arg("--cookies").arg(path);
    }
}

fn windows_mp4_selector(requested: &str) -> String {
    let height = requested
        .split("height<=")
        .nth(1)
        .and_then(|value| {
            value
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .ok()
        })
        .filter(|value| (144..=2160).contains(value));
    match height {
        Some(height) => {
            format!("bv*[ext=mp4][height<={height}]+ba[ext=m4a]/b[ext=mp4][height<={height}]")
        }
        None => "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]".into(),
    }
}

fn media_format_selector(
    parsed_source: &Url,
    selector: &str,
    output_mode: &str,
    extractor_args: &str,
) -> String {
    if is_youtube_web_safari_hls_attempt(parsed_source, extractor_args) {
        selector.to_string()
    } else if media_host_is(parsed_source, "tiktok.com") && output_mode == "video_mp4" {
        tiktok_primary_format_selector(selector).unwrap_or_else(|| windows_mp4_selector(selector))
    } else if (media_host_is(parsed_source, "pinterest.com")
        || media_host_is(parsed_source, "pin.it"))
        && output_mode == "video_mp4"
    {
        // Pinterest exposes provider-specific HLS ids (video-only plus an
        // audio stream). Replacing them with the generic Windows MP4 selector
        // removes every available format and causes yt-dlp to fail with
        // "Requested format is not available".
        selector.to_string()
    } else if output_mode == "video_mp4" {
        windows_mp4_selector(selector)
    } else {
        selector.to_string()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MediaFailureClass {
    Forbidden,
    TooManyRequests,
    Captcha,
    Other,
}

fn classify_media_process_error(message: &str) -> MediaFailureClass {
    let lower = message.to_ascii_lowercase();
    if lower.contains("captcha")
        || lower.contains("verify you are human")
        || lower.contains("unusual traffic")
        || lower.contains("robot check")
        || lower.contains("challenge required")
    {
        MediaFailureClass::Captcha
    } else if lower.contains("429")
        || lower.contains("too many requests")
        || lower.contains("rate limit")
    {
        MediaFailureClass::TooManyRequests
    } else if lower.contains("403")
        || lower.contains("forbidden")
        || lower.contains("signature expired")
        || lower.contains("url_expired")
    {
        MediaFailureClass::Forbidden
    } else {
        MediaFailureClass::Other
    }
}

const SANITIZED_EXTRACTOR_ERROR: &str =
    "yt-dlp encontró un error interno del extractor. Probablemente se resuelve con la próxima actualización de yt-dlp; si persiste tras actualizar, repórtalo.";

fn sanitize_media_error_message(raw: &str) -> String {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let line_count = trimmed.lines().count();
    let file_frame_count = trimmed
        .lines()
        .filter(|line| {
            line.contains("File \"") || line.contains("File '") || line.contains("file \"")
        })
        .count();
    let has_traceback = lower.contains("traceback (most recent call last)");
    let has_postprocessing_stack =
        lower.contains("error: postprocessing:") && (line_count > 3 || file_frame_count > 0);
    let has_multiline_file_trace = line_count > 3 && file_frame_count > 0;

    if has_traceback || has_postprocessing_stack || has_multiline_file_trace {
        SANITIZED_EXTRACTOR_ERROR.to_string()
    } else {
        raw.to_string()
    }
}

pub(crate) fn sanitize_media_error_for_display(raw: &str) -> String {
    let sanitized = sanitize_media_error_message(raw);
    if sanitized != raw {
        eprintln!("CacaTools raw yt-dlp error: {}", raw.trim());
    }
    sanitized
}

fn media_info_json_missing_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let references_info_json = lower.contains("load-info-json") || lower.contains("info_json");
    let missing_file = lower.contains("not found")
        || lower.contains("no such file")
        || lower.contains("does not exist")
        || lower.contains("cannot open")
        || lower.contains("could not open")
        || lower.contains("file not found");
    references_info_json && missing_file
}

fn should_retry_without_info_json(info_json: Option<&Path>, message: &str) -> bool {
    info_json.is_some() && media_info_json_missing_error(message)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MediaPreviewBudget {
    retries: &'static str,
    extractor_retries: &'static str,
    socket_timeout: &'static str,
    timeout_seconds: u64,
}

fn media_preview_budget(parsed: &Url) -> MediaPreviewBudget {
    let is_tiktok = media_host_is(parsed, "tiktok.com");
    let is_extended_budget_host =
        is_tiktok || media_host_is(parsed, "youtube.com") || media_host_is(parsed, "youtu.be");
    if is_extended_budget_host {
        MediaPreviewBudget {
            retries: "3",
            extractor_retries: "3",
            socket_timeout: "15",
            timeout_seconds: 45,
        }
    } else {
        MediaPreviewBudget {
            retries: "1",
            extractor_retries: "1",
            socket_timeout: "10",
            timeout_seconds: 30,
        }
    }
}

fn refreshed_media_info_paths(work_dir: &Path, id: i64, nonce: u128) -> (PathBuf, PathBuf) {
    (
        work_dir.join(format!("refresh-{id}-{nonce}.info.json")),
        work_dir.join(format!(".refresh-{id}-{nonce}.tmp")),
    )
}

fn is_browser_cookie_copy_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    (lower.contains("could not copy") || lower.contains("failed to copy"))
        && (lower.contains("cookie")
            || lower.contains("chrome")
            || lower.contains("brave")
            || lower.contains("browser"))
}

fn media_backoff_delay(attempt: &mut usize) -> Option<Duration> {
    if *attempt >= 3 {
        return None;
    }
    let seconds = 2_u64.saturating_pow((*attempt + 1) as u32);
    *attempt += 1;
    Some(Duration::from_secs(seconds))
}

fn cooperative_media_sleep(connection: &Connection, id: i64, delay: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < delay {
        let stopped = connection
            .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                row.get::<_, String>(0)
            })
            .map(|status| matches!(status.as_str(), "paused" | "cancelled"))
            .unwrap_or(true);
        if stopped {
            return false;
        }
        let remaining = delay.saturating_sub(started.elapsed());
        tauri::async_runtime::block_on(tokio::time::sleep(
            remaining.min(Duration::from_millis(250)),
        ));
    }
    true
}

fn persist_media_backoff(connection: &Connection, id: i64, delay: Duration) {
    let _ = connection.execute(
        "UPDATE jobs SET detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='running'",
        params![
            format!(
                "Límite temporal del servidor · reintentando en {} s…",
                delay.as_secs()
            ),
            id
        ],
    );
}

fn persist_media_intervention_required(connection: &Connection, id: i64) {
    let detail =
        "Intervención Requerida · completa la verificación de la plataforma y vuelve a intentar";
    let _ = connection.execute(
        "UPDATE jobs SET detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2",
        params![detail, id],
    );
    let _ = connection.execute(
        "UPDATE media_jobs SET resolution_state='intervention_required',updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
        params![id],
    );
}

fn media_partial_exists(directory: &Path) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && media_partial_exists(&path) {
            return true;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if name.ends_with(".part") || name.ends_with(".aria2") || name.ends_with(".ytdl") {
            return true;
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn refresh_media_info(
    runtime: &MediaRuntimePaths,
    parsed_source: &Url,
    source_url: &str,
    selector: &str,
    work_dir: &Path,
    id: i64,
    connection: &Connection,
    session: &MediaSessionOptions,
) -> Result<PathBuf, String> {
    let mut command = background_command(&runtime.yt_dlp);
    enable_available_js_runtime(&mut command);
    configure_tiktok_command(&mut command, parsed_source);
    configure_session_arguments(&mut command, session);
    command
        .arg("--ignore-config")
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--format")
        .arg(selector)
        .arg("--socket-timeout")
        .arg("20")
        .arg("--retries")
        .arg("1")
        .arg("--extractor-retries")
        .arg("1")
        .arg(source_url);
    let output = super::command_output_with_timeout_cancelable(
        &mut command,
        Duration::from_secs(90),
        "la renovación del enlace multimedia",
        || {
            connection
                .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                    row.get::<_, String>(0)
                })
                .map(|status| matches!(status.as_str(), "paused" | "cancelled"))
                .unwrap_or(true)
        },
    )?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(600)
            .collect::<String>();
        return Err(if detail.is_empty() {
            "yt-dlp no devolvió metadata renovada".into()
        } else {
            detail
        });
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("La metadata renovada no es JSON válido: {error}"))?;
    let has_stream_url = value
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"))
        || value
            .get("requested_formats")
            .and_then(Value::as_array)
            .is_some_and(|formats| {
                formats.iter().any(|format| {
                    format
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| {
                            url.starts_with("http://") || url.starts_with("https://")
                        })
                })
            });
    if !has_stream_url {
        return Err("yt-dlp no entregó una URL de flujo renovada".into());
    }
    fs::create_dir_all(work_dir).map_err(|error| error.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let (path, temporary_path) = refreshed_media_info_paths(work_dir, id, nonce);
    fs::write(&temporary_path, &output.stdout)
        .map_err(|error| format!("No se pudo guardar la metadata temporal renovada: {error}"))?;
    fs::rename(&temporary_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("No se pudo confirmar la metadata temporal renovada: {error}")
    })?;
    Ok(path)
}

#[allow(clippy::too_many_arguments)]
fn build_media_download_command(
    runtime: &MediaRuntimePaths,
    parsed_source: &Url,
    source_url: &str,
    selector: &str,
    output_mode: &str,
    work_dir: &Path,
    output_template: &str,
    extractor_args: &str,
    force_mp4_remux: bool,
    session: &MediaSessionOptions,
    info_json: Option<&Path>,
    bandwidth_policy: &crate::downloads::BandwidthPolicy,
) -> Command {
    let mut command = background_command(&runtime.yt_dlp);
    let format_selector =
        media_format_selector(parsed_source, selector, output_mode, extractor_args);
    enable_available_js_runtime(&mut command);
    configure_tiktok_command(&mut command, parsed_source);
    configure_extractor_attempt(&mut command, parsed_source, extractor_args);
    configure_session_arguments(&mut command, session);
    command
        .arg("--ignore-config")
        .arg("--newline")
        .arg("--progress")
        .arg("--progress-delta")
        .arg("0.25")
        .arg("--concurrent-fragments")
        .arg("4")
        .arg("--extractor-retries")
        .arg("5")
        .arg("--no-warnings")
        .arg("--continue")
        .arg("--retries")
        .arg("10")
        .arg("--fragment-retries")
        .arg("10")
        .arg("--file-access-retries")
        .arg("5")
        .arg("--socket-timeout")
        .arg("30")
        .arg("--retry-sleep")
        .arg("http:exp=1:20")
        .arg("--retry-sleep")
        .arg("fragment:exp=1:20")
        .arg("--retry-sleep")
        .arg("extractor:exp=1:10")
        .arg("--part")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--no-overwrites")
        .arg("--no-mtime")
        .arg("--embed-metadata")
        .arg("--ffmpeg-location")
        .arg(&runtime.ffmpeg_dir)
        .arg("--paths")
        .arg(work_dir)
        .arg("--output")
        .arg(output_template)
        .arg("--progress-template")
        .arg("download:CACATOOLS_PROGRESS:%(progress)j")
        .arg("--print")
        .arg("before_dl:CACATOOLS_MEDIA_ID:%(id)s")
        .arg("--print")
        .arg("before_dl:CACATOOLS_EXPECTED_DURATION:%(duration)s")
        .arg("--print")
        .arg("after_move:CACATOOLS_FILE:%(filepath)s")
        .arg("--print")
        .arg("after_video:CACATOOLS_FILE:%(filepath)s")
        .arg("--print")
        .arg("before_dl:CACATOOLS_PLAN:%(requested_formats.0.format_id)s|%(requested_formats.0.vcodec)s|%(requested_formats.0.acodec)s|%(requested_formats.0.filesize)s|%(requested_formats.0.filesize_approx)s|%(requested_formats.1.format_id)s|%(requested_formats.1.vcodec)s|%(requested_formats.1.acodec)s|%(requested_formats.1.filesize)s|%(requested_formats.1.filesize_approx)s|%(requested_formats.2.format_id)s|%(requested_formats.2.vcodec)s|%(requested_formats.2.acodec)s|%(requested_formats.2.filesize)s|%(requested_formats.2.filesize_approx)s|%(requested_formats.3.format_id)s|%(requested_formats.3.vcodec)s|%(requested_formats.3.acodec)s|%(requested_formats.3.filesize)s|%(requested_formats.3.filesize_approx)s")
        .arg("--format")
        .arg(format_selector);
    bandwidth_policy.apply_to_yt_dlp(&mut command);
    if use_ffmpeg_network_downloader(
        is_youtube_web_safari_hls_attempt(parsed_source, extractor_args),
        bandwidth_policy,
    ) {
        command.args(["--downloader", "ffmpeg"]);
    }
    match output_mode {
        "audio_mp3" => {
            command.args([
                "--extract-audio",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "320K",
            ]);
        }
        "audio_m4a" => {
            command.args([
                "--extract-audio",
                "--audio-format",
                "m4a",
                "--audio-quality",
                "0",
            ]);
        }
        "audio_flac" | "audio_flac_hires" | "audio_flac_max" => {
            command.args(["--extract-audio", "--audio-format", "flac"]);
        }
        "audio_best" => {}
        "video_webm" => {
            command.args(["--merge-output-format", "webm"]);
        }
        "source" => {}
        _ => {
            command.args(["--merge-output-format", "mp4"]);
        }
    }
    if force_mp4_remux {
        // The public HTML5 embed can be exposed by yt-dlp as two duplicate
        // playlist entries. A single URL must never enqueue two files.
        command.arg("--playlist-items").arg("1");
    }
    if force_mp4_remux && output_mode == "video_mp4" {
        command.args(["--remux-video", "mp4"]);
    }
    if let Some(info_json) = info_json {
        command.arg("--load-info-json").arg(info_json);
    } else {
        command.arg(source_url);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

fn media_path_segment_after(parsed: &Url, marker: &str) -> Option<String> {
    let segments = parsed.path_segments()?.collect::<Vec<_>>();
    segments
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case(marker) && !pair[1].is_empty())
        .map(|pair| pair[1].trim().to_string())
}

fn tiktok_video_id(parsed: &Url) -> Option<String> {
    media_path_segment_after(parsed, "video")
        .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
}

fn youtube_preview_thumbnail(parsed: &Url) -> String {
    let host = parsed.host_str().unwrap_or_default();
    let id = if host.eq_ignore_ascii_case("youtu.be") {
        parsed
            .path_segments()
            .and_then(|mut segments| segments.find(|segment| !segment.is_empty()))
            .unwrap_or_default()
            .to_string()
    } else {
        parsed
            .query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value.to_string())
            .or_else(|| {
                let parts = parsed.path_segments()?.collect::<Vec<_>>();
                match parts.first().copied() {
                    Some("shorts") | Some("embed") | Some("live") => {
                        parts.get(1).map(|value| (*value).to_string())
                    }
                    _ => None,
                }
            })
            .unwrap_or_default()
    };
    if id.len() == 11
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")
    } else {
        String::new()
    }
}

fn instagram_post_id(parsed: &Url) -> Option<String> {
    ["p", "reel", "reels", "tv"]
        .iter()
        .find_map(|marker| media_path_segment_after(parsed, marker))
        .filter(|value| !value.contains('/') && !value.is_empty())
}

fn pinterest_pin_id(parsed: &Url) -> Option<String> {
    media_path_segment_after(parsed, "pin").filter(|value| {
        !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
    })
}

fn resolve_pinterest_short_link(start: &Url) -> Result<Url, String> {
    let client = Client::builder()
        .dns_resolver(crate::public_dns_resolver())
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("CacaTools-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("No se pudo preparar el resolvedor de Pinterest: {error}"))?;
    let mut current = start.clone();
    for _ in 0..8 {
        ensure_public_network_resolution(&current)?;
        let response = client
            .get(current.as_str())
            .send()
            .map_err(|error| format!("Pinterest no pudo resolver el enlace corto: {error}"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Pinterest devolvió una redirección sin destino".to_string())?;
            let next = current
                .join(location)
                .map_err(|error| format!("La redirección de Pinterest no es válida: {error}"))?;
            current = parse_public_http_url(
                next.as_str(),
                "La redirección de Pinterest no es un enlace HTTP válido",
            )?;
            continue;
        }
        return Ok(current);
    }
    Err("Pinterest encadenó demasiadas redirecciones".into())
}

#[cfg(test)]
mod online_embed_tests {
    use super::*;

    #[test]
    fn online_media_defaults_to_internal_player_route() {
        let source = "https://youtu.be/Lg2UXs9SDx4";
        let query = online_player_query(source);
        let app_route = format!("app-ui/player/index.html?{query}");
        assert!(app_route.starts_with("app-ui/player/index.html?"));
        assert!(app_route.contains("preview=https%3A%2F%2Fyoutu.be%2FLg2UXs9SDx4"));
        assert!(!app_route.contains("official=1"));
        assert!(!app_route.contains("open_external_url"));
    }

    #[test]
    fn limited_bandwidth_prevents_ffmpeg_network_downloader_bypass() {
        let limited = crate::downloads::BandwidthPolicy::try_from(
            crate::downloads::BandwidthSettings::Limited {
                bytes_per_second: 1_000_000,
            },
        )
        .unwrap();
        assert!(!use_ffmpeg_network_downloader(true, &limited));
        assert!(use_ffmpeg_network_downloader(
            true,
            &crate::downloads::BandwidthPolicy::Unlimited
        ));
        assert!(!use_ffmpeg_network_downloader(false, &limited));
    }

    #[test]
    fn bgutil_plugin_root_requires_a_named_package_directory() {
        let root = std::env::temp_dir().join(format!(
            "cacatools-bgutil-layout-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("yt_dlp_plugins")).unwrap();
        assert!(!youtube_pot_plugin_root_is_valid(&root));
        std::fs::create_dir_all(root.join("bgutil-ytdlp-pot-provider/yt_dlp_plugins")).unwrap();
        assert!(youtube_pot_plugin_root_is_valid(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_tiktok_video_id_from_public_path() {
        let parsed = Url::parse(
            "https://www.tiktok.com/@creator/video/7667965748597329174?is_from_webapp=1",
        )
        .expect("TikTok URL");
        assert_eq!(
            tiktok_video_id(&parsed).as_deref(),
            Some("7667965748597329174")
        );
    }

    #[test]
    fn extracts_instagram_post_variants() {
        for path in ["/p/DYpFujOP1gR/", "/reel/CODE123/", "/tv/TV123/"] {
            let parsed =
                Url::parse(&format!("https://www.instagram.com{path}")).expect("Instagram URL");
            assert!(instagram_post_id(&parsed).is_some(), "{path}");
        }
    }

    #[test]
    fn extracts_numeric_pinterest_pin_id_only() {
        let valid = Url::parse("https://www.pinterest.com/pin/766526799123759694/sent/")
            .expect("Pinterest URL");
        let invalid =
            Url::parse("https://www.pinterest.com/pin/not-a-pin/").expect("Pinterest URL");
        assert_eq!(
            pinterest_pin_id(&valid).as_deref(),
            Some("766526799123759694")
        );
        assert!(pinterest_pin_id(&invalid).is_none());
    }

    #[test]
    fn normalizes_tiktok_tracking_query_without_changing_video_path() {
        let original = "https://www.tiktok.com/@creator/video/7667965748597329174?is_from_webapp=1&sender_device=pc&web_id=7651051842596079125";
        let normalized = normalize_tiktok_source_value(original);
        assert_eq!(
            normalized,
            "https://www.tiktok.com/@creator/video/7667965748597329174"
        );
    }

    #[test]
    fn keeps_non_tiktok_query_parameters_intact() {
        let original = "https://www.youtube.com/watch?v=abc123&list=playlist123";
        assert_eq!(normalize_tiktok_source_value(original), original);
    }

    #[test]
    fn detects_platform_timestamp_tail_for_normalization() {
        assert!(duration_needs_normalization(314.966, Some(31.0)));
        assert!(!duration_needs_normalization(31.4, Some(31.0)));
        assert!(!duration_needs_normalization(314.966, None));
    }

    #[test]
    fn tiktok_download_fallbacks_are_scoped_to_tiktok() {
        let tiktok = Url::parse("https://www.tiktok.com/@creator/video/123456789").unwrap();
        let youtube = Url::parse("https://www.youtube.com/watch?v=abc123").unwrap();
        assert_eq!(media_download_profiles(&tiktok).len(), 3);
        assert_eq!(media_download_profiles(&youtube).len(), 5);
        assert!(media_download_profiles(&tiktok)
            .iter()
            .skip(1)
            .all(|profile| profile.contains("api_hostname=")));
        assert!(media_download_profiles(&youtube)
            .iter()
            .skip(1)
            .all(|profile| profile.contains("player_client=")));
        let stable_profiles = media_download_profiles(&youtube);
        let extraction_profiles = media_extraction_profiles(&youtube);
        assert_eq!(
            &extraction_profiles[..stable_profiles.len()],
            stable_profiles
        );
        assert!(!media_extraction_profiles(&tiktok)
            .iter()
            .any(|profile| profile.contains("cookies")));
        assert!(!media_extraction_profiles(&youtube)
            .iter()
            .any(|profile| profile.contains("cookies")));
    }

    #[test]
    fn quality_limited_metadata_is_replaced_by_a_richer_profile() {
        let limited = serde_json::json!({
            "formats": [
                {"format_id":"18","height":360,"vcodec":"avc1","acodec":"mp4a","url":"https://cdn.example.test/360.mp4"}
            ]
        });
        let richer = serde_json::json!({
            "formats": [
                {"format_id":"137","height":1080,"vcodec":"avc1","acodec":"none","url":"https://cdn.example.test/1080.mp4"},
                {"format_id":"140","vcodec":"none","acodec":"mp4a","url":"https://cdn.example.test/audio.m4a"}
            ]
        });
        assert!(media_metadata_needs_quality_fallback(&limited));
        assert!(!media_metadata_needs_quality_fallback(&richer));

        let mut selected = Some(limited);
        retain_richer_media_metadata(&mut selected, richer);
        assert_eq!(media_metadata_quality(selected.as_ref().unwrap()).0, 1080);
    }

    #[test]
    fn rich_metadata_is_not_replaced_by_a_later_360p_profile() {
        let richer = serde_json::json!({
            "formats": [
                {"format_id":"271","height":1440,"vcodec":"vp9","acodec":"none","url":"https://cdn.example.test/1440.webm"},
                {"format_id":"251","vcodec":"none","acodec":"opus","url":"https://cdn.example.test/audio.webm"}
            ]
        });
        let limited = serde_json::json!({
            "formats": [
                {"format_id":"18","height":360,"vcodec":"avc1","acodec":"mp4a","url":"https://cdn.example.test/360.mp4"}
            ]
        });
        let mut selected = Some(richer);
        retain_richer_media_metadata(&mut selected, limited);
        assert_eq!(media_metadata_quality(selected.as_ref().unwrap()).0, 1440);
    }

    #[test]
    fn preview_budget_is_extended_for_youtube_and_tiktok_only() {
        let tiktok = Url::parse("https://www.tiktok.com/@creator/video/123456789").unwrap();
        let youtube = Url::parse("https://www.youtube.com/watch?v=abc123").unwrap();
        let short_youtube = Url::parse("https://youtu.be/abc123").unwrap();
        let generic = Url::parse("https://example.com/video").unwrap();
        let extended = MediaPreviewBudget {
            retries: "3",
            extractor_retries: "3",
            socket_timeout: "15",
            timeout_seconds: 45,
        };
        let short = MediaPreviewBudget {
            retries: "1",
            extractor_retries: "1",
            socket_timeout: "10",
            timeout_seconds: 30,
        };
        assert_eq!(media_preview_budget(&tiktok), extended);
        assert_eq!(media_preview_budget(&youtube), extended);
        assert_eq!(media_preview_budget(&short_youtube), extended);
        assert_eq!(media_preview_budget(&generic), short);
    }

    #[test]
    fn youtube_web_safari_hls_is_deferred_until_a_forbidden_download() {
        let youtube = Url::parse("https://youtu.be/Lg2UXs9SDx4").unwrap();
        assert!(!media_download_profiles(&youtube).contains(&YOUTUBE_WEB_SAFARI_HLS_PROFILE));
        assert!(is_youtube_web_safari_hls_attempt(
            &youtube,
            YOUTUBE_WEB_SAFARI_HLS_PROFILE
        ));
        assert_eq!(
            media_format_selector(
                &youtube,
                YOUTUBE_WEB_SAFARI_HLS_SELECTOR,
                "video_mp4",
                YOUTUBE_WEB_SAFARI_HLS_PROFILE
            ),
            YOUTUBE_WEB_SAFARI_HLS_SELECTOR
        );
    }

    #[test]
    fn tiktok_same_resolution_fallback_preserves_scope_and_mp4_candidate() {
        let tiktok = Url::parse("https://www.tiktok.com/@creator/video/123456789").unwrap();
        let youtube = Url::parse("https://www.youtube.com/watch?v=abc123").unwrap();
        let selected = "bytevc1_1080p_930218-0/best[height<=1080]/best";

        assert_eq!(
            media_format_selector(&tiktok, selected, "video_mp4", ""),
            "bytevc1_1080p_930218-0"
        );
        assert_eq!(
            tiktok_same_resolution_format_fallback(selected),
            Some("bytevc1_1080p_930218-1".into())
        );
        assert_eq!(
            tiktok_same_resolution_format_fallback("h264_720p_877826-1"),
            Some("h264_720p_877826-0".into())
        );
        assert_eq!(
            tiktok_same_resolution_format_fallback("bestvideo*+bestaudio/best"),
            None
        );
        assert_eq!(
            media_format_selector(&youtube, selected, "video_mp4", ""),
            windows_mp4_selector(selected)
        );
    }

    #[test]
    fn session_options_are_opt_in_and_mutually_exclusive() {
        let anonymous = validate_media_session_options(false, None).unwrap();
        assert!(!anonymous.use_brave_cookies);
        assert!(anonymous.cookies_path.is_none());
        assert!(validate_media_session_options(true, Some("C:\\cookies.txt".into())).is_err());

        let mut command = Command::new("yt-dlp");
        configure_session_arguments(&mut command, &anonymous);
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|value| value.contains("cookies")));
    }

    #[test]
    fn media_error_classes_and_backoff_are_bounded() {
        assert_eq!(
            classify_media_process_error("HTTP Error 403: Forbidden"),
            MediaFailureClass::Forbidden
        );
        assert_eq!(
            classify_media_process_error("HTTP Error 429: Too Many Requests"),
            MediaFailureClass::TooManyRequests
        );
        assert_eq!(
            classify_media_process_error("Please verify you are human"),
            MediaFailureClass::Captcha
        );
        let mut attempt = 0;
        assert_eq!(
            media_backoff_delay(&mut attempt),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            media_backoff_delay(&mut attempt),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            media_backoff_delay(&mut attempt),
            Some(Duration::from_secs(8))
        );
        assert_eq!(media_backoff_delay(&mut attempt), None);
    }

    #[test]
    fn traceback_errors_are_sanitized_without_touching_human_provider_errors() {
        let traceback = "Traceback (most recent call last):\n  File \"extractor.py\", line 20, in run\n    raise RuntimeError('boom')\nRuntimeError: boom";
        assert_eq!(
            sanitize_media_error_message(traceback),
            SANITIZED_EXTRACTOR_ERROR
        );
        let postprocessing = "ERROR: Postprocessing: conversion failed\n  File \"post.py\", line 3\n  File \"ffmpeg.py\", line 9\nRuntimeError: boom";
        assert_eq!(
            sanitize_media_error_message(postprocessing),
            SANITIZED_EXTRACTOR_ERROR
        );
        let provider_error = "HTTP Error 403: Forbidden";
        assert_eq!(sanitize_media_error_message(provider_error), provider_error);
    }

    #[test]
    fn missing_info_json_error_is_retriable_and_refresh_paths_are_unique() {
        assert!(media_info_json_missing_error(
            "ERROR: --load-info-json info_json not found"
        ));
        assert!(media_info_json_missing_error(
            "could not open info_json: no such file or directory"
        ));
        assert!(!media_info_json_missing_error("HTTP Error 403: Forbidden"));
        let info_json = Path::new("C:/work/1/refresh-1-10.info.json");
        assert!(should_retry_without_info_json(
            Some(info_json),
            "ERROR: --load-info-json info_json not found"
        ));
        assert!(!should_retry_without_info_json(
            None,
            "ERROR: --load-info-json info_json not found"
        ));
        let first = refreshed_media_info_paths(Path::new("C:/work/1"), 1, 10);
        let second = refreshed_media_info_paths(Path::new("C:/work/1"), 1, 11);
        assert_ne!(first, second);
        assert!(first.0.ends_with("refresh-1-10.info.json"));
        assert!(first.1.ends_with(".refresh-1-10.tmp"));
    }

    #[test]
    fn windows_mp4_selector_preserves_requested_height_cap() {
        assert_eq!(
            windows_mp4_selector("bestvideo[height<=1080]+bestaudio/best"),
            "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]"
        );
        assert_eq!(
            windows_mp4_selector("bestvideo*+bestaudio/best"),
            "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]"
        );
    }

    #[test]
    fn multimedia_quality_matrix_reaches_yt_dlp_with_the_requested_cap() {
        let runtime = MediaRuntimePaths {
            yt_dlp: PathBuf::from("yt-dlp.exe"),
            ffmpeg_dir: PathBuf::from("ffmpeg"),
        };
        let youtube = Url::parse("https://www.youtube.com/watch?v=quality-matrix").unwrap();
        let work_dir = Path::new("target/quality-matrix");
        let session = MediaSessionOptions::default();
        let policy = crate::downloads::BandwidthPolicy::Unlimited;

        for height in [144, 360, 480, 720, 1080] {
            let selector = format!(
                "bestvideo[height<={height}]+bestaudio/best[height<={height}]/best[height<={height}]"
            );
            for output_mode in ["video_mp4", "video_webm"] {
                let command = build_media_download_command(
                    &runtime,
                    &youtube,
                    youtube.as_str(),
                    &selector,
                    output_mode,
                    work_dir,
                    "%(title)s.%(ext)s",
                    "",
                    false,
                    &session,
                    None,
                    &policy,
                );
                let args = command
                    .get_args()
                    .map(|value| value.to_string_lossy().to_string())
                    .collect::<Vec<_>>();
                let format_index = args
                    .iter()
                    .position(|value| value == "--format")
                    .expect("yt-dlp command has --format");
                let actual = args.get(format_index + 1).expect("--format has a selector");
                assert!(
                    actual.contains(&format!("height<={height}")),
                    "{output_mode} selector lost {height}p cap: {actual}"
                );
                assert!(
                    !actual.contains("bestvideo*+bestaudio/best"),
                    "{output_mode} selector fell back to unbounded best: {actual}"
                );
                if output_mode == "video_mp4" {
                    assert_eq!(
                        actual,
                        &format!(
                            "bv*[ext=mp4][height<={height}]+ba[ext=m4a]/b[ext=mp4][height<={height}]"
                        )
                    );
                } else {
                    assert_eq!(actual, &selector);
                }
            }
        }
    }

    #[test]
    fn pinterest_preserves_provider_hls_format_selection() {
        let pinterest = Url::parse("https://www.pinterest.com/pin/3025924747114602/sent/").unwrap();
        let selected = "V_HLSV3_MOBILE-408+V_HLSV3_MOBILE-audio1-1/best[height<=720]/best";
        assert_eq!(
            media_format_selector(&pinterest, selected, "video_mp4", ""),
            selected
        );
    }
}
