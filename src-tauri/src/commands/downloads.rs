use crate::*;
use tauri::Emitter;

#[tauri::command]
pub(crate) fn download_activity_snapshot(
    state: State<'_, LocalState>,
) -> Result<DownloadActivitySnapshot, String> {
    crate::downloads::download_activity_snapshot(state)
}

#[tauri::command]
pub(crate) fn progress_v2_full_snapshot() -> crate::progress::coordinator::ProgressV2FullSnapshot {
    crate::progress::coordinator::full_snapshot()
}

#[tauri::command]
pub(crate) fn progress_engine_status() -> serde_json::Value {
    crate::progress::coordinator::status()
}

#[tauri::command]
pub(crate) fn progress_engine_diagnostics() -> serde_json::Value {
    crate::progress::diagnostics::snapshot()
}

#[tauri::command]
pub(crate) fn progress_v2_debug_report(job_id: i64) -> serde_json::Value {
    crate::progress::adapter::debug_report(job_id)
}

#[tauri::command]
pub(crate) fn progress_acceptance_config() -> serde_json::Value {
    let enabled = cfg!(debug_assertions)
        && std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE")
            .map(|value| value.trim() == "1")
            .unwrap_or(false);
    serde_json::json!({
        "enabled": enabled,
        "fixtureUrl": if enabled { std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE_URL").ok() } else { None },
        "reportPath": if enabled { std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE_REPORT").ok() } else { None }
    })
}

#[tauri::command]
pub(crate) fn progress_acceptance_report(report: serde_json::Value) -> Result<(), String> {
    if !(cfg!(debug_assertions)
        && std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE")
            .map(|value| value.trim() == "1")
            .unwrap_or(false))
    {
        return Ok(());
    }
    let path = std::env::var("CACATOOLS_PROGRESS_ACCEPTANCE_REPORT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("cacatools-progress-acceptance.json"));
    let payload = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    std::fs::write(path, payload).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn desktop_snapshot(state: State<'_, LocalState>) -> Result<DesktopSnapshot, String> {
    crate::downloads::desktop_snapshot(state)
}

#[tauri::command]
pub(crate) fn desktop_settings(
    state: State<'_, LocalState>,
) -> Result<DesktopSettingsSnapshot, String> {
    crate::downloads::desktop_settings(state)
}

#[tauri::command]
pub(crate) async fn choose_download_directory(
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Option<String>, String> {
    crate::downloads::choose_download_directory(app, state).await
}

#[tauri::command]
pub(crate) fn open_download_directory(
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    crate::downloads::open_download_directory(app, state)
}

#[tauri::command]
pub(crate) fn reveal_local_file(path: String, app: AppHandle) -> Result<(), String> {
    crate::downloads::reveal_local_file(path, app)
}

#[tauri::command]
pub(crate) async fn queue_http_download(
    url: String,
    filename: Option<String>,
    extension_filename: Option<String>,
    extension_mime: Option<String>,
    extension_expected_extension: Option<String>,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<DownloadQueueReceipt, String> {
    let receipt = crate::downloads::queue_http_download(
        url,
        filename,
        extension_filename,
        extension_mime,
        extension_expected_extension,
        state,
    )
    .await?;
    let _ = app.emit(
        "download-queued",
        serde_json::json!({ "job_id": receipt.job_id, "kind": "http" }),
    );
    Ok(receipt)
}

#[tauri::command]
pub(crate) async fn accept_browser_download_capture(
    request_id: String,
    capture: Value,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Value, String> {
    crate::downloads::accept_browser_download_capture(request_id, capture, app, state).await
}

#[tauri::command]
pub(crate) fn set_job_status(
    id: i64,
    status: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let result = crate::downloads::set_job_status(id, status.clone(), state);
    if result.is_ok() {
        let _ = app.emit(
            "download-state-changed",
            serde_json::json!({ "job_id": id, "status": status }),
        );
    }
    result
}

#[tauri::command]
pub(crate) fn set_download_priority(
    targets: Vec<DownloadPriorityTarget>,
    priority: DownloadPriority,
    state: State<'_, LocalState>,
) -> Result<DownloadPriorityReceipt, String> {
    crate::priority::set_download_priority(targets, priority, state)
}

#[tauri::command]
pub(crate) fn job_storage_preview(
    id: i64,
    state: State<'_, LocalState>,
) -> Result<JobStoragePreview, String> {
    crate::downloads::job_storage_preview(id, state)
}

#[tauri::command]
pub(crate) fn rename_completed_download(
    id: i64,
    new_name: String,
    state: State<'_, LocalState>,
) -> Result<String, String> {
    crate::downloads::rename_completed_download(id, new_name, state)
}

#[tauri::command]
pub(crate) fn emergency_stop_job(
    id: i64,
    delete_partial: bool,
    state: State<'_, LocalState>,
) -> Result<CancelJobReceipt, String> {
    crate::downloads::emergency_stop_job(id, delete_partial, state)
}

#[tauri::command]
pub(crate) fn cancel_download_job(
    id: i64,
    delete_partial: bool,
    state: State<'_, LocalState>,
) -> Result<CancelJobReceipt, String> {
    crate::downloads::cancel_download_job(id, delete_partial, state)
}

#[tauri::command]
pub(crate) fn delete_download_job(
    id: i64,
    delete_storage: bool,
    state: State<'_, LocalState>,
) -> Result<DeleteJobReceipt, String> {
    crate::downloads::delete_download_job(id, delete_storage, state)
}

#[tauri::command]
pub(crate) fn delete_playlist_batch(
    batch_id: i64,
    delete_storage: bool,
    state: State<'_, LocalState>,
) -> Result<DeletePlaylistReceipt, String> {
    crate::downloads::delete_playlist_batch(batch_id, delete_storage, state)
}

#[tauri::command]
pub(crate) fn choose_local_file(
    kind: String,
    category: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<Option<String>, String> {
    crate::downloads::choose_local_file(kind, category, app, state)
}

#[tauri::command]
pub(crate) fn open_local_file(path: String, app: AppHandle) -> Result<(), String> {
    crate::downloads::open_local_file(path, app)
}

#[tauri::command]
pub(crate) fn record_recent_file(
    path: String,
    category: String,
    kind: String,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    crate::downloads::record_recent_file(path, category, kind, state)
}

#[tauri::command]
pub(crate) fn open_external_url(url: String, app: AppHandle) -> Result<(), String> {
    crate::downloads::open_external_url(url, app)
}

#[tauri::command]
pub(crate) fn choose_file_metadata(app: AppHandle) -> Result<Option<FileMetadataSnapshot>, String> {
    crate::downloads::choose_file_metadata(app)
}

#[tauri::command]
pub(crate) fn clear_recent_files(
    state: State<'_, LocalState>,
) -> Result<QueueActionReceipt, String> {
    crate::downloads::clear_recent_files(state)
}

#[tauri::command]
pub(crate) fn clear_finished_jobs(
    state: State<'_, LocalState>,
) -> Result<QueueActionReceipt, String> {
    crate::downloads::clear_finished_jobs(state)
}

#[tauri::command]
pub(crate) fn discover_page_downloads(
    url: String,
    limit: Option<usize>,
) -> Result<PageDownloadDiscovery, String> {
    crate::downloads::discover_page_downloads(url, limit)
}

#[tauri::command]
pub(crate) async fn inspect_download_url(url: String) -> Result<DownloadUrlInspection, String> {
    tauri::async_runtime::spawn_blocking(move || crate::downloads::inspect_download_url(url))
        .await
        .map_err(|error| format!("La inspección HTTP terminó de forma inesperada: {error}"))?
}

#[tauri::command]
pub(crate) fn create_download_schedule(
    job_id: Option<i64>,
    action: String,
    run_at: String,
    repeat_daily: bool,
    state: State<'_, LocalState>,
) -> Result<DownloadScheduleSnapshot, String> {
    crate::downloads::create_download_schedule(job_id, action, run_at, repeat_daily, state)
}

#[tauri::command]
pub(crate) fn list_download_schedules(
    state: State<'_, LocalState>,
) -> Result<Vec<DownloadScheduleSnapshot>, String> {
    crate::downloads::list_download_schedules(state)
}

#[tauri::command]
pub(crate) fn delete_download_schedule(
    schedule_id: i64,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    crate::downloads::delete_download_schedule(schedule_id, state)
}
