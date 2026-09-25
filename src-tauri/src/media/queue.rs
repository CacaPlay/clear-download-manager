use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct MediaQueueReceipt {
    pub(crate) job_id: i64,
    pub(crate) title: String,
    pub(crate) sequential: bool,
}
use rusqlite::params;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::{
    current_downloads_dir, normalize_tiktok_source_value, run_media_worker_with_options,
    safe_format_selector, safe_remote_thumbnail_url, saved_media_session_for_db,
    validate_media_session_options, validate_media_url, validate_netscape_cookie_file,
    MediaSessionOptions,
};
use crate::LocalState;

pub(crate) fn queue_media_download(
    url: String,
    title: String,
    thumbnail: Option<String>,
    format_selector: String,
    output_mode: String,
    expected_duration_seconds: Option<f64>,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    queue_media_download_with_filename(
        url,
        title,
        thumbnail,
        format_selector,
        output_mode,
        expected_duration_seconds,
        None,
        saved_media_session_for_db(&state.db_path),
        state,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn queue_media_download_named(
    url: String,
    title: String,
    thumbnail: Option<String>,
    format_selector: String,
    output_mode: String,
    expected_duration_seconds: Option<f64>,
    filename: Option<String>,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    queue_media_download_with_filename(
        url,
        title,
        thumbnail,
        format_selector,
        output_mode,
        expected_duration_seconds,
        filename,
        saved_media_session_for_db(&state.db_path),
        state,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn queue_media_download_secure(
    url: String,
    title: String,
    thumbnail: Option<String>,
    format_selector: String,
    output_mode: String,
    expected_duration_seconds: Option<f64>,
    filename: Option<String>,
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    let session = validate_media_session_options(use_brave_cookies, cookies_path)?;
    queue_media_download_with_filename(
        url,
        title,
        thumbnail,
        format_selector,
        output_mode,
        expected_duration_seconds,
        filename,
        session,
        state,
    )
}

pub(crate) fn choose_media_cookies_file(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Elegir archivo Netscape de cookies")
        .add_filter("Cookies Netscape", &["txt"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("El archivo seleccionado no es válido: {error}"))?;
    Ok(Some(
        validate_netscape_cookie_file(&path)?
            .to_string_lossy()
            .to_string(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn queue_media_download_with_filename(
    url: String,
    title: String,
    thumbnail: Option<String>,
    format_selector: String,
    output_mode: String,
    expected_duration_seconds: Option<f64>,
    filename: Option<String>,
    session: MediaSessionOptions,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    let runtime = state.media_runtime.clone().ok_or_else(|| {
        "El motor multimedia local aún no está instalado en esta compilación".to_string()
    })?;
    let source_url = normalize_tiktok_source_value(&validate_media_url(&url)?);
    let selector = safe_format_selector(&format_selector)?;
    let allowed_modes = [
        "video_mp4",
        "video_webm",
        "audio_mp3",
        "audio_m4a",
        "audio_flac",
        "audio_flac_hires",
        "audio_flac_max",
        "audio_best",
        "source",
    ];
    if !allowed_modes.contains(&output_mode.as_str()) {
        return Err("El modo de salida no es válido".into());
    }
    let title: String = if title.trim().is_empty() {
        "Descarga multimedia".into()
    } else {
        title.trim().chars().take(200).collect()
    };
    let thumbnail = thumbnail
        .as_deref()
        .map(safe_remote_thumbnail_url)
        .unwrap_or_default();
    let requested_filename = filename
        .as_deref()
        .map(crate::downloads::sanitize_filename)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let display_title = if requested_filename.is_empty() {
        title.clone()
    } else {
        Path::new(&requested_filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(requested_filename.as_str())
            .trim()
            .chars()
            .take(200)
            .collect()
    };
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    connection
        .execute(
            "INSERT INTO jobs(title,detail,progress,status,updated_at) VALUES(?1,'En cola multimedia',0,'queued',CURRENT_TIMESTAMP)",
            params![display_title],
        )
        .map_err(|error| error.to_string())?;
    let job_id = connection.last_insert_rowid();
    connection
        .execute(
            "INSERT INTO media_jobs(job_id,source_url,download_url,thumbnail,format_selector,output_mode,destination_dir,requested_filename,expected_duration_seconds,resolution_state) VALUES(?1,?2,?2,?3,?4,?5,?6,?7,?8,'download_queued')",
            params![
                job_id,
                source_url,
                thumbnail,
                selector,
                output_mode,
                current_downloads_dir(&state)?.to_string_lossy().to_string(),
                requested_filename,
                expected_duration_seconds,
            ],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    run_media_worker_with_options(
        state.db_path.clone(),
        runtime,
        state.active_media_pids.clone(),
        state.external_processes.clone(),
        job_id,
        session,
    );
    Ok(MediaQueueReceipt {
        job_id,
        title,
        sequential: false,
    })
}
