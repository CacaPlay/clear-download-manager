#![allow(clippy::invisible_characters)]

use super::aria2;
use super::{
    canonical_google_docs_export_url, create_http_download_job, current_downloads_dir,
    deduplicate_storage_paths, filename_extension, filename_from_url, job_final_storage_paths,
    job_is_active, job_partial_storage_paths, load_job_storage_record,
    read_download_concurrency_settings, remote_download_probe, remove_managed_storage_path,
    run_download_worker, sanitize_filename, schedule_job_deletion_after_idle, stop_job_internal,
    stop_job_internal_without_wait, validate_managed_candidate, wait_for_job_idle,
    CancelJobReceipt, DeleteJobReceipt, DeletePlaylistReceipt, JobStoragePreview,
};
use crate::extension_bridge;
use crate::{
    ensure_public_network_resolution, html_attribute_values, html_page_title, is_spotify_url,
    job_uses_disabled_spotify, kill_process_tree, normalize_schedule_time, page_candidate_score,
    parse_public_http_url, read_currency_snapshot, read_download_activity, read_schedule,
    reject_spotify_source, resolve_download_filename, resolve_extension_download_filename,
    resume_download_worker_when_idle, resume_media_worker_when_idle,
    resume_torrent_worker_when_idle, spotify_disabled_error, terminate_external_processes,
    url_has_public_http_target, url_has_public_network_target, validate_schedule_action,
    DesktopSettingsSnapshot, DesktopSnapshot, DownloadActivitySnapshot, DownloadQueueReceipt,
    DownloadScheduleSnapshot, DownloadUrlInspection, FileMetadataSnapshot, LocalState,
    PageDownloadCandidate, PageDownloadDiscovery, QueueActionReceipt, RecentFileSnapshot,
    StorageSnapshot, SPOTIFY_DISABLED_MESSAGE,
};
use reqwest::blocking::Client;
use reqwest::header::CONTENT_TYPE;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

pub(crate) struct BrowserDownloadCaptureService;

