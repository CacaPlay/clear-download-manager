use crate::*;
use tauri::Emitter;

fn emit_download_queued(app: &AppHandle, receipt: &MediaQueueReceipt, kind: &str) {
    let _ = app.emit(
        "download-queued",
        serde_json::json!({ "job_id": receipt.job_id, "kind": kind }),
    );
}

#[tauri::command]
pub(crate) async fn analyze_media_url(
    url: String,
    app: AppHandle,
) -> Result<MediaAnalysisSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || crate::media::analyze_media_url(url, app))
        .await
        .map_err(|error| format!("El análisis multimedia terminó de forma inesperada: {error}"))?
}

#[tauri::command]
pub(crate) fn choose_media_cookies_file(app: AppHandle) -> Result<Option<String>, String> {
    crate::media::choose_media_cookies_file(app)
}

#[tauri::command]
pub(crate) fn media_session_settings(
    state: State<'_, LocalState>,
) -> Result<MediaSessionSettingsSnapshot, String> {
    crate::media::media_session_settings(state)
}

#[tauri::command]
pub(crate) fn save_media_session_settings(
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    state: State<'_, LocalState>,
) -> Result<MediaSessionSettingsSnapshot, String> {
    crate::media::save_media_session_settings(use_brave_cookies, cookies_path, state)
}

#[tauri::command]
pub(crate) async fn analyze_media_url_with_session(
    url: String,
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    app: AppHandle,
) -> Result<MediaAnalysisSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::analyze_media_url_with_session(url, use_brave_cookies, cookies_path, app)
    })
    .await
    .map_err(|error| format!("El análisis multimedia terminó de forma inesperada: {error}"))?
}

#[tauri::command]
pub(crate) async fn analyze_media_url_with_session_for_window(
    url: String,
    use_brave_cookies: bool,
    cookies_path: Option<String>,
    window_label: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<MediaAnalysisSnapshot, String> {
    let label = window_label.trim().to_string();
    let operation = current_window_operation(&state.preparation_operations, &label)
        .ok_or_else(|| "La operación de preparación ya no está activa".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::analyze_media_url_with_session_for_window(
            url,
            use_brave_cookies,
            cookies_path,
            app,
            operation.clone(),
        )
    })
    .await
    .map_err(|error| format!("El análisis multimedia terminó de forma inesperada: {error}"))?
}