impl BrowserDownloadCaptureService {
    pub(crate) fn source(capture: &Value) -> String {
        capture
            .get("finalUrl")
            .or_else(|| capture.get("url"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    pub(crate) fn duplicate_job(
        connection: &Connection,
        source: &str,
    ) -> Result<Option<i64>, String> {
        connection
            .query_row(
                "SELECT jobs.id FROM jobs INNER JOIN download_jobs ON download_jobs.job_id=jobs.id WHERE download_jobs.url=?1 AND jobs.status NOT IN ('cancelled','failed') LIMIT 1",
                params![source],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn respond(request_id: &str, response: Value) -> Result<Value, String> {
        extension_bridge::write_capture_response(request_id, &response)?;
        Ok(response)
    }

    pub(crate) fn accept(
        request_id: &str,
        capture: Value,
        state: &LocalState,
    ) -> Result<Value, String> {
        if capture
            .get("incognito")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Self::respond(
                request_id,
                json!({
                    "ok": false,
                    "status": "unsupported",
                    "requestId": request_id,
                    "error": "Las descargas privadas no se transfieren automáticamente"
                }),
            );
        }
        let source = Self::source(&capture);
        let original_capture_source = capture
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if is_spotify_url(&source) || is_spotify_url(original_capture_source) {
            return Self::respond(
                request_id,
                json!({
                    "ok": false,
                    "status": "spotify_disabled",
                    "requestId": request_id,
                    "error": SPOTIFY_DISABLED_MESSAGE
                }),
            );
        }
        let parsed = match parse_public_http_url(&source, "La descarga capturada no es HTTP/HTTPS")
        {
            Ok(parsed) => parsed,
            Err(error) => {
                return Self::respond(
                    request_id,
                    json!({ "ok": false, "status": "unsupported", "requestId": request_id, "error": error }),
                )
            }
        };
        let normalized_source = parsed.to_string();
        let duplicate = {
            let connection = state
                .connection
                .lock()
                .map_err(|_| "No se pudo bloquear la base local".to_string())?;
            Self::duplicate_job(&connection, &normalized_source)?
        };
        if let Some(job_id) = duplicate {
            return Self::respond(
                request_id,
                json!({ "ok": false, "status": "duplicate", "requestId": request_id, "jobId": job_id }),
            );
        }
        let captured_filename = capture
            .get("filename")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let content_disposition = capture.get("contentDisposition").and_then(Value::as_str);
        let mime = capture.get("mime").and_then(Value::as_str);
        let referrer = capture
            .get("referrer")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let filename = resolve_download_filename(
            &parsed,
            &parsed,
            captured_filename,
            content_disposition,
            mime,
        );
        let receipt = match create_http_download_job(
            &state.db_path,
            state.active_downloads.clone(),
            &current_downloads_dir(state)?,
            &parsed,
            &filename,
            "Descarga capturada desde el navegador",
            referrer,
        ) {
            Ok(receipt) => receipt,
            Err(error) => {
                return Self::respond(
                    request_id,
                    json!({ "ok": false, "status": "temporary_failure", "requestId": request_id, "error": error }),
                )
            }
        };
        Self::respond(
            request_id,
            json!({
                "ok": true,
                "status": "accepted",
                "requestId": request_id,
                "jobId": receipt.job_id,
                "filename": receipt.filename,
                "destination": receipt.destination
            }),
        )
    }

    pub(crate) async fn prepare(
        request_id: &str,
        capture: Value,
        app: AppHandle,
        state: &LocalState,
    ) -> Result<Value, String> {
        if capture
            .get("incognito")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Self::respond(
                request_id,
                json!({
                    "ok": false,
                    "status": "unsupported",
                    "requestId": request_id,
                    "error": "Las descargas privadas no se transfieren automáticamente"
                }),
            );
        }
        let source = Self::source(&capture);
        let original_capture_source = capture
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if is_spotify_url(&source) || is_spotify_url(original_capture_source) {
            return Self::respond(
                request_id,
                json!({
                    "ok": false,
                    "status": "spotify_disabled",
                    "requestId": request_id,
                    "error": SPOTIFY_DISABLED_MESSAGE
                }),
            );
        }
        let parsed = match parse_public_http_url(&source, "La descarga capturada no es HTTP/HTTPS")
        {
            Ok(parsed) => parsed,
            Err(error) => {
                return Self::respond(
                    request_id,
                    json!({ "ok": false, "status": "unsupported", "requestId": request_id, "error": error }),
                )
            }
        };
        let normalized_source = parsed.to_string();
        let duplicate = {
            let connection = state
                .connection
                .lock()
                .map_err(|_| "No se pudo bloquear la base local".to_string())?;
            Self::duplicate_job(&connection, &normalized_source)?
        };
        if let Some(job_id) = duplicate {
            return Self::respond(
                request_id,
                json!({ "ok": false, "status": "duplicate", "requestId": request_id, "jobId": job_id }),
            );
        }
        let captured_filename = capture
            .get("filename")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let content_disposition = capture.get("contentDisposition").and_then(Value::as_str);
        let mime = capture
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let filename = resolve_download_filename(
            &parsed,
            &parsed,
            captured_filename,
            content_disposition,
            Some(mime),
        );
        let options = json!({
            "filename": filename.clone(),
            "mime": mime,
            "windowMode": "foreground",
            "pageTitle": "Preparar descarga HTTP",
            "title": "Preparar descarga HTTP"
        });
        if let Err(error) = crate::subwindows::open_preparation_window(
            "direct".to_string(),
            normalized_source,
            Some(options),
            app,
        )
        .await
        {
            return Self::respond(
                request_id,
                json!({ "ok": false, "status": "preparation_failed", "requestId": request_id, "error": error }),
            );
        }
        Self::respond(
            request_id,
            json!({
                "ok": true,
                "status": "review_opened",
                "requestId": request_id,
                "filename": filename
            }),
        )
    }
}

pub(crate) fn download_activity_snapshot(
    state: State<'_, LocalState>,
) -> Result<DownloadActivitySnapshot, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    read_download_activity(&connection, true)
}
pub(crate) fn desktop_snapshot(state: State<'_, LocalState>) -> Result<DesktopSnapshot, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let free_bytes = fs2::available_space(&downloads_dir).unwrap_or(0);
    let total_bytes = fs2::total_space(&downloads_dir).unwrap_or(0);
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;

    let currency = read_currency_snapshot(&connection);

    let activity = read_download_activity(&connection, false)?;

    let mut recent_statement = connection
        .prepare(
            "SELECT id,name,path,category,opened_at,kind
             FROM recent_files
             ORDER BY opened_at DESC
             LIMIT 8",
        )
        .map_err(|error| error.to_string())?;
    let recent_files = recent_statement
        .query_map([], |row| {
            Ok(RecentFileSnapshot {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                category: row.get(3)?,
                opened_at: row.get(4)?,
                kind: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();

    let recoverable_direct_jobs = {
        let mut statement = connection
            .prepare(
                "SELECT jobs.id
                 FROM jobs
                 INNER JOIN download_jobs ON download_jobs.job_id=jobs.id
                 WHERE jobs.status IN ('queued','running')
                 ORDER BY jobs.updated_at ASC
                 LIMIT 12",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        rows.flatten().collect::<Vec<_>>()
    };

    let snapshot = DesktopSnapshot {
        storage: StorageSnapshot {
            free_bytes,
            total_bytes,
        },
        currency,
        queue: activity.queue,
        jobs: activity.jobs,
        playlist_batches: activity.playlist_batches,
        recent_files,
    };

    drop(recent_statement);
    drop(connection);

    for job_id in recoverable_direct_jobs {
        run_download_worker(
            state.db_path.clone(),
            state.active_downloads.clone(),
            job_id,
        );
    }

    Ok(snapshot)
}
pub(crate) fn desktop_settings(
    state: State<'_, LocalState>,
) -> Result<DesktopSettingsSnapshot, String> {
    let downloads_dir = current_downloads_dir(&state)?;
    let download_concurrency = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        read_download_concurrency_settings(&connection)
    };
    Ok(DesktopSettingsSnapshot {
        downloads_dir: downloads_dir.to_string_lossy().to_string(),
        download_concurrency,
    })
}
pub(crate) async fn choose_download_directory(
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Option<String>, String> {
    static DESTINATION_PICKER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _picker_guard = DESTINATION_PICKER_LOCK
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "Ya hay un selector de destino abierto".to_string())?;
    let selected = app
        .dialog()
        .file()
        .set_title("Elegir carpeta de descargas de CacaTools")
        .blocking_pick_folder();

    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|error| format!("La carpeta seleccionada no es válida: {error}"))?;
    fs::create_dir_all(&selected)
        .map_err(|error| format!("No se pudo preparar la carpeta: {error}"))?;
    let selected = selected
        .canonicalize()
        .map_err(|error| format!("No se pudo validar la carpeta: {error}"))?;

    {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        connection
            .execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('downloads_dir',?1,CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
                params![selected.to_string_lossy().to_string()],
            )
            .map_err(|error| error.to_string())?;
    }
    {
        let mut downloads_dir = state
            .downloads_dir
            .lock()
            .map_err(|_| "No se pudo actualizar la carpeta de descargas".to_string())?;
        *downloads_dir = selected.clone();
    }
    Ok(Some(selected.to_string_lossy().to_string()))
}
pub(crate) fn open_download_directory(
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let downloads_dir = current_downloads_dir(&state)?;
    fs::create_dir_all(&downloads_dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(downloads_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}
pub(crate) fn reveal_local_file(path: String, app: AppHandle) -> Result<(), String> {
    let file_path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "La ruta no existe".to_string())?;
    if file_path.is_dir() {
        return app
            .opener()
            .open_path(file_path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|error| error.to_string());
    }
    if !file_path.is_file() {
        return Err("La ruta no corresponde a un archivo ni a una carpeta".into());
    }
    app.opener()
        .reveal_item_in_dir(file_path)
        .map_err(|error| error.to_string())
}
pub(crate) async fn queue_http_download(
    url: String,
    filename: Option<String>,
    extension_filename: Option<String>,
    extension_mime: Option<String>,
    extension_expected_extension: Option<String>,
    state: State<'_, LocalState>,
) -> Result<DownloadQueueReceipt, String> {
    reject_spotify_source(&url)?;
    let downloads_dir = current_downloads_dir(&state)?;
    let db_path = state.db_path.clone();
    let active_downloads = state.active_downloads.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let original_url = parse_public_http_url(&url, "El enlace no es válido")?;
        let request_url =
            canonical_google_docs_export_url(&original_url).unwrap_or_else(|| original_url.clone());
        let probe = remote_download_probe(&request_url).ok();
        let final_url = probe
            .as_ref()
            .map(|metadata| metadata.final_url.clone())
            .unwrap_or(request_url);
        let resolved_filename = resolve_extension_download_filename(
            &original_url,
            &final_url,
            extension_filename.as_deref(),
            filename.as_deref(),
            probe
                .as_ref()
                .and_then(|metadata| metadata.content_disposition.as_deref()),
            probe
                .as_ref()
                .and_then(|metadata| metadata.content_type.as_deref())
                .or(extension_mime.as_deref()),
            extension_expected_extension.as_deref(),
        );
        let html = probe
            .as_ref()
            .and_then(|metadata| metadata.content_type.as_deref())
            .map(aria2::is_html_content_type_for_queue)
            .unwrap_or(false);
        Ok::<_, String>((original_url, final_url, resolved_filename, html))
    })
    .await
    .map_err(|error| format!("No se pudo preparar la descarga: {error}"))??;
    let (original_url, final_url, resolved_filename, html) = prepared;
    if html {
        if aria2::is_supported_media_host(&original_url)
            || aria2::is_supported_media_host(&final_url)
        {
            let media_receipt = crate::media::queue_media_download_named(
                original_url.to_string(),
                resolved_filename.clone(),
                None,
                "bestvideo+bestaudio/best".into(),
                "video_mp4".into(),
                None,
                Some(resolved_filename.clone()),
                state,
            )?;
            return Ok(DownloadQueueReceipt {
                job_id: media_receipt.job_id,
                filename: resolved_filename.clone(),
                destination: downloads_dir
                    .join(resolved_filename)
                    .to_string_lossy()
                    .to_string(),
                resumable: false,
            });
        }
        return Err("html_direct_unsupported: el enlace devolvió una página HTML y no pertenece a una plataforma multimedia soportada".into());
    }
    create_http_download_job(
        &db_path,
        active_downloads,
        &downloads_dir,
        &final_url,
        &resolved_filename,
        "En cola",
        None,
    )
}
pub(crate) async fn accept_browser_download_capture(
    request_id: String,
    capture: Value,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Value, String> {
    let foreground = capture
        .get("windowMode")
        .or_else(|| capture.get("windowBehavior"))
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("foreground"));
    if foreground {
        return BrowserDownloadCaptureService::prepare(&request_id, capture, app, &state).await;
    }
    BrowserDownloadCaptureService::accept(&request_id, capture, &state)
}
pub(crate) fn set_job_status(
    id: i64,
    status: String,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    const ALLOWED: [&str; 6] = [
        "queued",
        "running",
        "paused",
        "cancelled",
        "completed",
        "failed",
    ];
    if !ALLOWED.contains(&status.as_str()) {
        return Err("Estado no permitido".into());
    }
    if status == "cancelled" {
        stop_job_internal(id, false, &state)?;
        return Ok(());
    }

    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let current_status: String = connection
        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
            row.get(0)
        })
        .map_err(|_| "La tarea ya no existe".to_string())?;
    let is_media = connection
        .query_row(
            "SELECT 1 FROM media_jobs WHERE job_id=?1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if matches!(status.as_str(), "queued" | "running")
        && job_uses_disabled_spotify(&connection, id)?
    {
        return Err(spotify_disabled_error());
    }
    let torrent_destination: Option<String> = connection
        .query_row(
            "SELECT destination_dir FROM torrent_jobs WHERE job_id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let is_torrent = torrent_destination.is_some();
    if status == "running" {
        if matches!(current_status.as_str(), "completed" | "cancelled") {
            return Err("Una tarea completada o cancelada no puede reanudarse".into());
        }
        connection
            .execute(
                "UPDATE jobs SET status='queued',detail='Esperando que termine el proceso anterior…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        drop(connection);
        if is_media {
            let runtime = state
                .media_runtime
                .clone()
                .ok_or_else(|| "El motor multimedia local no está disponible".to_string())?;
            resume_media_worker_when_idle(
                state.db_path.clone(),
                runtime,
                state.active_media_pids.clone(),
                state.external_processes.clone(),
                id,
            );
        } else if is_torrent {
            let aria2_path = state
                .aria2_path
                .clone()
                .ok_or_else(|| "aria2c no está disponible en esta instalación".to_string())?;
            resume_torrent_worker_when_idle(
                state.db_path.clone(),
                aria2_path,
                state.active_media_pids.clone(),
                id,
            );
        } else {
            resume_download_worker_when_idle(
                state.db_path.clone(),
                state.active_downloads.clone(),
                id,
            );
        }
        return Ok(());
    }

    connection
        .execute(
            "UPDATE jobs SET status=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![status, id],
        )
        .map_err(|error| error.to_string())?;
    if is_media {
        connection
            .execute(
                "UPDATE playlist_items SET status=?1 WHERE job_id=?2 AND status NOT IN ('completed')",
                params![status, id],
            )
            .map_err(|error| error.to_string())?;
    }
    if status == "paused" {
        connection
            .execute(
                "UPDATE download_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE media_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE torrent_jobs SET speed_bps=0,eta_seconds=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
    }
    drop(connection);

    if status == "paused" && (is_media || is_torrent) {
        if let Ok(active) = state.active_media_pids.lock() {
            if let Some(pid) = active.get(&id).copied().filter(|pid| *pid > 0) {
                kill_process_tree(pid);
            }
        }
        terminate_external_processes(&state.external_processes, id);
    }
    Ok(())
}
pub(crate) fn job_storage_preview(
    id: i64,
    state: State<'_, LocalState>,
) -> Result<JobStoragePreview, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let record = load_job_storage_record(&connection, id)?;
    drop(connection);
    let managed_root = current_downloads_dir(&state)?;
    let final_paths = deduplicate_storage_paths(job_final_storage_paths(&record));
    let partial_paths = deduplicate_storage_paths(job_partial_storage_paths(&record));
    let all_paths = deduplicate_storage_paths(
        final_paths
            .iter()
            .chain(partial_paths.iter())
            .cloned()
            .collect(),
    );
    let mut safety_warning = None;
    for (path, _) in &all_paths {
        if let Err(error) = validate_managed_candidate(&managed_root, path) {
            safety_warning = Some(error);
            break;
        }
    }
    let storage_exists = all_paths.iter().any(|(path, _)| path.exists());
    let active = job_is_active(&state, id)
        || matches!(record.status.as_str(), "running" | "queued" | "paused");
    Ok(JobStoragePreview {
        job_id: id,
        title: record.title,
        status: record.status.clone(),
        active,
        can_emergency_stop: record.status != "completed",
        managed_root: managed_root.to_string_lossy().to_string(),
        final_paths: final_paths
            .into_iter()
            .map(|(path, _)| path.to_string_lossy().to_string())
            .collect(),
        partial_paths: partial_paths
            .into_iter()
            .map(|(path, _)| path.to_string_lossy().to_string())
            .collect(),
        storage_exists,
        safe_for_storage_deletion: safety_warning.is_none(),
        safety_warning,
    })
}

pub(crate) fn rename_completed_download(
    id: i64,
    new_name: String,
    state: State<'_, LocalState>,
) -> Result<String, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let record = load_job_storage_record(&connection, id)?;
    if record.status != "completed" {
        return Err("Solo se pueden renombrar descargas completadas.".into());
    }
    if record.torrent_destination_dir.is_some() {
        return Err("No se pueden renombrar carpetas torrent desde esta acción.".into());
    }
    let is_direct = record.direct_destination.is_some();
    if new_name.trim().is_empty() {
        return Err("Escribe un nombre de archivo válido.".into());
    }
    let old_path = match (record.direct_destination, record.media_output) {
        (Some(_), Some(_)) => {
            return Err("La descarga tiene más de una ruta final; no se modificó.".into())
        }
        (Some(path), None) | (None, Some(path)) => path,
        (None, None) => return Err("No se encontró el archivo descargado.".into()),
    };
    if !old_path.is_absolute() {
        return Err("La ruta del archivo descargado no es absoluta.".into());
    }
    let metadata = old_path
        .symlink_metadata()
        .map_err(|error| format!("No se pudo inspeccionar el archivo: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("La ruta final no es un archivo normal.".into());
    }
    // Destination folders can be chosen by the user outside CDM's default
    // Downloads directory. Canonicalize the exact database-owned file path
    // rather than restricting rename to that default directory.
    let old_path = old_path
        .canonicalize()
        .map_err(|error| format!("No se pudo resolver el archivo descargado: {error}"))?;

    let requested = sanitize_filename(new_name.trim());
    let requested_path = std::path::Path::new(&requested);
    let original_extension = old_path.extension().and_then(|value| value.to_str());
    let requested_stem = if original_extension.is_some() {
        requested_path.file_stem().and_then(|value| value.to_str())
    } else {
        requested_path.file_name().and_then(|value| value.to_str())
    }
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "Escribe un nombre de archivo válido.".to_string())?;
    let final_name = match original_extension {
        Some(extension) => format!("{requested_stem}.{extension}"),
        None => requested.clone(),
    };
    let parent = old_path
        .parent()
        .ok_or_else(|| "No se encontró la carpeta del archivo.".to_string())?;
    let new_path = parent.join(final_name);
    if new_path.parent() != Some(parent) {
        return Err("El nuevo nombre no puede mover el archivo a otra carpeta.".into());
    }
    if old_path == new_path
        || old_path
            .to_string_lossy()
            .eq_ignore_ascii_case(&new_path.to_string_lossy())
    {
        return Ok(old_path.to_string_lossy().to_string());
    }
    if new_path.exists() {
        return Err("Ya existe un archivo con ese nombre en la carpeta.".into());
    }
    let new_value = new_path.to_string_lossy().to_string();
    let new_title = new_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("No se pudo preparar el cambio: {error}"))?;
    fs::rename(&old_path, &new_path)
        .map_err(|error| format!("No se pudo renombrar el archivo: {error}"))?;

    let updates = (|| -> Result<(), String> {
        let updated = transaction
            .execute(
                "UPDATE jobs SET title=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='completed'",
                params![new_title, id],
            )
            .map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("La descarga ya no está disponible para renombrarla.".into());
        }
        let path_rows = if is_direct {
            transaction
                .execute(
                    "UPDATE download_jobs SET destination=?1 WHERE job_id=?2",
                    params![new_value, id],
                )
                .map_err(|error| error.to_string())?
        } else {
            let path_rows = transaction
                .execute(
                    "UPDATE media_jobs SET output_path=?1,updated_at=CURRENT_TIMESTAMP WHERE job_id=?2",
                    params![new_value, id],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE playlist_items SET output_path=?1 WHERE job_id=?2",
                    params![new_value, id],
                )
                .map_err(|error| error.to_string())?;
            path_rows
        };
        if path_rows != 1 {
            return Err("No se pudo actualizar la ruta registrada de la descarga.".into());
        }
        transaction.commit().map_err(|error| error.to_string())
    })();
    if let Err(error) = updates {
        let _ = fs::rename(&new_path, &old_path);
        return Err(format!("No se pudo guardar el nuevo nombre: {error}"));
    }
    Ok(new_value)
}

pub(crate) fn emergency_stop_job(
    id: i64,
    delete_partial: bool,
    state: State<'_, LocalState>,
) -> Result<CancelJobReceipt, String> {
    stop_job_internal(id, delete_partial, &state)
}
pub(crate) fn cancel_download_job(
    id: i64,
    delete_partial: bool,
    state: State<'_, LocalState>,
) -> Result<CancelJobReceipt, String> {
    stop_job_internal(id, delete_partial, &state)
}
pub(crate) fn delete_download_job(
    id: i64,
    delete_storage: bool,
    state: State<'_, LocalState>,
) -> Result<DeleteJobReceipt, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let record = load_job_storage_record(&connection, id)?;
    drop(connection);

    let was_active = job_is_active(&state, id)
        || matches!(record.status.as_str(), "running" | "queued" | "paused");

    let managed_root = current_downloads_dir(&state)?;
    let final_paths = deduplicate_storage_paths(job_final_storage_paths(&record));
    let storage_paths = deduplicate_storage_paths(
        final_paths
            .iter()
            .cloned()
            .chain(job_partial_storage_paths(&record))
            .collect(),
    );
    if delete_storage {
        for (path, _) in &storage_paths {
            validate_managed_candidate(&managed_root, path)?;
        }
    }

    // Stop and mark the row before any asynchronous cleanup can run. Workers
    // only claim queued/running rows, and their finalizers require running
    // status, so this tombstone prevents a late worker from resurrecting the
    // deleted task.
    if was_active && record.status != "completed" {
        stop_job_internal_without_wait(id, false, &state)?;
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        connection
            .execute(
                "UPDATE jobs SET status='deleting',detail='Eliminando descarga…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='cancelled'",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        drop(connection);
        schedule_job_deletion_after_idle(
            id,
            delete_storage,
            state.db_path.clone(),
            state.active_downloads.clone(),
            state.active_media_pids.clone(),
            state.external_processes.clone(),
            managed_root.to_path_buf(),
            final_paths,
            storage_paths,
        );
        return Ok(DeleteJobReceipt {
            job_id: id,
            delete_storage,
            record_deleted: false,
            stopped_active_job: true,
            cleanup_pending: true,
            removed_paths: Vec::new(),
        });
    }

    let mut removed_paths = Vec::new();
    if delete_storage {
        for (path, is_directory) in &storage_paths {
            if remove_managed_storage_path(&managed_root, path, *is_directory)? {
                removed_paths.push(path.to_string_lossy().to_string());
            }
        }
    }

    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if delete_storage {
        for (path, _) in job_final_storage_paths(&record) {
            transaction
                .execute(
                    "DELETE FROM recent_files WHERE path=?1",
                    params![path.to_string_lossy().to_string()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    let affected = transaction
        .execute("DELETE FROM jobs WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("La tarea ya no existe".into());
    }

    Ok(DeleteJobReceipt {
        job_id: id,
        delete_storage,
        record_deleted: true,
        stopped_active_job: was_active,
        cleanup_pending: false,
        removed_paths,
    })
}
pub(crate) fn delete_playlist_batch(
    batch_id: i64,
    delete_storage: bool,
    state: State<'_, LocalState>,
) -> Result<DeletePlaylistReceipt, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlist_batches WHERE id=?1)",
            params![batch_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    if !exists {
        return Err("La playlist ya no existe".into());
    }
    let job_ids;
    {
        let mut statement = connection
            .prepare(
                "SELECT job_id FROM playlist_items WHERE batch_id=?1 AND job_id IS NOT NULL ORDER BY position",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![batch_id], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        job_ids = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
    }
    let mut records = job_ids
        .iter()
        .filter_map(|job_id| load_job_storage_record(&connection, *job_id).ok())
        .collect::<Vec<_>>();
    drop(connection);

    let mut stopped_active_jobs = 0usize;
    for record in &records {
        let active = job_is_active(&state, record.job_id)
            || matches!(record.status.as_str(), "running" | "queued" | "paused");
        if active {
            stop_job_internal(record.job_id, false, &state)?;
            if !wait_for_job_idle(&state, record.job_id) {
                return Err(format!(
                    "El elemento {} todavía está cerrando sus procesos. Intenta eliminar la playlist nuevamente.",
                    record.title
                ));
            }
            stopped_active_jobs += 1;
        }
    }

    if stopped_active_jobs > 0 {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        records = job_ids
            .iter()
            .filter_map(|job_id| load_job_storage_record(&connection, *job_id).ok())
            .collect();
    }

    let managed_root = current_downloads_dir(&state)?;
    let mut storage_paths = records
        .iter()
        .flat_map(|record| {
            job_final_storage_paths(record)
                .into_iter()
                .chain(job_partial_storage_paths(record))
        })
        .collect::<Vec<_>>();
    storage_paths.extend(
        records
            .iter()
            .filter_map(|record| record.media_destination_dir.clone())
            .map(|path| (path, true)),
    );
    let mut storage_paths = deduplicate_storage_paths(storage_paths);
    storage_paths.sort_by(|left, right| {
        left.1.cmp(&right.1).then_with(|| {
            right
                .0
                .components()
                .count()
                .cmp(&left.0.components().count())
        })
    });
    if delete_storage {
        for (path, _) in &storage_paths {
            validate_managed_candidate(&managed_root, path)?;
        }
    }

    let mut removed_paths = Vec::new();
    if delete_storage {
        for (path, is_directory) in &storage_paths {
            if remove_managed_storage_path(&managed_root, path, *is_directory)? {
                removed_paths.push(path.to_string_lossy().to_string());
            }
        }
    }

    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if delete_storage {
        for record in &records {
            for (path, _) in job_final_storage_paths(record) {
                transaction
                    .execute(
                        "DELETE FROM recent_files WHERE path=?1",
                        params![path.to_string_lossy().to_string()],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    let affected = transaction
        .execute(
            "DELETE FROM playlist_batches WHERE id=?1",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    for job_id in &job_ids {
        transaction
            .execute("DELETE FROM jobs WHERE id=?1", params![job_id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("La playlist ya no existe".into());
    }

    Ok(DeletePlaylistReceipt {
        batch_id,
        delete_storage,
        record_deleted: true,
        stopped_active_jobs,
        removed_paths,
    })
}
pub(crate) fn choose_local_file(
    kind: String,
    category: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Elegir archivo local")
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("El archivo seleccionado no es válido: {error}"))?
        .canonicalize()
        .map_err(|error| format!("No se pudo validar el archivo: {error}"))?;
    if !path.is_file() {
        return Err("La ruta seleccionada no corresponde a un archivo".into());
    }
    let path_text = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Archivo local")
        .to_string();
    let safe_category = category.chars().take(48).collect::<String>();
    let safe_kind = kind.chars().take(24).collect::<String>();
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    connection
        .execute(
            "INSERT INTO recent_files(name,path,category,kind,opened_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
             ON CONFLICT(path) DO UPDATE SET name=excluded.name,category=excluded.category,kind=excluded.kind,opened_at=CURRENT_TIMESTAMP",
            params![name, path_text, safe_category, safe_kind],
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}
pub(crate) fn open_local_file(path: String, app: AppHandle) -> Result<(), String> {
    let file_path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "El archivo no existe".to_string())?;
    if !file_path.is_file() {
        return Err("La ruta no corresponde a un archivo".into());
    }
    let file_path = file_path.to_string_lossy().into_owned();
    app.opener()
        .open_path(file_path, None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(())
}
pub(crate) fn record_recent_file(
    path: String,
    category: String,
    kind: String,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err("El archivo no existe".into());
    }
    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Nombre de archivo inválido".to_string())?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    connection
        .execute(
            "INSERT INTO recent_files(name,path,category,kind,opened_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
             ON CONFLICT(path) DO UPDATE SET name=excluded.name, category=excluded.category, kind=excluded.kind, opened_at=CURRENT_TIMESTAMP",
            params![name, path, category, kind],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
pub(crate) fn open_external_url(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "El enlace no es válido".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Solo se permiten enlaces HTTP o HTTPS".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}
pub(crate) fn choose_file_metadata(app: AppHandle) -> Result<Option<FileMetadataSnapshot>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Inspeccionar archivo local")
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("El archivo no es válido: {error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("No se pudo validar el archivo: {error}"))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("No se pudieron leer los metadatos: {error}"))?;
    if !metadata.is_file() {
        return Err("La selección no corresponde a un archivo".into());
    }
    let modified_unix = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());
    Ok(Some(FileMetadataSnapshot {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Archivo")
            .to_string(),
        path: path.to_string_lossy().to_string(),
        extension: path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase(),
        size_bytes: metadata.len(),
        modified_unix,
        readonly: metadata.permissions().readonly(),
    }))
}
pub(crate) fn clear_recent_files(
    state: State<'_, LocalState>,
) -> Result<QueueActionReceipt, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let affected = connection
        .execute("DELETE FROM recent_files", [])
        .map_err(|error| error.to_string())?;
    Ok(QueueActionReceipt {
        affected,
        action: "recent_files_cleared".into(),
    })
}
pub(crate) fn clear_finished_jobs(
    state: State<'_, LocalState>,
) -> Result<QueueActionReceipt, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let affected = connection
        .execute(
            "DELETE FROM jobs WHERE status IN ('completed','cancelled','failed')",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(QueueActionReceipt {
        affected,
        action: "finished_jobs_cleared".into(),
    })
}
pub(crate) fn discover_page_downloads(
    url: String,
    limit: Option<usize>,
) -> Result<PageDownloadDiscovery, String> {
    reject_spotify_source(&url)?;
    let requested = parse_public_http_url(&url, "La página no es válida")?;
    ensure_public_network_resolution(&requested)?;
    let client = Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        )
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(35))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("La página superó el límite de redirecciones");
            }
            if url_has_public_network_target(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("La redirección apunta a una dirección local o privada")
            }
        }))
        .build()
        .map_err(|error| format!("No se pudo preparar el explorador: {error}"))?;
    let response = client
        .get(requested)
        .send()
        .map_err(|error| format!("No se pudo abrir la página: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("La página respondió {}", response.status()));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") {
        return Err(
            "El enlace no devolvió una página HTML. Puedes añadirlo como descarga directa".into(),
        );
    }
    let final_url = response.url().clone();
    if !url_has_public_http_target(&final_url) {
        return Err("La página terminó en una dirección local o privada no permitida".into());
    }
    const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
    let mut body = Vec::with_capacity(256 * 1024);
    response
        .take((MAX_PAGE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| format!("No se pudo leer la página: {error}"))?;
    let page_truncated = body.len() > MAX_PAGE_BYTES;
    body.truncate(MAX_PAGE_BYTES);
    let inspected_bytes = body.len();
    let html = String::from_utf8_lossy(&body);
    let page_title = html_page_title(&html);
    let requested_limit = limit.unwrap_or(120).clamp(1, 250);
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for attribute in ["href", "src", "data-src", "data-href"] {
        for raw in html_attribute_values(&html, attribute) {
            if raw.is_empty()
                || raw.starts_with('#')
                || raw.starts_with("javascript:")
                || raw.starts_with("data:")
                || raw.starts_with("blob:")
                || raw.starts_with("mailto:")
            {
                continue;
            }
            let Ok(mut parsed) = final_url.join(&raw) else {
                continue;
            };
            parsed.set_fragment(None);
            if !url_has_public_http_target(&parsed) {
                continue;
            }
            let normalized = parsed.to_string();
            if !seen.insert(normalized.clone()) {
                continue;
            }
            let Some((extension, kind, confidence)) = page_candidate_score(&parsed, attribute)
            else {
                continue;
            };
            let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
            let same_origin = final_url.host_str().is_some_and(|page_host| {
                page_host.eq_ignore_ascii_case(parsed.host_str().unwrap_or_default())
            });
            candidates.push(PageDownloadCandidate {
                filename: filename_from_url(&parsed, None),
                url: normalized,
                extension,
                kind,
                host,
                source_attribute: attribute.to_string(),
                embedded: attribute != "href" && attribute != "data-href",
                same_origin,
                confidence: confidence.saturating_sub(if same_origin { 0 } else { 4 }),
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .confidence
            .cmp(&left.confidence)
            .then_with(|| right.same_origin.cmp(&left.same_origin))
            .then_with(|| {
                left.filename
                    .to_ascii_lowercase()
                    .cmp(&right.filename.to_ascii_lowercase())
            })
    });
    let candidates_truncated = candidates.len() > requested_limit;
    candidates.truncate(requested_limit);
    Ok(PageDownloadDiscovery {
        page_url: final_url.to_string(),
        page_title,
        candidates,
        truncated: page_truncated || candidates_truncated,
        inspected_bytes,
    })
}
pub(crate) fn inspect_download_url(url: String) -> Result<DownloadUrlInspection, String> {
    reject_spotify_source(&url)?;
    let parsed = parse_public_http_url(&url, "El enlace no es válido")?;

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = parsed.path().to_ascii_lowercase();
    let query = parsed.query().unwrap_or_default().to_ascii_lowercase();
    let playlist = query.contains("list=") || path.contains("playlist") || path.contains("album");
    let media_host = [
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
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    let direct_extensions = [
        ".zip",
        ".7z",
        ".rar",
        ".exe",
        ".msi",
        ".iso",
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".txt",
        ".csv",
        ".tsv",
        ".json",
        ".xml",
        ".html",
        ".htm",
        ".md",
        ".rtf",
        ".odt",
        ".ods",
        ".odp",
        ".epub",
        ".mobi",
        ".srt",
        ".vtt",
        ".ass",
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".mp3",
        ".m4a",
        ".wav",
        ".flac",
        ".mp4",
        ".mkv",
        ".webm",
        ".mov",
        ".avi",
        ".apk",
        ".msix",
        ".appx",
        ".appxbundle",
        ".cab",
        ".jar",
        ".torrent",
        ".tar",
        ".gz",
        ".bz2",
        ".xz",
        ".zst",
        ".img",
        ".vhd",
        ".vhdx",
        ".dmg",
        ".deb",
        ".rpm",
    ];
    let direct_by_extension = direct_extensions
        .iter()
        .any(|extension| path.ends_with(extension));
    let direct_request_hint = direct_by_extension
        || [
            "format=pdf",
            "format=doc",
            "format=docx",
            "format=xls",
            "format=xlsx",
            "format=ppt",
            "format=pptx",
            "download=1",
            "attachment=1",
        ]
        .iter()
        .any(|marker| query.contains(marker));
    let request_url = canonical_google_docs_export_url(&parsed).unwrap_or_else(|| parsed.clone());
    let probe = if !media_host && !playlist {
        match remote_download_probe(&request_url) {
            Ok(value) => Some(value),
            // A direct URL remains queueable when a provider rejects HEAD or
            // byte-range inspection.  The transfer worker performs the
            // authoritative response/type/size validation without blocking
            // the user at the preparation screen.
            Err(_) if direct_request_hint => None,
            Err(_) => None,
        }
    } else {
        None
    };
    let normalized_url = probe
        .as_ref()
        .map(|value| value.final_url.clone())
        .unwrap_or_else(|| request_url.clone());
    let content_type = probe.as_ref().and_then(|value| value.content_type.clone());
    let content_length = probe.as_ref().and_then(|value| value.content_length);
    let content_type_is_html = content_type
        .as_deref()
        .map(|value| {
            let lower = value.to_ascii_lowercase();
            lower.contains("text/html") || lower.contains("application/xhtml")
        })
        .unwrap_or(false);
    let suggested_filename = probe
        .as_ref()
        .map(|value| {
            resolve_download_filename(
                &parsed,
                &value.final_url,
                None,
                value.content_disposition.as_deref(),
                value.content_type.as_deref(),
            )
        })
        .unwrap_or_else(|| filename_from_url(&parsed, None));
    let direct_by_probe = probe.is_some()
        && !content_type_is_html
        && (filename_extension(&suggested_filename).is_some() || content_type.is_some());
    let direct = !content_type_is_html && (direct_request_hint || direct_by_probe);
    let kind = if playlist {
        "playlist"
    } else if media_host {
        "media"
    } else if content_type_is_html && direct_request_hint {
        "html_page"
    } else if direct {
        "direct_file"
    } else {
        "generic_url"
    };

    Ok(DownloadUrlInspection {
        normalized_url: normalized_url.to_string(),
        kind: kind.into(),
        host: normalized_url.host_str().unwrap_or(&host).to_string(),
        suggested_filename,
        content_type,
        content_length,
        requires_media_resolver: media_host || playlist,
    })
}
pub(crate) fn create_download_schedule(
    job_id: Option<i64>,
    action: String,
    run_at: String,
    repeat_daily: bool,
    state: State<'_, LocalState>,
) -> Result<DownloadScheduleSnapshot, String> {
    let action = validate_schedule_action(action.trim())?;
    let run_at = normalize_schedule_time(&run_at)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    if let Some(job_id) = job_id {
        let exists = connection
            .query_row("SELECT 1 FROM jobs WHERE id=?1", params![job_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if !exists {
            return Err("La descarga seleccionada ya no existe".into());
        }
        if action == "resume" && job_uses_disabled_spotify(&connection, job_id)? {
            return Err(spotify_disabled_error());
        }
    }
    connection
        .execute(
            "INSERT INTO download_schedules(job_id,action,run_at,repeat_daily,enabled,updated_at) VALUES(?1,?2,?3,?4,1,CURRENT_TIMESTAMP)",
            params![job_id, action, run_at, if repeat_daily { 1 } else { 0 }],
        )
        .map_err(|error| error.to_string())?;
    read_schedule(&connection, connection.last_insert_rowid())
}
pub(crate) fn list_download_schedules(
    state: State<'_, LocalState>,
) -> Result<Vec<DownloadScheduleSnapshot>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id,job_id,action,run_at,repeat_daily,enabled,last_run_at FROM download_schedules WHERE enabled=1 ORDER BY datetime(run_at) ASC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(DownloadScheduleSnapshot {
                id: row.get(0)?,
                job_id: row.get(1)?,
                action: row.get(2)?,
                run_at: row.get(3)?,
                repeat_daily: row.get::<_, i64>(4)? != 0,
                enabled: row.get::<_, i64>(5)? != 0,
                last_run_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.flatten().collect())
}
pub(crate) fn delete_download_schedule(
    schedule_id: i64,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let affected = connection
        .execute(
            "DELETE FROM download_schedules WHERE id=?1",
            params![schedule_id],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("La tarea programada ya no existe".into());
    }
    Ok(())
}