#[tauri::command]
pub(crate) async fn search_video_suggestions(
    query: String,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<Vec<MediaSearchResult>, String> {
    crate::media::search_video_suggestions(query, limit, app).await
}

#[tauri::command]
pub(crate) async fn search_video_suggestions_page(
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
    app: AppHandle,
) -> Result<Vec<MediaSearchResult>, String> {
    crate::media::search_video_suggestions_page(query, limit, offset, app).await
}

#[tauri::command]
pub(crate) async fn search_media_by_title(
    query: String,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<Vec<MediaSearchResult>, String> {
    crate::media::search_media_by_title(query, limit, app).await
}

#[tauri::command]
pub(crate) async fn search_media_by_title_page(
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
    app: AppHandle,
) -> Result<Vec<MediaSearchResult>, String> {
    crate::media::search_media_by_title_page(query, limit, offset, app).await
}

#[tauri::command]
pub(crate) fn recover_media_source(
    request: MediaRecoveryRequest,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<MediaRecoverySnapshot, String> {
    crate::media::recover_media_source(request, app, state)
}

#[tauri::command]
pub(crate) fn media_runtime_status(state: State<'_, LocalState>) -> MediaRuntimeSnapshot {
    crate::media::media_runtime_status(state)
}

#[tauri::command]
pub(crate) async fn player_media_snapshot(
    job_id: i64,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<PlayerMediaSnapshot, String> {
    crate::media::player_media_snapshot(job_id, app, state).await
}

#[tauri::command]
pub(crate) fn player_playlist_queue_snapshot(
    batch_id: i64,
    state: State<'_, LocalState>,
) -> Result<PlayerPlaylistQueueSnapshot, String> {
    crate::media::player_playlist_queue_snapshot(batch_id, state)
}

#[tauri::command]
pub(crate) async fn player_online_preview_snapshot(
    url: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<PlayerOnlinePreviewSnapshot, String> {
    let operation = current_window_operation(&state.preparation_operations, "player")
        .ok_or_else(|| "La preparación del reproductor ya no está activa".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::player_online_preview_snapshot_with_operation(
            url,
            app,
            Some(operation.clone()),
        )
    })
    .await
    .map_err(|error| format!("La vista previa terminó de forma inesperada: {error}"))?
}

#[tauri::command]
pub(crate) fn resolve_online_embed(url: String) -> Result<PlayerOnlineEmbedSnapshot, String> {
    crate::media::resolve_online_embed(url)
}

#[tauri::command]
pub(crate) async fn open_online_media_player(url: String, app: AppHandle) -> Result<(), String> {
    crate::media::open_online_media_player(url, app).await
}

#[tauri::command]
pub(crate) async fn player_resize_for_media(
    width: f64,
    height: f64,
    kind: String,
    details_open: bool,
    app: AppHandle,
) -> Result<(), String> {
    crate::media::player_resize_for_media(width, height, kind, details_open, app).await
}

#[tauri::command]
pub(crate) async fn open_media_player(job_id: i64, app: AppHandle) -> Result<(), String> {
    crate::media::open_media_player(job_id, app).await
}

#[tauri::command]
pub(crate) async fn open_playlist_media_player(
    batch_id: i64,
    app: AppHandle,
) -> Result<(), String> {
    crate::media::open_playlist_media_player(batch_id, app).await
}

#[tauri::command]
pub(crate) async fn player_start_dragging(app: AppHandle) -> Result<(), String> {
    crate::media::player_start_dragging(app).await
}

#[tauri::command]
pub(crate) async fn player_window_action(action: String, app: AppHandle) -> Result<(), String> {
    crate::media::player_window_action(action, app).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn queue_media_download(
    url: String,
    title: String,
    thumbnail: Option<String>,
    format_selector: String,
    output_mode: String,
    expected_duration_seconds: Option<f64>,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    let receipt = crate::media::queue_media_download(
        url,
        title,
        thumbnail,
        format_selector,
        output_mode,
        expected_duration_seconds,
        state,
    )?;
    emit_download_queued(&app, &receipt, "media");
    Ok(receipt)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn queue_media_download_named(
    url: String,
    title: String,
    thumbnail: Option<String>,
    format_selector: String,
    output_mode: String,
    expected_duration_seconds: Option<f64>,
    filename: Option<String>,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    let receipt = crate::media::queue_media_download_named(
        url,
        title,
        thumbnail,
        format_selector,
        output_mode,
        expected_duration_seconds,
        filename,
        state,
    )?;
    emit_download_queued(&app, &receipt, "media");
    Ok(receipt)
}

#[tauri::command]
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
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<MediaQueueReceipt, String> {
    let receipt = crate::media::queue_media_download_secure(
        url,
        title,
        thumbnail,
        format_selector,
        output_mode,
        expected_duration_seconds,
        filename,
        use_brave_cookies,
        cookies_path,
        state,
    )?;
    emit_download_queued(&app, &receipt, "media");
    Ok(receipt)
}

#[tauri::command]
pub(crate) fn queue_playlist_selection(
    playlist_title: String,
    items: Vec<PlaylistSelectionInput>,
    format: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<PlaylistQueueReceipt, String> {
    crate::media::queue_playlist_selection(playlist_title, items, format, app, state)
}

#[tauri::command]
pub(crate) fn set_playlist_batch_paused(
    batch_id: i64,
    paused: bool,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    crate::media::set_playlist_batch_paused(batch_id, paused, state)
}

#[tauri::command]
pub(crate) fn retry_failed_playlist_items(
    batch_id: i64,
    state: State<'_, LocalState>,
) -> Result<usize, String> {
    crate::media::retry_failed_playlist_items(batch_id, state)
}

#[tauri::command]
pub(crate) fn playlist_runtime_snapshot(
    batch_id: i64,
    state: State<'_, LocalState>,
) -> Result<PlaylistRuntimeSnapshot, String> {
    crate::media::playlist_runtime_snapshot(batch_id, state)
}

#[tauri::command]
pub(crate) fn replace_playlist_item_with_alternative(
    input: PlaylistAlternativeInput,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    crate::media::replace_playlist_item_with_alternative(input, state)
}
